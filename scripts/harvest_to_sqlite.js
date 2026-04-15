import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { initDb } from './db/init_db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'sauna_bookings.sqlite');
const DEFAULT_INPUT_DIR = path.join(PROJECT_ROOT, 'temp_websites');
const SAUNA_INFO_PATH = path.join(PROJECT_ROOT, 'csvs', 'sauna_info.csv');

function parseArgs(argv) {
  const args = {
    db: DEFAULT_DB_PATH,
    input: DEFAULT_INPUT_DIR,
    sauna: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      const v = argv[i + 1];
      if (typeof v === 'string' && v.trim()) {
        args.db = v.trim();
        i++;
      }
      continue;
    }
    if (a === '--input') {
      const v = argv[i + 1];
      if (typeof v === 'string' && v.trim()) {
        args.input = v.trim();
        i++;
      }
      continue;
    }
    if (a === '--sauna') {
      const v = argv[i + 1];
      if (typeof v === 'string' && v.trim()) {
        args.sauna.push(v.trim());
        i++;
      }
      continue;
    }
  }

  return args;
}

function makeNamePredicate(patterns) {
  const compiled = patterns
    .map((p) => {
      const s = String(p || '').trim();
      if (!s) return null;
      if (s.startsWith('/') && s.endsWith('/') && s.length > 2) {
        try {
          return { type: 'regex', value: new RegExp(s.slice(1, -1), 'i') };
        } catch {
          return { type: 'substr', value: s };
        }
      }
      return { type: 'substr', value: s };
    })
    .filter(Boolean);

  return (name) => {
    if (compiled.length === 0) return true;
    const n = String(name || '');
    for (const c of compiled) {
      if (c.type === 'regex') {
        if (c.value.test(n)) return true;
      } else {
        if (n.toLowerCase().includes(String(c.value).toLowerCase())) return true;
      }
    }
    return false;
  };
}

function getCsvField(record, canonicalName) {
  const matchKey = Object.keys(record).find(
    (k) => k.replace(/\s+/g, '').toLowerCase() === canonicalName,
  );
  return matchKey ? record[matchKey] : undefined;
}

function readSaunaInfoCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  });

  return records
    .map((r) => {
      const name = getCsvField(r, 'saunaname');
      const url = getCsvField(r, 'url');
      const siteKey = getCsvField(r, 'sitekey');
      const seats = getCsvField(r, 'seatspersession');
      const seatsNum = seats == null || String(seats).trim() === '' ? null : Number(seats);

      return {
        name: typeof name === 'string' ? name.trim() : String(name ?? '').trim(),
        url: typeof url === 'string' ? url.trim() : String(url ?? '').trim(),
        siteKey:
          typeof siteKey === 'string' ? siteKey.trim() : String(siteKey ?? '').trim(),
        seatsPerSession: Number.isFinite(seatsNum) ? seatsNum : null,
      };
    })
    .filter((r) => r.url && r.url !== '.');
}

export function refreshBookingsFromLatest(db) {
  db.exec(`
    INSERT INTO bookings (
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
    )
    SELECT
      sauna_name,
      date,
      time,
      scrape_run_id,
      scraped_at,
      is_expected,
      is_inferred,
      seats_per_session,
      spots_left,
      CASE
        WHEN seats_per_session IS NULL OR seats_per_session <= 0 THEN NULL
        WHEN spots_left IS NULL THEN NULL
        WHEN spots_left >= seats_per_session THEN 0
        WHEN spots_left <= 0 THEN seats_per_session
        ELSE (seats_per_session - spots_left)
      END AS seats_booked,
      CASE
        WHEN seats_per_session IS NULL OR seats_per_session <= 0 THEN NULL
        WHEN spots_left IS NULL THEN NULL
        WHEN spots_left >= seats_per_session THEN 0.0
        WHEN spots_left <= 0 THEN 100.0
        ELSE (100.0 * (seats_per_session - spots_left) / seats_per_session)
      END AS percent_full
    FROM v_sessions_latest_with_inference
    WHERE date IS NOT NULL AND time IS NOT NULL
    ON CONFLICT(sauna_name, date, time) DO UPDATE SET
      scrape_run_id = CASE
        WHEN excluded.spots_left IS NULL THEN bookings.scrape_run_id
        ELSE excluded.scrape_run_id
      END,
      scraped_at = CASE
        WHEN excluded.spots_left IS NULL THEN bookings.scraped_at
        ELSE excluded.scraped_at
      END,
      is_expected = excluded.is_expected,
      is_inferred = excluded.is_inferred,
      seats_per_session = excluded.seats_per_session,
      spots_left = COALESCE(excluded.spots_left, bookings.spots_left),
      seats_booked = CASE
        WHEN excluded.spots_left IS NULL THEN bookings.seats_booked
        ELSE excluded.seats_booked
      END,
      percent_full = CASE
        WHEN excluded.spots_left IS NULL THEN bookings.percent_full
        ELSE excluded.percent_full
      END,
      updated_at = CURRENT_TIMESTAMP;

    DELETE FROM bookings
    WHERE date >= date('now', 'localtime')
      AND date <= date('now', 'localtime', '+9 day')
      AND NOT EXISTS (
        SELECT 1
        FROM v_sessions_latest_with_inference v
        WHERE v.sauna_name = bookings.sauna_name
          AND v.date = bookings.date
          AND v.time = bookings.time
      );
  `);
}

function upsertSaunasFromCsv(db, saunaInfo) {
  const upsert = db.prepare(
    `INSERT INTO saunas (sauna_name, url, site_key, seats_per_session)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sauna_name) DO UPDATE SET
       url = excluded.url,
       site_key = excluded.site_key,
       seats_per_session = excluded.seats_per_session,
       updated_at = CURRENT_TIMESTAMP`,
  );

  const tx = db.transaction(() => {
    for (const s of saunaInfo) {
      upsert.run(s.name, s.url || null, s.siteKey || null, s.seatsPerSession);
    }
  });

  tx();
}

function harvestJsonFiles({ db, inputDir, saunaPredicate }) {
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => path.join(inputDir, f));

  const insertRun = db.prepare(
    `INSERT INTO scrape_runs (sauna_name, site_key, scraped_at, source_json_path)
     VALUES (?, ?, ?, ?)`,
  );

  const insertObs = db.prepare(
    `INSERT INTO observations (
      scrape_run_id,
      sauna_name,
      date,
      time,
      spots_left,
      spots_text
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const filePath of files) {
      let raw;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      let doc;
      try {
        doc = JSON.parse(raw);
      } catch {
        continue;
      }

      const saunaName = String(doc?.saunaName || '').trim();
      if (!saunaName) continue;
      if (!saunaPredicate(saunaName)) continue;

      const scrapedAt = String(doc?.scrapedAt || '').trim();
      const siteKey = String(doc?.siteKey || '').trim() || null;

      const relPath = path.isAbsolute(filePath) ? path.relative(PROJECT_ROOT, filePath) : filePath;
      const info = insertRun.run(saunaName, siteKey, scrapedAt || new Date().toISOString(), relPath);
      const runId = Number(info.lastInsertRowid);

      const periods = Array.isArray(doc?.periods) ? doc.periods : [];
      for (const period of periods) {
        const sessions = Array.isArray(period?.sessions) ? period.sessions : [];

        for (const s of sessions) {
          const date = s?.date == null ? null : String(s.date).trim();
          const time = s?.time == null ? null : String(s.time).trim();
          const spotsLeft = s?.spotsLeft == null || s.spotsLeft === '' ? null : Number(s.spotsLeft);
          const spotsLeftNum = Number.isFinite(spotsLeft) ? spotsLeft : null;
          const spotsText = s?.spotsText == null ? null : String(s.spotsText);

          insertObs.run(runId, saunaName, date, time, spotsLeftNum, spotsText);
        }
      }
    }
  });

  tx();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const saunaPredicate = makeNamePredicate(args.sauna);

  if (!fs.existsSync(SAUNA_INFO_PATH)) {
    console.error(`Missing sauna_info.csv at ${SAUNA_INFO_PATH}`);
    process.exit(1);
  }

  const saunaInfo = readSaunaInfoCsv(SAUNA_INFO_PATH);
  const db = new Database(args.db);

  try {
    initDb(db);
    upsertSaunasFromCsv(db, saunaInfo);
    harvestJsonFiles({ db, inputDir: args.input, saunaPredicate });
    refreshBookingsFromLatest(db);
  } finally {
    db.close();
  }

  console.log(`Done. DB: ${args.db}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
