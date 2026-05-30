'use strict';
// Central config, all overridable via environment variables (.env loaded in server.js).

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}
function str(name, def) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : def;
}
function list(name) {
  return str(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  port: int('PORT', 3007),
  timezone: str('TZ', 'America/New_York'),
  adminToken: str('ADMIN_TOKEN', ''),

  business: {
    name: "Trent's Fresh Spaces",
    // 0 = Sunday ... 6 = Saturday. Each day: open/close in 24h local time, or null = closed.
    // Trent's hours: 9 AM – 9 PM ET, 7 days. Set a day to null to close it.
    hours: {
      0: { open: '09:00', close: '21:00' },
      1: { open: '09:00', close: '21:00' },
      2: { open: '09:00', close: '21:00' },
      3: { open: '09:00', close: '21:00' },
      4: { open: '09:00', close: '21:00' },
      5: { open: '09:00', close: '21:00' },
      6: { open: '09:00', close: '21:00' },
    },
    leadTimeHours: int('LEAD_TIME_HOURS', 2), // earliest a customer can book from now (allows same-day)
    maxDaysAhead: int('MAX_DAYS_AHEAD', 45),
    slotStepMin: int('SLOT_STEP_MIN', 30), // grid the day is divided into
    bufferMin: int('BUFFER_MIN', 0), // default gap for external/unknown busy blocks
  },

  // bufferMin is per-service: on-site estimates reserve travel time on each side;
  // phone consults need none (back-to-back calls are fine).
  services: {
    estimate: { id: 'estimate', label: 'Free On-Site Estimate', durationMin: int('DUR_ESTIMATE_MIN', 60), bufferMin: int('BUFFER_ESTIMATE_MIN', 15) },
    consult: { id: 'consult', label: 'Phone Consultation', durationMin: int('DUR_CONSULT_MIN', 20), bufferMin: int('BUFFER_CONSULT_MIN', 0) },
  },

  // Read-only ICS feed URLs for Trent's calendars (Google "secret iCal address",
  // iCloud published-calendar URL, etc.). Any event on these blocks site availability.
  icsFeeds: list('ICS_FEEDS'),
  busyCacheTtlSec: int('BUSY_CACHE_TTL_SEC', 300),

  // Email (used to send ICS invites + notifications). If unset, booking still works
  // and is stored, but no email is sent.
  smtp: {
    host: str('SMTP_HOST', ''),
    port: int('SMTP_PORT', 587),
    secure: str('SMTP_SECURE', 'false') === 'true',
    user: str('SMTP_USER', ''),
    pass: str('SMTP_PASS', ''),
  },
  fromEmail: str('FROM_EMAIL', ''),
  // Trent's address(es) — receive the calendar invite + new-booking alerts.
  // Comma-separated; first is the primary (calendar organizer/attendee).
  ownerEmails: list('OWNER_EMAIL').length
    ? list('OWNER_EMAIL')
    : ['trent.freeland@gmail.com', 'freelandiam@gmail.com'],
  ownerName: str('OWNER_NAME', 'Trent Freeland'),

  // Optional iCloud CalDAV write-back (app-specific password) for instant insertion
  // into Trent's Apple Calendar without him accepting the email invite.
  icloud: {
    username: str('ICLOUD_USERNAME', ''),
    appPassword: str('ICLOUD_APP_PASSWORD', ''),
    calendarUrl: str('ICLOUD_CALENDAR_URL', ''), // specific calendar collection URL
  },
};

config.servicesById = config.services;
config.ownerEmail = config.ownerEmails[0]; // primary

module.exports = config;
