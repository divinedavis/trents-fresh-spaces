'use strict';
// SSRF egress guard for server-side fetches of user-supplied URLs (calendar/ICS
// feeds). Legit users add arbitrary EXTERNAL feeds, so a host allowlist is wrong
// here — instead we resolve the hostname and refuse any address that lands in a
// private / loopback / link-local / reserved range (including the cloud metadata
// endpoint 169.254.169.254). Redirects are NOT auto-followed; every hop is
// re-resolved and re-validated, a tight timeout is applied, and the response
// body is size-capped.
const dns = require('dns').promises;
const net = require('net');

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on the fetched feed

// --- private/reserved range detection ------------------------------------

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inV4Cidr(ipInt, base, maskBits) {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (ipv4ToInt(base) & mask);
}

// Returns true for any IPv4 address that must never be reachable from the server.
function isBlockedV4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → fail closed
  return (
    inV4Cidr(n, '0.0.0.0', 8) ||        // "this" network / unspecified
    inV4Cidr(n, '10.0.0.0', 8) ||       // private
    inV4Cidr(n, '127.0.0.0', 8) ||      // loopback
    inV4Cidr(n, '169.254.0.0', 16) ||   // link-local (incl. 169.254.169.254 metadata)
    inV4Cidr(n, '172.16.0.0', 12) ||    // private
    inV4Cidr(n, '192.168.0.0', 16) ||   // private
    inV4Cidr(n, '100.64.0.0', 10) ||    // CGNAT
    inV4Cidr(n, '192.0.0.0', 24) ||     // IETF protocol assignments
    inV4Cidr(n, '192.0.2.0', 24) ||     // TEST-NET-1
    inV4Cidr(n, '198.18.0.0', 15) ||    // benchmarking
    inV4Cidr(n, '198.51.100.0', 24) ||  // TEST-NET-2
    inV4Cidr(n, '203.0.113.0', 24) ||   // TEST-NET-3
    inV4Cidr(n, '224.0.0.0', 4) ||      // multicast
    inV4Cidr(n, '240.0.0.0', 4)         // reserved (incl. 255.255.255.255 broadcast)
  );
}

function isBlockedV6(ip) {
  const a = ip.toLowerCase().split('%')[0]; // strip zone id
  if (a === '::' || a === '::1') return true; // unspecified / loopback
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // fe80::/10 link-local
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // fc00::/7 unique-local
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible → validate the embedded v4.
  const m = a.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return isBlockedV4(m[1]);
  return false;
}

function isBlockedAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // not a recognizable IP literal → fail closed
}

// Resolve a hostname (or accept an IP literal) and throw if ANY resolved
// address is in a blocked range. Returns the list of safe resolved addresses.
async function assertSafeHost(hostname) {
  // URL.hostname keeps the brackets on IPv6 literals (e.g. "[::1]"); strip them
  // so net.isIP recognizes the literal and we validate it directly instead of
  // (mis)treating it as a DNS name.
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('blocked-address');
    return [host];
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error('dns-failed');
  }
  if (!records.length) throw new Error('dns-empty');
  for (const r of records) {
    if (isBlockedAddress(r.address)) throw new Error('blocked-address');
  }
  return records.map((r) => r.address);
}

// Validate a single URL: scheme must be http/https, and the host must not
// resolve into a blocked range. Throws on rejection.
async function assertSafeFetchTarget(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    throw new Error('bad-url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad-scheme');
  await assertSafeHost(u.hostname);
  return u;
}

// Boolean convenience wrapper.
async function isSafePublicUrl(rawUrl) {
  try {
    await assertSafeFetchTarget(rawUrl);
    return true;
  } catch (_) {
    return false;
  }
}

// SSRF-safe fetch: validates the target (and every redirect hop) against the
// egress guard, never auto-follows redirects, enforces a timeout, and caps the
// response size. Returns the response body as text.
async function safeFetchText(rawUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const headers = opts.headers || {};

  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeFetchTarget(current); // re-validate every hop (no internal redirect target)

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: ctrl.signal, headers });
    } finally {
      clearTimeout(timer);
    }

    // Handle redirects ourselves so an open redirect can't bounce us to an
    // internal target without re-validation.
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current).toString();
      if (hop === MAX_REDIRECTS) throw new Error('too-many-redirects');
      current = next;
      continue;
    }

    if (!res.ok) throw new Error('http-' + res.status);

    // Reject obviously-oversized bodies up front when Content-Length is present.
    const len = parseInt(res.headers.get('content-length') || '', 10);
    if (Number.isFinite(len) && len > maxBytes) throw new Error('too-large');

    // Stream-read with a hard byte cap (covers chunked/no-length responses).
    if (!res.body) return await res.text();
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error('too-large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  throw new Error('too-many-redirects');
}

module.exports = {
  assertSafeFetchTarget,
  assertSafeHost,
  isSafePublicUrl,
  isBlockedAddress,
  safeFetchText,
};
