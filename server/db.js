'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'bookings.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uid         TEXT NOT NULL UNIQUE,
    service     TEXT NOT NULL,
    name        TEXT NOT NULL,
    email       TEXT,
    phone       TEXT NOT NULL,
    address     TEXT,
    notes       TEXT,
    start_utc   TEXT NOT NULL,
    end_utc     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'confirmed',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_start ON bookings(start_utc);
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO bookings (uid, service, name, email, phone, address, notes, start_utc, end_utc, status, created_at)
    VALUES (@uid, @service, @name, @email, @phone, @address, @notes, @start_utc, @end_utc, 'confirmed', @created_at)
  `),
  // Active bookings that overlap a [start,end) window.
  overlapping: db.prepare(`
    SELECT * FROM bookings
    WHERE status = 'confirmed' AND start_utc < @end AND end_utc > @start
  `),
  inRange: db.prepare(`
    SELECT * FROM bookings
    WHERE status = 'confirmed' AND start_utc < @end AND end_utc > @start
    ORDER BY start_utc ASC
  `),
  upcoming: db.prepare(`
    SELECT * FROM bookings
    WHERE status = 'confirmed' AND end_utc >= @now
    ORDER BY start_utc ASC
  `),
  byUid: db.prepare(`SELECT * FROM bookings WHERE uid = ?`),
  cancel: db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE uid = ?`),
};

module.exports = { db, stmts };
