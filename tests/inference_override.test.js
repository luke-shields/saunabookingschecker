import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { initDb } from '../scripts/db/init_db.js';
import { refreshBookingsFromLatest } from '../scripts/harvest_to_sqlite.js';

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekdayMonday0(isoDate) {
  const dt = new Date(`${isoDate}T00:00:00`);
  const w0Sun = dt.getDay();
  return (w0Sun + 6) % 7;
}

describe('inference + overrides', () => {
  it('includes inferred-full sessions in totals, and removes them when a date override removes that time', () => {
    const db = new Database(':memory:');
    try {
      initDb(db);

      const tomorrow = new Date();
      tomorrow.setHours(0, 0, 0, 0);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const date = toIsoDate(tomorrow);
      const weekday = weekdayMonday0(date);

      db.prepare(
        `INSERT INTO saunas (sauna_name, site_key, seats_per_session)
         VALUES (?, ?, ?)`
      ).run('Test Sauna', 'test', 8);

      db.prepare(
        `INSERT INTO expected_weekly_open_times (sauna_name, weekday, open_times_json)
         VALUES (?, ?, ?)`
      ).run('Test Sauna', weekday, JSON.stringify(['18:30', '19:45']));

      // Provide one observed earlier session; leave later session unobserved so it becomes inferred.
      db.prepare(
        `INSERT INTO scrape_runs (id, sauna_name, site_key, scraped_at)
         VALUES (?, ?, ?, ?)`
      ).run(1, 'Test Sauna', 'test', `${date}T10:00:00.000Z`);

      db.prepare(
        `INSERT INTO observations (scrape_run_id, sauna_name, date, time, spots_left, spots_text)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(1, 'Test Sauna', date, '18:30', 6, '6 spots left');

      refreshBookingsFromLatest(db);

      const b1830 = db
        .prepare(
          `SELECT is_inferred, seats_per_session, spots_left, seats_booked
           FROM bookings
           WHERE sauna_name = ? AND date = ? AND time = ?`
        )
        .get('Test Sauna', date, '18:30');

      const b1945 = db
        .prepare(
          `SELECT is_inferred, seats_per_session, spots_left, seats_booked
           FROM bookings
           WHERE sauna_name = ? AND date = ? AND time = ?`
        )
        .get('Test Sauna', date, '19:45');

      expect(b1830).toBeTruthy();
      expect(b1830.is_inferred).toBe(0);
      expect(b1830.spots_left).toBe(6);
      expect(b1830.seats_booked).toBe(2);

      expect(b1945).toBeTruthy();
      expect(b1945.is_inferred).toBe(1);
      expect(b1945.spots_left).toBe(0);
      expect(b1945.seats_booked).toBe(8);

      const totals1 = db
        .prepare(
          `SELECT SUM(seats_per_session) AS total_seats, SUM(seats_booked) AS total_booked
           FROM bookings
           WHERE sauna_name = ? AND date = ?`
        )
        .get('Test Sauna', date);

      expect(totals1.total_seats).toBe(16);
      expect(totals1.total_booked).toBe(10);

      // Now override the date to remove the later time slot.
      db.prepare(
        `INSERT INTO expected_date_open_times_override (sauna_name, date, open_times_json)
         VALUES (?, ?, ?)`
      ).run('Test Sauna', date, JSON.stringify(['18:30']));

      refreshBookingsFromLatest(db);

      const after1830 = db
        .prepare(
          `SELECT is_inferred, seats_per_session, spots_left, seats_booked
           FROM bookings
           WHERE sauna_name = ? AND date = ? AND time = ?`
        )
        .get('Test Sauna', date, '18:30');

      const after1945 = db
        .prepare(
          `SELECT 1 AS ok
           FROM bookings
           WHERE sauna_name = ? AND date = ? AND time = ?`
        )
        .get('Test Sauna', date, '19:45');

      expect(after1830).toBeTruthy();
      expect(after1830.is_inferred).toBe(0);
      expect(after1945).toBeUndefined();

      const totals2 = db
        .prepare(
          `SELECT SUM(seats_per_session) AS total_seats, SUM(seats_booked) AS total_booked
           FROM bookings
           WHERE sauna_name = ? AND date = ?`
        )
        .get('Test Sauna', date);

      expect(totals2.total_seats).toBe(8);
      expect(totals2.total_booked).toBe(2);
    } finally {
      db.close();
    }
  });
});
