'use strict';
const { DateTime } = require('luxon');
const config = require('./config');

// luxon weekday: 1=Mon..7=Sun  ->  config.hours key: 0=Sun..6=Sat
function hoursForWeekday(luxonWeekday) {
  const key = luxonWeekday % 7; // 7(Sun)->0, 1(Mon)->1 ... 6(Sat)->6
  return config.business.hours[key] || null;
}

function hmToMinutes(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

// busyIntervals: array of { start, end } in ms epoch, ALREADY padded by each
// booking's own buffer (see dbBusyInRange). Candidate is checked raw.
function collides(startMs, endMs, busyIntervals) {
  for (const b of busyIntervals) {
    if (startMs < b.end && endMs > b.start) return true;
  }
  return false;
}

function serviceOrThrow(serviceId) {
  const svc = config.servicesById[serviceId];
  if (!svc) {
    const err = new Error('Unknown service');
    err.status = 400;
    throw err;
  }
  return svc;
}

/**
 * Generate bookable start times for a given service and local calendar date.
 * @param {string} serviceId
 * @param {string} dateISO  "YYYY-MM-DD" in the business timezone
 * @param {Array}  busyIntervals  [{start,end} ms epoch] from DB bookings + calendar feeds
 * @param {number} nowMs
 * @returns {Array<{start:string,end:string,label:string}>}  ISO UTC start/end + local label
 */
function generateSlots(serviceId, dateISO, busyIntervals, nowMs) {
  const svc = serviceOrThrow(serviceId);
  const tz = config.timezone;
  const durMs = svc.durationMin * 60000;
  const stepMs = config.business.slotStepMin * 60000;
  const earliestMs = nowMs + config.business.leadTimeHours * 3600000;

  const dayStart = DateTime.fromISO(dateISO, { zone: tz }).startOf('day');
  if (!dayStart.isValid) return [];

  // Bounds: not in the past, not beyond maxDaysAhead.
  const maxDay = DateTime.fromMillis(nowMs, { zone: tz }).plus({ days: config.business.maxDaysAhead }).endOf('day');
  if (dayStart.endOf('day') < DateTime.fromMillis(nowMs, { zone: tz }).startOf('day')) return [];
  if (dayStart > maxDay) return [];

  const hours = hoursForWeekday(dayStart.weekday);
  if (!hours) return [];

  const open = dayStart.plus({ minutes: hmToMinutes(hours.open) });
  const close = dayStart.plus({ minutes: hmToMinutes(hours.close) });

  const slots = [];
  let cursor = open;
  while (cursor.plus({ milliseconds: durMs }) <= close) {
    const startMs = cursor.toMillis();
    const endMs = startMs + durMs;
    if (startMs >= earliestMs && !collides(startMs, endMs, busyIntervals)) {
      slots.push({
        start: DateTime.fromMillis(startMs, { zone: 'utc' }).toISO(),
        end: DateTime.fromMillis(endMs, { zone: 'utc' }).toISO(),
        label: cursor.toFormat('h:mm a'),
      });
    }
    cursor = cursor.plus({ milliseconds: stepMs });
  }
  return slots;
}

/**
 * Validate a requested start time at booking time. Returns {ok, end, reason}.
 */
function validateBooking(serviceId, startISO, busyIntervals, nowMs) {
  const svc = serviceOrThrow(serviceId);
  const tz = config.timezone;
  const durMs = svc.durationMin * 60000;

  const start = DateTime.fromISO(startISO, { zone: 'utc' });
  if (!start.isValid) return { ok: false, reason: 'Invalid start time' };
  const startMs = start.toMillis();
  const endMs = startMs + durMs;

  // Must be a valid slot on that day (alignment + business hours).
  const dateISO = start.setZone(tz).toFormat('yyyy-LL-dd');
  const validStarts = new Set(generateSlots(serviceId, dateISO, busyIntervals, nowMs).map((s) => s.start));
  if (!validStarts.has(start.toISO())) {
    return { ok: false, reason: 'That time is no longer available' };
  }
  if (collides(startMs, endMs, busyIntervals)) {
    return { ok: false, reason: 'That time was just booked' };
  }
  return { ok: true, end: DateTime.fromMillis(endMs, { zone: 'utc' }).toISO(), durationMin: svc.durationMin };
}

module.exports = { generateSlots, validateBooking, serviceOrThrow };
