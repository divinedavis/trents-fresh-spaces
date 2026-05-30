'use strict';
const crypto = require('crypto');
const ical = require('node-ical');
const { createEvent } = require('ics');
const nodemailer = require('nodemailer');
const { DateTime } = require('luxon');
const config = require('./config');

// Signed, tokenless management link for Trent's emails (so the link itself is
// the credential — no admin token exposed, and only a valid signature works).
function signUid(uid) {
  return crypto.createHmac('sha256', config.adminToken || 'fresh-spaces').update(uid).digest('hex').slice(0, 32);
}
function verifyManageSig(uid, sig) {
  const expected = signUid(uid);
  try {
    return !!sig && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}
function manageLink(uid) {
  return `${config.siteUrl}/booking/manage?uid=${encodeURIComponent(uid)}&sig=${signUid(uid)}`;
}

/* ---------------------------------------------------------------------------
 * 1. BUSY READING — pull Trent's calendar feeds (Google secret iCal / iCloud
 *    published cal) and turn every event into a [start,end) busy interval.
 *    Cached in-memory with a short TTL so manual calendar blocks surface fast.
 * ------------------------------------------------------------------------- */
let busyCache = { at: 0, intervals: [] };

function eventDurationMs(ev) {
  if (ev.end && ev.start) {
    const d = ev.end.getTime() - ev.start.getTime();
    if (d > 0) return d;
  }
  // All-day / no end → treat as a full day so the date is blocked.
  return 24 * 3600000;
}

function expandEvent(ev, rangeStart, rangeEnd, out) {
  if (!ev || ev.type !== 'VEVENT' || !ev.start) return;
  // Skip events the owner declined/cancelled.
  if (ev.status === 'CANCELLED') return;

  const durMs = eventDurationMs(ev);

  if (ev.rrule) {
    const exdates = ev.exdate
      ? Object.values(ev.exdate).map((d) => new Date(d).getTime())
      : [];
    let occurrences = [];
    try {
      occurrences = ev.rrule.between(rangeStart, rangeEnd, true);
    } catch (_) {
      occurrences = [];
    }
    for (const occ of occurrences) {
      const t = occ.getTime();
      if (exdates.includes(t)) continue;
      out.push({ start: t, end: t + durMs });
    }
    // Modified single instances of a recurring event.
    if (ev.recurrences) {
      for (const r of Object.values(ev.recurrences)) {
        if (r.start) out.push({ start: r.start.getTime(), end: r.start.getTime() + eventDurationMs(r) });
      }
    }
  } else {
    out.push({ start: ev.start.getTime(), end: ev.start.getTime() + durMs });
  }
}

async function fetchFeedBusy(rangeStartMs, rangeEndMs) {
  const rangeStart = new Date(rangeStartMs);
  const rangeEnd = new Date(rangeEndMs);
  const out = [];
  for (const url of config.icsFeeds) {
    try {
      const data = await ical.async.fromURL(url);
      for (const ev of Object.values(data)) expandEvent(ev, rangeStart, rangeEnd, out);
    } catch (err) {
      console.error(`[calendar] feed fetch failed: ${url} — ${err.message}`);
    }
  }
  // Keep only intervals intersecting the window.
  return out.filter((b) => b.end > rangeStartMs && b.start < rangeEndMs);
}

// iCloud busy via CalDAV (app-specific password). Reads every VEVENT calendar
// so Trent's Apple events block site slots in near real time.
async function fetchIcloudBusy(rangeStartMs, rangeEndMs) {
  if (!config.icloud.username || !config.icloud.appPassword) return [];
  const out = [];
  try {
    const { createDAVClient } = require('tsdav');
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: config.icloud.username, password: config.icloud.appPassword },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
    let cals = await client.fetchCalendars();
    cals = cals.filter((c) => !c.components || c.components.includes('VEVENT'));
    const start = new Date(rangeStartMs);
    const end = new Date(rangeEndMs);
    const startISO = start.toISOString();
    const endISO = end.toISOString();
    for (const cal of cals) {
      let objs = [];
      try {
        objs = await client.fetchCalendarObjects({ calendar: cal, timeRange: { start: startISO, end: endISO } });
      } catch (_) {
        objs = [];
      }
      for (const o of objs) {
        if (!o || !o.data) continue;
        const parsed = ical.sync.parseICS(o.data);
        for (const ev of Object.values(parsed)) expandEvent(ev, start, end, out);
      }
    }
  } catch (err) {
    console.error(`[calendar] iCloud busy fetch failed: ${err.message}`);
  }
  return out.filter((b) => b.end > rangeStartMs && b.start < rangeEndMs);
}

// Combined external busy (ICS feeds + iCloud CalDAV), cached together.
async function getExternalBusy(rangeStartMs, rangeEndMs) {
  const hasSources = config.icsFeeds.length || (config.icloud.username && config.icloud.appPassword);
  if (!hasSources) return [];
  const now = Date.now();
  if (now - busyCache.at < config.busyCacheTtlSec * 1000) return busyCache.intervals;
  const [feed, icloud] = await Promise.all([
    fetchFeedBusy(rangeStartMs, rangeEndMs),
    fetchIcloudBusy(rangeStartMs, rangeEndMs),
  ]);
  const intervals = [...feed, ...icloud];
  busyCache = { at: now, intervals };
  return intervals;
}

function invalidateBusyCache() {
  busyCache = { at: 0, intervals: [] };
}

/* ---------------------------------------------------------------------------
 * 2. INVITE WRITING — build an ICS (METHOD:REQUEST) and email it to Trent +
 *    the customer. Google and Apple both add REQUEST invites to the calendar.
 * ------------------------------------------------------------------------- */
function buildICS(booking) {
  const start = DateTime.fromISO(booking.start_utc, { zone: 'utc' });
  const svc = config.servicesById[booking.service];
  const durationMin = Math.round(
    (DateTime.fromISO(booking.end_utc, { zone: 'utc' }).toMillis() - start.toMillis()) / 60000
  );
  const isPhone = booking.service === 'consult';
  const title = `${svc ? svc.label : 'Appointment'} — ${booking.name}`;
  const descLines = [
    `${svc ? svc.label : 'Appointment'} for ${booking.name}`,
    `Phone: ${booking.phone}`,
    booking.email ? `Email: ${booking.email}` : null,
    booking.address ? `Address: ${booking.address}` : null,
    booking.notes ? `Notes: ${booking.notes}` : null,
    '',
    'Booked via trentsfreshspaces.com',
  ].filter((l) => l !== null);

  const attendees = [{ name: booking.name, email: booking.email || undefined, rsvp: true, role: 'REQ-PARTICIPANT', partstat: 'ACCEPTED' }];
  for (const oe of config.ownerEmails) {
    attendees.push({ name: config.ownerName, email: oe, rsvp: true, role: 'REQ-PARTICIPANT', partstat: 'NEEDS-ACTION' });
  }

  return new Promise((resolve, reject) => {
    createEvent(
      {
        uid: booking.uid,
        start: [start.year, start.month, start.day, start.hour, start.minute],
        startInputType: 'utc',
        startOutputType: 'utc',
        duration: { minutes: durationMin },
        title,
        description: descLines.join('\n'),
        location: isPhone ? `Phone call to ${booking.phone}` : booking.address || 'On-site (address provided by customer)',
        status: 'CONFIRMED',
        method: 'REQUEST',
        organizer: { name: config.business.name, email: config.fromEmail || config.ownerEmail },
        attendees,
        productId: 'trents-fresh-spaces/booking',
      },
      (err, value) => (err ? reject(err) : resolve(value))
    );
  });
}

function transport() {
  if (!config.smtp.host) return null;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

function fmtWhen(booking) {
  return DateTime.fromISO(booking.start_utc, { zone: 'utc' })
    .setZone(config.timezone)
    .toFormat("cccc, LLL d 'at' h:mm a");
}

async function sendBookingEmails(booking) {
  const tx = transport();
  if (!tx) {
    console.warn('[calendar] SMTP not configured — booking stored, no email sent.');
    return { sent: false, reason: 'smtp-not-configured' };
  }
  const svc = config.servicesById[booking.service];
  const when = fmtWhen(booking);
  const ics = await buildICS(booking);
  const icalEvent = { method: 'REQUEST', content: ics, filename: 'invite.ics' };
  const from = config.fromEmail || config.smtp.user;

  // To Trent (both addresses): new-booking alert + the invite to add to his calendar.
  await tx.sendMail({
    from: `${config.business.name} <${from}>`,
    to: config.ownerEmails.join(', '),
    subject: `New booking: ${svc ? svc.label : 'Appointment'} — ${booking.name} (${when})`,
    text:
      `New ${svc ? svc.label : 'appointment'} booked via trentsfreshspaces.com\n\n` +
      `When:    ${when}\n` +
      `Name:    ${booking.name}\n` +
      `Phone:   ${booking.phone}\n` +
      (booking.email ? `Email:   ${booking.email}\n` : '') +
      (booking.address ? `Address: ${booking.address}\n` : '') +
      (booking.notes ? `Notes:   ${booking.notes}\n` : '') +
      `\nThis event is attached — accept it to add it to your calendar.\n` +
      `\nCan't make it? Cancel and we'll email the customer automatically:\n${manageLink(booking.uid)}`,
    icalEvent,
  });

  // To customer: confirmation + the same invite.
  if (booking.email) {
    await tx.sendMail({
      from: `${config.business.name} <${from}>`,
      to: booking.email,
      subject: `You're booked with ${config.business.name} — ${when}`,
      text:
        `Hi ${booking.name},\n\n` +
        `Your ${svc ? svc.label.toLowerCase() : 'appointment'} with ${config.business.name} is confirmed for:\n\n` +
        `  ${when}\n\n` +
        (booking.service === 'consult'
          ? `Trent will call you at ${booking.phone}.\n`
          : `Trent will come to ${booking.address || 'your address'}.\n`) +
        `\nNeed to change it? Call or text (717) 882-1183.\n\n— ${config.business.name}`,
      icalEvent,
    });
  }
  return { sent: true };
}

// Tell the customer Trent had to cancel, and point them back to rebooking.
async function sendCancellationEmail(booking) {
  if (!booking.email) return { sent: false, reason: 'no-customer-email' };
  const tx = transport();
  if (!tx) return { sent: false, reason: 'smtp-not-configured' };
  const svc = config.servicesById[booking.service];
  const when = fmtWhen(booking);
  const from = config.fromEmail || config.smtp.user;
  // Build a CANCEL ICS so the event is also removed from the customer's calendar.
  let icalEvent;
  try {
    const ics = (await buildICS(booking)).replace('METHOD:REQUEST', 'METHOD:CANCEL').replace('STATUS:CONFIRMED', 'STATUS:CANCELLED');
    icalEvent = { method: 'CANCEL', content: ics, filename: 'cancel.ics' };
  } catch (_) {}
  const svcLabel = svc ? svc.label.toLowerCase() : 'appointment';
  await tx.sendMail({
    from: `${config.business.name} <${from}>`,
    to: booking.email,
    subject: `Your ${svc ? svc.label : 'appointment'} with ${config.business.name} has been cancelled`,
    text:
      `Hi ${booking.name},\n\n` +
      `Your ${svcLabel} with ${config.business.name}, scheduled for ${when} (ET), has been cancelled.\n\n` +
      `We're sorry for any inconvenience. You can easily reschedule:\n\n` +
      `  • Book a new time online: ${config.siteUrl}/#book\n` +
      `  • Or contact Trent directly — call or text (717) 882-1183\n\n` +
      `We'd still love to help with your project.\n\n— ${config.business.name}`,
    icalEvent,
  });
  return { sent: true };
}

/* ---------------------------------------------------------------------------
 * 3. OPTIONAL iCloud CalDAV write-back — insert the event directly into Apple
 *    Calendar so it appears instantly without Trent accepting the email invite.
 *    Only runs if iCloud creds are configured. Best-effort; never blocks a booking.
 * ------------------------------------------------------------------------- */
async function icloudWriteback(booking) {
  if (!config.icloud.username || !config.icloud.appPassword || !config.icloud.calendarUrl) return { written: false };
  try {
    const { createDAVClient } = require('tsdav');
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: config.icloud.username, password: config.icloud.appPassword },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
    const ics = await buildICS(booking);
    await client.createCalendarObject({
      calendar: { url: config.icloud.calendarUrl },
      filename: `${booking.uid}.ics`,
      iCalString: ics.replace('METHOD:REQUEST\r\n', ''), // a stored event, not an invite
    });
    return { written: true };
  } catch (err) {
    console.error(`[calendar] iCloud write-back failed: ${err.message}`);
    return { written: false, error: err.message };
  }
}

module.exports = {
  getExternalBusy,
  invalidateBusyCache,
  sendBookingEmails,
  sendCancellationEmail,
  icloudWriteback,
  buildICS,
  signUid,
  verifyManageSig,
  manageLink,
};
