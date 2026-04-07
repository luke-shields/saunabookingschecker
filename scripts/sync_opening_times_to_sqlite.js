import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'sauna_bookings.sqlite');
const SAUNA_INFO_PATH = path.join(PROJECT_ROOT, 'csvs', 'sauna_info.csv');
const WEEKLY_PATH = path.join(PROJECT_ROOT, 'csvs', 'opening_times_weekly.csv');
const OVERRIDES_PATH = path.join(PROJECT_ROOT, 'csvs', 'opening_times_overrides.csv');

const WEEKDAY_MAP = {
  monday: 0,
  mon: 0,
  tuesday: 1,
  tue: 1,
  tues: 1,
  wednesday: 2,
  wed: 2,
  thursday: 3,
  thu: 3,
  thur: 3,
  thurs: 3,
  friday: 4,
  fri: 4,
  saturday: 5,
  sat: 5,
  sunday: 6,
  sun: 6,
};

function parseArgs(argv) {
  const args = {
    db: DEFAULT_DB_PATH,
    weekly: WEEKLY_PATH,
    overrides: OVERRIDES_PATH,
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
    if (a === '--weekly') {
      const v = argv[i + 1];
      if (typeof v === 'string' && v.trim()) {
        args.weekly = v.trim();
        i++;
      }
      continue;
    }
    if (a === '--overrides') {
      const v = argv[i + 1];
      if (typeof v === 'string' && v.trim()) {
        args.overrides = v.trim();
        i++;
      }
      continue;
    }
  }

  return args;
}

function getCsvField(record, canonicalName) {
  const matchKey = Object.keys(record).find(
    (k) => k.replace(/\s+/g, '').toLowerCase() === canonicalName,
  );
  return matchKey ? record[matchKey] : undefined;
}

function stripOuterQuotes(s) {
  const t = String(s ?? '').trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1);
  return t;
}

function parseCsvLenient(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  const out = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const firstComma = line.indexOf(',');
    if (firstComma < 0) continue;
    const secondComma = line.indexOf(',', firstComma + 1);
    if (secondComma < 0) continue;

    const a = stripOuterQuotes(line.slice(0, firstComma));
    const b = stripOuterQuotes(line.slice(firstComma + 1, secondComma));
    const c = stripOuterQuotes(line.slice(secondComma + 1));

    const rec = {};
    rec[headers[0] || 'SaunaName'] = a;
    rec[headers[1] || 'Weekday'] = b;
    rec[headers[2] || 'OpenTimes'] = c;
    out.push(rec);
  }

  return out;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const csvText = fs.readFileSync(filePath, 'utf8');
  if (!csvText.trim()) return [];

  try {
    return parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
    });
  } catch (e) {
    console.warn(`Warning: failed to parse CSV strictly (${filePath}); falling back to lenient parsing.`);
    const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    console.warn(message);
    return parseCsvLenient(csvText);
  }
}

function readSaunaInfoCsv(filePath) {
  const records = readCsv(filePath);

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
    .filter((r) => r.name);
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

function isTimeLike(s) {
  return /^\d{1,2}:\d{2}$/.test(String(s || '').trim());
}

function sanitizeOpenTimes(openTimes) {
  return Array.from(new Set((openTimes || []).map((t) => String(t).trim()).filter(isTimeLike))).sort(
    (a, b) => a.localeCompare(b),
  );
}

function parseOpenTimesJson(openTimesRaw, context) {
  const raw = String(openTimesRaw ?? '').trim();
  if (!raw) return JSON.stringify([]);

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const times = sanitizeOpenTimes(parsed);
      return JSON.stringify(times);
    }
  } catch {
    // fall back
  }

  const matches = raw.match(/\b\d{1,2}:\d{2}\b/g) || [];
  const times = sanitizeOpenTimes(matches);
  if (times.length === 0) {
    if (raw === '[]') return JSON.stringify([]);
    console.warn(`${context}: could not parse OpenTimes; saving empty list. Raw: ${raw}`);
    return JSON.stringify([]);
  }

  console.warn(`${context}: OpenTimes was not valid JSON; extracted times from text instead.`);
  return JSON.stringify(times);
}

function parseWeekday(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 6) return n;
  }
  return Object.prototype.hasOwnProperty.call(WEEKDAY_MAP, raw) ? WEEKDAY_MAP[raw] : null;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').trim());
}

function syncWeekly(db, rows) {
  const upsert = db.prepare(
    `INSERT INTO expected_weekly_open_times (sauna_name, weekday, open_times_json)
     VALUES (?, ?, ?)
     ON CONFLICT(sauna_name, weekday) DO UPDATE SET
       open_times_json = excluded.open_times_json,
       updated_at = CURRENT_TIMESTAMP`,
  );

  for (const r of rows) {
    const saunaName = String(getCsvField(r, 'saunaname') ?? '').trim();
    if (!saunaName) continue;

    const weekdayRaw = getCsvField(r, 'weekday');
    const weekday = parseWeekday(weekdayRaw);
    if (weekday == null) {
      throw new Error(
        `opening_times_weekly.csv: invalid Weekday '${weekdayRaw}' for sauna '${saunaName}'`,
      );
    }

    const openTimesRaw = getCsvField(r, 'opentimes');
    const openTimesJson = parseOpenTimesJson(
      openTimesRaw,
      `opening_times_weekly.csv (${saunaName}, weekday=${weekday})`,
    );

    upsert.run(saunaName, weekday, openTimesJson);
  }
}

function syncOverrides(db, rows) {
  const upsert = db.prepare(
    `INSERT INTO expected_date_open_times_override (sauna_name, date, open_times_json)
     VALUES (?, ?, ?)
     ON CONFLICT(sauna_name, date) DO UPDATE SET
       open_times_json = excluded.open_times_json,
       updated_at = CURRENT_TIMESTAMP`,
  );

  for (const r of rows) {
    const saunaName = String(getCsvField(r, 'saunaname') ?? '').trim();
    if (!saunaName) continue;

    const dateRaw = getCsvField(r, 'date');
    const date = String(dateRaw ?? '').trim();
    if (!isIsoDate(date)) {
      throw new Error(
        `opening_times_overrides.csv: invalid Date '${dateRaw}' for sauna '${saunaName}'`,
      );
    }

    const openTimesRaw = getCsvField(r, 'opentimes');
    const openTimesJson = parseOpenTimesJson(
      openTimesRaw,
      `opening_times_overrides.csv (${saunaName}, date=${date})`,
    );

    upsert.run(saunaName, date, openTimesJson);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(SAUNA_INFO_PATH)) {
    console.error(`Missing sauna_info.csv at ${SAUNA_INFO_PATH}`);
    process.exit(1);
  }

  const saunaInfo = readSaunaInfoCsv(SAUNA_INFO_PATH);
  const weeklyRows = readCsv(args.weekly);
  const overrideRows = readCsv(args.overrides);

  const db = new Database(args.db);
  try {
    initDb(db);
    upsertSaunasFromCsv(db, saunaInfo);

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM expected_weekly_open_times').run();
      db.prepare('DELETE FROM expected_date_open_times_override').run();
      syncWeekly(db, weeklyRows);
      syncOverrides(db, overrideRows);
    });

    tx();
  } finally {
    db.close();
  }

  console.log(`Done. Synced opening times into DB: ${args.db}`);
}

main();
