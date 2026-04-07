import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDb } from './db/init_db.js';

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
