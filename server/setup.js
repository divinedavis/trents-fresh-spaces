'use strict';
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const ical = require('node-ical');
const { DateTime } = require('luxon');
const config = require('./config');

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

async function countEvents(url) {
  const data = await ical.async.fromURL(url);
  return Object.values(data).filter((e) => e && e.type === 'VEVENT').length;
}

// payload: { gmailUser, gmailAppPassword, googleIcsUrl, icloudIcsUrl }
async function runSetup(p) {
  const checks = [];

  // 1. Verify Gmail SMTP (App Password) by opening a real connection.
  const tx = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: p.gmailUser, pass: p.gmailAppPassword },
  });
  let smtpOk = false;
  try {
    await tx.verify();
    smtpOk = true;
    checks.push({ ok: true, label: `Email connected (${p.gmailUser})` });
  } catch (e) {
    checks.push({ ok: false, label: 'Email could not connect — check the 16-character App Password' });
  }

  // 2. Google calendar feed.
  if (p.googleIcsUrl) {
    try {
      const n = await countEvents(p.googleIcsUrl);
      checks.push({ ok: true, label: `Google Calendar connected (${n} events visible)` });
    } catch (e) {
      checks.push({ ok: false, label: 'Google calendar link could not be read — re-copy the "Secret address in iCal format"' });
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

  // Persist whatever was provided (even if a check warned — feeds may simply be empty).
  env.SMTP_HOST = 'smtp.gmail.com';
  env.SMTP_PORT = '587';
  env.SMTP_SECURE = 'false';
  env.SMTP_USER = p.gmailUser;
  env.SMTP_PASS = p.gmailAppPassword;
  env.FROM_EMAIL = p.gmailUser;
  const feeds = [p.googleIcsUrl].map((s) => (s || '').trim()).filter(Boolean);
  if (feeds.length) env.ICS_FEEDS = feeds.join(',');
  delete env.SETUP_TOKEN; // single-use: the link stops working after this
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

  return { checks };
}

module.exports = { runSetup };
