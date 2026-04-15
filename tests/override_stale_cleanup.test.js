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

describe('overrides should remove stale expected/inferred bookings outside the horizon', () => {
  it('deletes an expected booking when a date override removes that time, even if the date is outside the 9-day view horizon', () => {
    const db = new Database(':memory:');
    try {
      initDb(db);

      const far = new Date();
      far.setHours(0, 0, 0, 0);
      far.setDate(far.getDate() + 30);
      const date = toIsoDate(far);

      db.prepare(
        `INSERT INTO saunas (sauna_name, site_key, seats_per_session)
         VALUES (?, ?, ?)`
      ).run('Test Sauna', 'test', 8);

      // Pretend we previously had an inferred expected slot saved in bookings for a far-future date.
      db.prepare(
        `INSERT INTO scrape_runs (id, sauna_name, site_key, scraped_at)
         VALUES (?, ?, ?, ?)`
      ).run(1, 'Test Sauna', 'test', `${date}T10:00:00.000Z`);

      db.prepare(
        `INSERT INTO bookings (
          sauna_name,
          date,
          time,
          scrape_run_id,
          scraped_at,
          is_expected,
          is_inferred,
          seats_per_session,
          spots_left,
          seats_booked,
          percent_full
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'Test Sauna',
        date,
        '19:45',
        1,
        `${date}T10:00:00.000Z`,
        1,
        1,
        8,
        0,
        8,
        100.0,
      );

      // Now you change the override for that date to REMOVE 19:45.
      db.prepare(
        `INSERT INTO expected_date_open_times_override (sauna_name, date, open_times_json)
         VALUES (?, ?, ?)`
      ).run('Test Sauna', date, JSON.stringify(['18:30']));

      // The view only covers the next 9 days, so refresh won't re-upsert this far-future date.
      // The bug: cleanup currently only deletes within the horizon, so this stale inferred row remains.
      refreshBookingsFromLatest(db);

      const stillThere = db
        .prepare(
          `SELECT 1 AS ok
           FROM bookings
           WHERE sauna_name = ? AND date = ? AND time = ?`
        )
        .get('Test Sauna', date, '19:45');

      // Desired behavior: it should be deleted due to the override.
      expect(stillThere).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
