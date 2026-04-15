import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { initDb } from '../scripts/db/init_db.js';

describe('initDb', () => {
  it('creates core tables and views', () => {
    const db = new Database(':memory:');
    try {
      initDb(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);

      expect(tables).toContain('saunas');
      expect(tables).toContain('scrape_runs');
      expect(tables).toContain('observations');
      expect(tables).toContain('bookings');

      const views = db
        .prepare("SELECT name FROM sqlite_master WHERE type='view'")
        .all()
        .map((r) => r.name);

      expect(views).toContain('v_sessions_latest_with_inference');
      expect(views).toContain('v_metrics_weekly_by_sauna');
    } finally {
      db.close();
    }
  });
});
