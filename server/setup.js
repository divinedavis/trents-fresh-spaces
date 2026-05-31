'use strict';
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const ical = require('node-ical');
const { DateTime } = require('luxon');
const config = require('./config');
const { safeFetchText } = require('./safeFetch');

const ENV_PATH = path.join(__dirname, '.env');

function readEnv() {
  const obj = {};
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) obj[m[1]] = m[2];
    }
  }
  return obj;
}

function writeEnv(obj) {
  const lines = Object.keys(obj).map((k) => `${k}=${obj[k]}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
}

// Fetch + validate an ICS feed. Returns event count, or throws a classified error.
// The fetch goes through safeFetchText(), which blocks SSRF: it rejects
// non-http(s) schemes and any URL whose host resolves to a private/loopback/
// link-local/reserved range (incl. the cloud metadata IP 169.254.169.254),
// re-validates every redirect hop, and caps the response size + time.
async function countEvents(rawUrl) {
  const url = (rawUrl || '').trim().replace(/^webcal:\/\//i, 'https://');
  let text;
  try {
    text = await safeFetchText(url, {
      headers: { 'User-Agent': 'TrentsFreshSpaces/1.0 (+https://trentsfreshspaces.com)' },
    });
  } catch (e) {
    const m = e.message || 'network';
    if (/^http-/.test(m)) throw new Error(m); // preserve HTTP status for the UI hint
    if (/blocked-address|bad-scheme|bad-url|dns-/.test(m)) throw new Error('blocked-url');
    throw new Error('fetch-failed:' + m);
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('not-ics');
  const parsed = ical.sync.parseICS(text);
  return Object.values(parsed).filter((e) => e && e.type === 'VEVENT').length;
}

// payload: { gmailUser, gmailAppPassword, googleIcsUrl, icloudIcsUrl }
async function runSetup(p) {
  const checks = [];

  // 1. Verify Gmail SMTP (App Password) by opening a real connection.
  //    Skipped entirely if email wasn't provided (e.g. a Step-2-only submit),
  //    so an already-connected email is left untouched.
  let tx = null;
  let smtpOk = false;
  if (p.gmailUser && p.gmailAppPassword) {
   tx = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: p.gmailUser, pass: p.gmailAppPassword },
  });
  try {
    await tx.verify();
    smtpOk = true;
    checks.push({ ok: true, label: `Email connected (${p.gmailUser})` });
  } catch (e) {
    const msg = (e && e.message) || '';
    let hint;
    if (/badcredentials|username and password not accepted|535/i.test(msg)) {
      hint = 'Gmail rejected the login. Turn ON 2-Step Verification first, then paste a 16-character App Password (myaccount.google.com/apppasswords) — not your normal Gmail password.';
    } else if (/getaddrinfo|enotfound|etimedout|econn/i.test(msg)) {
      hint = 'Could not reach Gmail’s mail server — please try again in a minute.';
    } else {
      hint = 'Email could not connect — check the address and 16-character App Password. (' + msg.slice(0, 80) + ')';
    }
    checks.push({ ok: false, label: hint });
  }
  }

  // 2. Google calendar feed.
  let googleOk = false;
  if (p.googleIcsUrl) {
    try {
      const n = await countEvents(p.googleIcsUrl);
      googleOk = true;
      checks.push({ ok: true, label: `Google Calendar connected (${n} events visible)` });
    } catch (e) {
      const code = e.message || '';
      let host = '?';
      try { host = new URL(p.googleIcsUrl.trim().replace(/^webcal:\/\//i, 'https://')).host; } catch (_) {}
      console.error(`[setup] google feed check failed: ${code} | host: ${host}`);
      let hint;
      if (/^http-404/.test(code)) hint = 'That calendar link returned "not found" — copy the "Secret address in iCal format" (it ends in /basic.ics); the Public address won\'t work for a private calendar.';
      else if (/not-ics/.test(code)) hint = 'That link isn\'t an iCal feed — use "Secret address in iCal format" (ends in /basic.ics), not "Public URL to this calendar" (that\'s a web page).';
      else if (/^http-/.test(code)) hint = `Google returned an error (${code.replace('http-', 'HTTP ')}) for that link — re-copy the "Secret address in iCal format".`;
      else if (/blocked-url/.test(code)) hint = 'That link isn\'t allowed — paste a public Google "Secret address in iCal format" URL (ends in /basic.ics). Internal or private addresses can\'t be used.';
      else if (/fetch-failed|abort/.test(code)) hint = 'Couldn\'t reach that calendar link — make sure the full URL was pasted, then try again.';
      else hint = 'Google calendar link could not be read — re-copy the "Secret address in iCal format".';
      checks.push({ ok: false, label: hint });
    }
  }

  // 3. Apple / iCloud via CalDAV (app-specific password). We verify the login,
  //    auto-discover the calendar to write bookings into, and read it for busy.
  const env = readEnv();
  let appleCalUrl = '';
  if ((p.appleId || '').trim() && (p.appleAppPassword || '').trim()) {
    try {
      const { createDAVClient } = require('tsdav');
      const client = await createDAVClient({
        serverUrl: 'https://caldav.icloud.com',
        credentials: { username: p.appleId.trim(), password: p.appleAppPassword.replace(/\s+/g, '') },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });
      const cals = await client.fetchCalendars();
      const writable = cals.filter((c) => !c.components || c.components.includes('VEVENT'));
      const pick =
        writable.find((c) => /home|personal|calendar/i.test(c.displayName || '')) || writable[0];
      if (pick) {
        appleCalUrl = pick.url;
        env.ICLOUD_USERNAME = p.appleId.trim();
        env.ICLOUD_APP_PASSWORD = p.appleAppPassword.replace(/\s+/g, '');
        env.ICLOUD_CALENDAR_URL = pick.url;
        checks.push({ ok: true, label: `Apple Calendar connected — bookings will save to "${pick.displayName || 'your calendar'}"` });
      } else {
        checks.push({ ok: false, label: 'Apple login worked but no writable calendar was found' });
      }
    } catch (e) {
      checks.push({ ok: false, label: 'Apple login failed — check the Apple ID and app-specific password' });
    }
  }

  // Persist ONLY the parts that verified successfully — never save credentials
  // Gmail/Apple rejected, and never overwrite a working setting with a broken one.
  if (smtpOk) {
    env.SMTP_HOST = 'smtp.gmail.com';
    env.SMTP_PORT = '587';
    env.SMTP_SECURE = 'false';
    env.SMTP_USER = p.gmailUser;
    env.SMTP_PASS = p.gmailAppPassword;
    env.FROM_EMAIL = p.gmailUser;
  }
  if (googleOk) env.ICS_FEEDS = p.googleIcsUrl.trim();
  const feeds = (env.ICS_FEEDS || '').split(',').filter(Boolean);

  // Reusable link: the SETUP_TOKEN persists so Trent can return to the same
  // link anytime to update his email or calendar. (Rotate it manually in .env
  // if it ever needs revoking.)
  const anySuccess = smtpOk || googleOk || !!appleCalUrl;
  writeEnv(env);

  // Notify the site owner (no secrets in the body).
  if (smtpOk) {
    try {
      await tx.sendMail({
        from: `Fresh Spaces Setup <${p.gmailUser}>`,
        to: 'divinejdavis@gmail.com',
        subject: 'Trent connected his calendar — Fresh Spaces booking sync is live',
        text:
          'Trent completed the booking/calendar setup at ' +
          DateTime.utc().setZone(config.timezone).toFormat('ccc LLL d, h:mm a ZZZZ') +
          '.\n\nResults:\n' +
          checks.map((c) => (c.ok ? '  [OK]   ' : '  [WARN] ') + c.label).join('\n') +
          '\n\nFeeds configured: ' + feeds.length,
      });
    } catch (e) {
      /* non-fatal */
    }
  }

  return { checks, changed: anySuccess };
}

module.exports = { runSetup };
