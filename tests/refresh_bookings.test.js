import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { initDb } from '../scripts/db/init_db.js';
import { refreshBookingsFromLatest } from '../scripts/harvest_to_sqlite.js';

describe('refreshBookingsFromLatest', () => {
  it('does not overwrite existing non-null spots_left with null from the view', () => {
    const db = new Database(':memory:');
    try {
      initDb(db);

      db.prepare(
        `INSERT INTO saunas (sauna_name, site_key, seats_per_session)
         VALUES (?, ?, ?)`
      ).run('Wilder Sauna', 'wilder', 8);

      db.prepare(
        `INSERT INTO scrape_runs (id, sauna_name, site_key, scraped_at)
         VALUES (?, ?, ?, ?)`
      ).run(123, 'Wilder Sauna', 'wilder', '2026-04-10T10:00:00.000Z');

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
        'Wilder Sauna',
        '2026-04-10',
        '19:00',
        123,
        '2026-04-10T10:00:00.000Z',
        0,
        0,
        8,
        6,
        2,
        25.0,
      );

      db.prepare(
        `INSERT INTO scrape_runs (id, sauna_name, site_key, scraped_at)
         VALUES (?, ?, ?, ?)`
      ).run(124, 'Wilder Sauna', 'wilder', '2026-04-10T11:00:00.000Z');

      db.prepare(
        `INSERT INTO observations (scrape_run_id, sauna_name, date, time, spots_left, spots_text)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(124, 'Wilder Sauna', '2026-04-10', '19:00', null, null);

      refreshBookingsFromLatest(db);

      const row = db
        .prepare(
          `SELECT scrape_run_id, scraped_at, spots_left, seats_booked, percent_full
           FROM bookings
           WHERE sauna_name = ? AND date = ? AND time = ?`
        )
        .get('Wilder Sauna', '2026-04-10', '19:00');

      expect(row.spots_left).toBe(6);
      expect(row.seats_booked).toBe(2);
      expect(row.percent_full).toBe(25.0);
      expect(row.scrape_run_id).toBe(123);
      expect(row.scraped_at).toBe('2026-04-10T10:00:00.000Z');
    } finally {
      db.close();
    }
  });
});
