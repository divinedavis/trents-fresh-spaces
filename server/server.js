'use strict';
// Load .env if present (no hard dependency on dotenv).
try {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
} catch (_) {}

const crypto = require('crypto');
const express = require('express');
const { DateTime } = require('luxon');
const config = require('./config');
const { stmts } = require('./db');
const { generateSlots, validateBooking, serviceOrThrow } = require('./availability');
const calendar = require('./calendar');
const { runSetup, validateSetupToken } = require('./setup');

const app = express();
app.disable('x-powered-by');

// Escape user-controlled values before interpolating them into any HTML output,
// to prevent stored XSS (booking fields are accepted verbatim and rendered later).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Baseline security response headers (no helmet dependency present; a small
// middleware keeps the footprint minimal).
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// --- tiny in-memory rate limiter for the booking endpoint ---
const hits = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, reset: now + windowMs };
  if (now > rec.reset) {
    rec.count = 0;
    rec.reset = now + windowMs;
  }
  rec.count += 1;
  hits.set(ip, rec);
  return rec.count <= max;
}

function dbBusyInRange(startMs, endMs) {
  const rows = stmts.inRange.all({
    start: DateTime.fromMillis(startMs, { zone: 'utc' }).toISO(),
    end: DateTime.fromMillis(endMs, { zone: 'utc' }).toISO(),
  });
  return rows.map((r) => {
    const svc = config.servicesById[r.service];
    const bufMs = ((svc && svc.bufferMin) || 0) * 60000; // pad by the booked service's buffer
    return {
      start: DateTime.fromISO(r.start_utc, { zone: 'utc' }).toMillis() - bufMs,
      end: DateTime.fromISO(r.end_utc, { zone: 'utc' }).toMillis() + bufMs,
    };
  });
}

async function busyForDay(dateISO) {
  const tz = config.timezone;
  const dayStart = DateTime.fromISO(dateISO, { zone: tz }).startOf('day');
  const startMs = dayStart.minus({ days: 1 }).toMillis();
  const endMs = dayStart.plus({ days: 2 }).toMillis();
  const external = await calendar.getExternalBusy(startMs, endMs);
  return [...dbBusyInRange(startMs, endMs), ...external];
}

// --- routes ---
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'trents-fresh-spaces-booking' }));

app.get('/api/services', (_req, res) => {
  res.json({
    timezone: config.timezone,
    leadTimeHours: config.business.leadTimeHours,
    maxDaysAhead: config.business.maxDaysAhead,
    services: Object.values(config.services).map((s) => ({ id: s.id, label: s.label, durationMin: s.durationMin })),
  });
});

app.get('/api/availability', async (req, res) => {
  try {
    const { service, date } = req.query;
    serviceOrThrow(service);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const busy = await busyForDay(date);
    const slots = generateSlots(service, date, busy, Date.now());
    res.json({ date, service, timezone: config.timezone, slots });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/book', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (!rateLimit(ip, 8, 10 * 60000)) return res.status(429).json({ error: 'Too many requests, please try again later.' });

  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim();
    const email = String(b.email || '').trim();
    const address = String(b.address || '').trim();
    const notes = String(b.notes || '').trim().slice(0, 1000);
    const service = String(b.service || '').trim();
    const start = String(b.start || '').trim();

    const svc = serviceOrThrow(service);
    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please enter a valid phone number.' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (svc.id === 'estimate' && address.length < 5) return res.status(400).json({ error: 'Please enter the address for the estimate.' });

    const dateISO = DateTime.fromISO(start, { zone: 'utc' }).setZone(config.timezone).toFormat('yyyy-LL-dd');

    // Re-validate against freshest busy data and insert atomically.
    const booking = {
      uid: `${crypto.randomUUID()}@trentsfreshspaces.com`,
      service,
      name,
      email: email || null,
      phone,
      address: address || null,
      notes: notes || null,
      start_utc: null,
      end_utc: null,
      created_at: DateTime.utc().toISO(),
    };

    const busy = await busyForDay(dateISO);
    const v = validateBooking(service, start, busy, Date.now());
    if (!v.ok) return res.status(409).json({ error: v.reason });
    booking.start_utc = DateTime.fromISO(start, { zone: 'utc' }).toISO();
    booking.end_utc = v.end;

    // Final guard inside a transaction against a concurrent identical insert.
    const insertTxn = require('./db').db.transaction(() => {
      const conflict = stmts.overlapping.get({ start: booking.start_utc, end: booking.end_utc });
      if (conflict) {
        const e = new Error('That time was just booked');
        e.status = 409;
        throw e;
      }
      stmts.insert.run(booking);
    });
    insertTxn();

    // Side-effects (email invite + optional iCloud write). Don't fail the booking on these.
    let emailResult = { sent: false };
    try {
      emailResult = await calendar.sendBookingEmails(booking);
    } catch (err) {
      console.error('[book] email failed:', err.message);
    }
    calendar.icloudWriteback(booking).catch(() => {});

    const when = DateTime.fromISO(booking.start_utc, { zone: 'utc' }).setZone(config.timezone).toFormat("cccc, LLL d 'at' h:mm a");
    res.json({ ok: true, uid: booking.uid, when, service: svc.label, emailed: emailResult.sent });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Booking failed' });
  }
});

// --- admin (token-protected) ---
function requireAdmin(req, res) {
  const token = req.query.token || req.headers['x-admin-token'];
  if (!config.adminToken || token !== config.adminToken) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/bookings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = stmts.upcoming.all({ now: DateTime.utc().toISO() });
  res.json({
    count: rows.length,
    bookings: rows.map((r) => ({
      ...r,
      when_local: DateTime.fromISO(r.start_utc, { zone: 'utc' }).setZone(config.timezone).toFormat("ccc LLL d, h:mm a"),
    })),
  });
});

app.post('/api/admin/cancel', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const uid = String((req.body && req.body.uid) || req.query.uid || '');
  const existing = stmts.byUid.get(uid);
  if (!existing) return res.status(404).json({ error: 'not found' });
  stmts.cancel.run(uid);
  res.json({ ok: true, uid });
});

// --- Trent's booking management (signed, tokenless link from his alert email) ---
function manageHtml(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} — Trent's Fresh Spaces</title>
  <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f8fc;color:#10182a;margin:0;padding:40px 20px}
  .card{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6ebf3;border-radius:18px;box-shadow:0 18px 50px -20px rgba(10,26,51,.28);padding:32px}
  h1{font-size:1.4rem;margin:0 0 14px;color:#0a1a33}.row{margin:6px 0;color:#5a6678}.row b{color:#10182a}
  .btn{display:inline-block;margin-top:18px;padding:13px 24px;border-radius:999px;border:0;font-weight:700;font-size:1rem;cursor:pointer}
  .danger{background:#e0463a;color:#fff}.muted{color:#5a6678;font-size:.9rem;margin-top:16px}a{color:#1e6fe0}</style></head>
  <body><div class="card">${body}</div></body></html>`;
}

app.get('/booking/manage', (req, res) => {
  const uid = String(req.query.uid || '');
  const sig = String(req.query.sig || '');
  if (!calendar.verifyManageSig(uid, sig)) return res.status(403).send(manageHtml('Invalid link', '<h1>This link is invalid.</h1><p class="muted">Please use the link from your booking email.</p>'));
  const b = stmts.byUid.get(uid);
  if (!b) return res.status(404).send(manageHtml('Not found', '<h1>Booking not found.</h1>'));
  const svc = config.servicesById[b.service];
  const when = DateTime.fromISO(b.start_utc, { zone: 'utc' }).setZone(config.timezone).toFormat("cccc, LLL d 'at' h:mm a");
  if (b.status !== 'confirmed') {
    return res.send(manageHtml('Already cancelled', `<h1>This booking is already cancelled.</h1><div class="row"><b>${escapeHtml(b.name)}</b> — ${svc ? escapeHtml(svc.label) : ''} on ${escapeHtml(when)}</div>`));
  }
  res.send(
    manageHtml(
      'Manage booking',
      `<h1>Cancel this appointment?</h1>
       <div class="row"><b>${svc ? escapeHtml(svc.label) : 'Appointment'}</b></div>
       <div class="row">${escapeHtml(when)} (ET)</div>
       <div class="row">${escapeHtml(b.name)} · ${escapeHtml(b.phone)}${b.email ? ' · ' + escapeHtml(b.email) : ''}</div>
       ${b.address ? `<div class="row">${escapeHtml(b.address)}</div>` : ''}
       <form method="POST" action="/booking/cancel">
         <input type="hidden" name="uid" value="${escapeHtml(uid)}"><input type="hidden" name="sig" value="${escapeHtml(sig)}">
         <button class="btn danger" type="submit">Cancel &amp; notify the customer</button>
       </form>
       <p class="muted">The customer${b.email ? ' will be emailed' : ' has no email on file — please call them at ' + escapeHtml(b.phone)}, and this time will reopen on the site.</p>`
    )
  );
});

app.post('/booking/cancel', async (req, res) => {
  const uid = String((req.body && req.body.uid) || '');
  const sig = String((req.body && req.body.sig) || '');
  if (!calendar.verifyManageSig(uid, sig)) return res.status(403).send(manageHtml('Invalid link', '<h1>This link is invalid.</h1>'));
  const b = stmts.byUid.get(uid);
  if (!b) return res.status(404).send(manageHtml('Not found', '<h1>Booking not found.</h1>'));
  if (b.status === 'confirmed') {
    stmts.cancel.run(uid);
    calendar.invalidateBusyCache();
    calendar.sendCancellationEmail(b).catch((e) => console.error('[cancel] customer email failed:', e.message));
  }
  res.send(
    manageHtml(
      'Cancelled',
      `<h1>Done — booking cancelled.</h1>
       <p class="row">${b.email ? 'The customer has been emailed and asked to rebook.' : 'No email was on file — please call ' + escapeHtml(b.phone) + ' to let them know.'}</p>
       <p class="muted">That time is now open again on the site.</p>`
    )
  );
});

// --- one-time setup link (Trent connects his calendars/email) ---
app.post('/api/setup', async (req, res) => {
  // The setup token gates credential overwrite, so it is required ON the
  // credential-write request itself and is accepted ONLY from a header or the
  // POST body — never from req.query, so it can't leak via access logs, the
  // Referer header, or browser history. It is short-TTL + single-use (see
  // setup.js): it expires and is burned from .env after the first successful
  // connect, so the link can't be replayed.
  const p = req.body || {};
  const t = req.headers['x-setup-token'] || p.setupToken || p.t;
  const gate = validateSetupToken(t);
  if (!gate.ok) {
    return res.status(401).json({ error: 'This setup link is invalid, expired, or has already been used. Ask for a fresh one.' });
  }
  const hasEmail = p.gmailUser && p.gmailAppPassword;
  const hasGoogle = p.googleIcsUrl;
  const hasApple = p.appleId && p.appleAppPassword;
  if (!hasEmail && !hasGoogle && !hasApple) {
    return res.status(400).json({ error: 'Please fill in at least one section before submitting.' });
  }
  // Re-validate immediately before the credential-changing action so a token
  // that expired between the gate check and the write can't slip through.
  if (!validateSetupToken(t).ok) {
    return res.status(401).json({ error: 'This setup link is invalid, expired, or has already been used. Ask for a fresh one.' });
  }
  try {
    const result = await runSetup(p);
    res.json({ ok: true, checks: result.checks, connected: result.changed });
    // Only restart if something actually connected — then the new .env (SMTP +
    // feeds + iCloud) is picked up and the single-use SETUP_TOKEN is cleared.
    // A fully-failed attempt changes nothing and keeps the link alive for retry.
    if (result.changed) {
      calendar.invalidateBusyCache();
      setTimeout(() => process.exit(0), 800);
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'Setup failed' });
  }
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[trents-fresh-spaces-booking] listening on 127.0.0.1:${config.port} (tz ${config.timezone})`);
  console.log(`  feeds: ${config.icsFeeds.length} | smtp: ${config.smtp.host ? 'on' : 'off'} | icloud: ${config.icloud.username ? 'on' : 'off'}`);
});
