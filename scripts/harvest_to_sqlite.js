import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const csvText = fs.readFileSync(filePath, 'utf8');
  const records = parse(csvText, {
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

function initDb(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS saunas (
      sauna_name TEXT PRIMARY KEY,
      url TEXT,
      site_key TEXT,
      seats_per_session INTEGER,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sauna_name TEXT NOT NULL,
      site_key TEXT,
      scraped_at TEXT NOT NULL,
      source_json_path TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name)
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scrape_run_id INTEGER NOT NULL,
      period_index INTEGER NOT NULL,
      period_label TEXT,
      period_suffix TEXT,
      date TEXT,
      time TEXT,
      spots_left INTEGER,
      spots_text TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      FOREIGN KEY (scrape_run_id) REFERENCES scrape_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_observations_run ON observations(scrape_run_id);
    CREATE INDEX IF NOT EXISTS idx_observations_slot ON observations(date, time);

    CREATE TABLE IF NOT EXISTS expected_weekly_open_times (
      sauna_name TEXT NOT NULL,
      weekday INTEGER NOT NULL,
      open_times_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (sauna_name, weekday),
      FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name)
    );

    CREATE TABLE IF NOT EXISTS expected_date_open_times_override (
      sauna_name TEXT NOT NULL,
      date TEXT NOT NULL,
      open_times_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (sauna_name, date),
      FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name)
    );
  `);

  db.exec(`
    CREATE VIEW IF NOT EXISTS v_sessions_latest_with_inference AS
    WITH RECURSIVE
      dates(d) AS (
        SELECT date('now')
        UNION ALL
        SELECT date(d, '+1 day') FROM dates WHERE d < date('now', '+9 day')
      ),
      latest_run AS (
        SELECT sauna_name, MAX(id) AS scrape_run_id
        FROM scrape_runs
        GROUP BY sauna_name
      ),
      latest_obs_ranked AS (
        SELECT
          sr.sauna_name AS sauna_name,
          sr.id AS scrape_run_id,
          sr.scraped_at AS scraped_at,
          o.date AS date,
          o.time AS time,
          o.spots_left AS spots_left,
          o.spots_text AS spots_text,
          ROW_NUMBER() OVER (
            PARTITION BY sr.sauna_name, o.date, o.time
            ORDER BY o.id DESC
          ) AS rn
        FROM scrape_runs sr
        JOIN latest_run lr ON lr.scrape_run_id = sr.id
        JOIN observations o ON o.scrape_run_id = sr.id
        WHERE o.date IS NOT NULL AND o.time IS NOT NULL
      ),
      latest_obs AS (
        SELECT sauna_name, scrape_run_id, scraped_at, date, time, spots_left, spots_text
        FROM latest_obs_ranked
        WHERE rn = 1
      ),
      expected_dates AS (
        SELECT
          s.sauna_name AS sauna_name,
          s.site_key AS site_key,
          s.seats_per_session AS seats_per_session,
          d.d AS date,
          ((CAST(strftime('%w', d.d) AS INTEGER) + 6) % 7) AS weekday_monday0
        FROM saunas s
        CROSS JOIN dates d
      ),
      expected_source AS (
        SELECT
          ed.sauna_name AS sauna_name,
          ed.site_key AS site_key,
          ed.seats_per_session AS seats_per_session,
          ed.date AS date,
          COALESCE(ov.open_times_json, wk.open_times_json) AS open_times_json
        FROM expected_dates ed
        LEFT JOIN expected_date_open_times_override ov
          ON ov.sauna_name = ed.sauna_name AND ov.date = ed.date
        LEFT JOIN expected_weekly_open_times wk
          ON wk.sauna_name = ed.sauna_name AND wk.weekday = ed.weekday_monday0
      ),
      expected_slots AS (
        SELECT
          es.sauna_name AS sauna_name,
          es.site_key AS site_key,
          es.seats_per_session AS seats_per_session,
          es.date AS date,
          je.value AS time
        FROM expected_source es
        JOIN json_each(es.open_times_json) je
      ),
      expected_joined AS (
        SELECT
          e.sauna_name AS sauna_name,
          e.site_key AS site_key,
          e.seats_per_session AS seats_per_session,
          e.date AS date,
          e.time AS time,
          lo.scrape_run_id AS scrape_run_id,
          lo.scraped_at AS scraped_at,
          lo.spots_left AS observed_spots_left,
          lo.spots_text AS observed_spots_text
        FROM expected_slots e
        LEFT JOIN latest_obs lo
          ON lo.sauna_name = e.sauna_name AND lo.date = e.date AND lo.time = e.time
      ),
      expected_final AS (
        SELECT
          sauna_name,
          site_key,
          seats_per_session,
          date,
          time,
          scrape_run_id,
          scraped_at,
          1 AS is_expected,
          CASE WHEN observed_spots_left IS NULL AND observed_spots_text IS NULL THEN 1 ELSE 0 END AS is_inferred,
          CASE
            WHEN observed_spots_left IS NULL AND observed_spots_text IS NULL THEN 0
            ELSE observed_spots_left
          END AS spots_left,
          CASE
            WHEN observed_spots_left IS NULL AND observed_spots_text IS NULL THEN 'Full (inferred)'
            ELSE observed_spots_text
          END AS spots_text
        FROM expected_joined
      ),
      unexpected_obs AS (
        SELECT
          lo.sauna_name AS sauna_name,
          s.site_key AS site_key,
          s.seats_per_session AS seats_per_session,
          lo.date AS date,
          lo.time AS time,
          lo.scrape_run_id AS scrape_run_id,
          lo.scraped_at AS scraped_at,
          0 AS is_expected,
          0 AS is_inferred,
          lo.spots_left AS spots_left,
          lo.spots_text AS spots_text
        FROM latest_obs lo
        JOIN saunas s ON s.sauna_name = lo.sauna_name
        WHERE NOT EXISTS (
          SELECT 1 FROM expected_slots e
          WHERE e.sauna_name = lo.sauna_name AND e.date = lo.date AND e.time = lo.time
        )
      )
    SELECT * FROM expected_final
    UNION ALL
    SELECT * FROM unexpected_obs;
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
      period_index,
      period_label,
      period_suffix,
      date,
      time,
      spots_left,
      spots_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      for (let p = 0; p < periods.length; p++) {
        const period = periods[p] || {};
        const periodLabel = period.label == null ? null : String(period.label);
        const periodSuffix = period.suffix == null ? null : String(period.suffix);
        const sessions = Array.isArray(period.sessions) ? period.sessions : [];

        for (const s of sessions) {
          const date = s?.date == null ? null : String(s.date).trim();
          const time = s?.time == null ? null : String(s.time).trim();
          const spotsLeft = s?.spotsLeft == null || s.spotsLeft === '' ? null : Number(s.spotsLeft);
          const spotsLeftNum = Number.isFinite(spotsLeft) ? spotsLeft : null;
          const spotsText = s?.spotsText == null ? null : String(s.spotsText);

          insertObs.run(
            runId,
            p,
            periodLabel,
            periodSuffix,
            date,
            time,
            spotsLeftNum,
            spotsText,
          );
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
  } finally {
    db.close();
  }

  console.log(`Done. DB: ${args.db}`);
}

main();
