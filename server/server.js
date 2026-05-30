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
const { runSetup } = require('./setup');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

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
  return rows.map((r) => ({
    start: DateTime.fromISO(r.start_utc, { zone: 'utc' }).toMillis(),
    end: DateTime.fromISO(r.end_utc, { zone: 'utc' }).toMillis(),
  }));
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

// --- one-time setup link (Trent connects his calendars/email) ---
app.post('/api/setup', async (req, res) => {
  const t = req.query.t || req.headers['x-setup-token'];
  if (!process.env.SETUP_TOKEN || t !== process.env.SETUP_TOKEN) {
    return res.status(401).json({ error: 'This setup link is invalid or has already been used. Ask for a fresh one.' });
  }
  const p = req.body || {};
  const hasEmail = p.gmailUser && p.gmailAppPassword;
  const hasGoogle = p.googleIcsUrl;
  const hasApple = p.appleId && p.appleAppPassword;
  if (!hasEmail && !hasGoogle && !hasApple) {
    return res.status(400).json({ error: 'Please fill in at least one section before submitting.' });
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
