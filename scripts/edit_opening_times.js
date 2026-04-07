import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'sauna_bookings.sqlite');
const SAUNA_INFO_PATH = path.join(PROJECT_ROOT, 'csvs', 'sauna_info.csv');

const WEEKDAY_NAMES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function parseArgs(argv) {
  const args = {
    db: DEFAULT_DB_PATH,
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
    if (a === '--sauna') {
      const v = argv[i + 1];
      if (typeof v === 'string' && v.trim()) {
        args.sauna.push(v.trim());
        i++;
      }
      continue;
    }
    if (a.startsWith('--sauna=')) {
      args.sauna.push(a.slice('--sauna='.length));
      continue;
    }
  }

  return args;
}

function makeNamePredicate(filters) {
  if (!filters || filters.length === 0) return () => true;

  const predicates = filters.map((f) => {
    const raw = String(f || '').trim();
    if (!raw) return () => true;
    if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
      const last = raw.lastIndexOf('/');
      const pattern = raw.slice(1, last);
      const flags = raw.slice(last + 1) || 'i';
      try {
        const re = new RegExp(pattern, flags);
        return (name) => re.test(String(name || ''));
      } catch {
        return (name) => String(name || '').toLowerCase().includes(raw.toLowerCase());
      }
    }
    const lowered = raw.toLowerCase();
    return (name) => String(name || '').toLowerCase().includes(lowered);
  });

  return (name) => predicates.some((p) => p(name));
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
      return {
        name: typeof name === 'string' ? name.trim() : String(name ?? '').trim(),
        url: typeof url === 'string' ? url.trim() : String(url ?? '').trim(),
        siteKey:
          typeof siteKey === 'string' ? siteKey.trim() : String(siteKey ?? '').trim(),
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
}

function isTimeLike(s) {
  return /^\d{1,2}:\d{2}$/.test(String(s || '').trim());
}

function sanitizeOpenTimes(openTimes) {
  return Array.from(new Set((openTimes || []).map((t) => String(t).trim()).filter(isTimeLike))).sort(
    (a, b) => a.localeCompare(b),
  );
}

function parseOpenTimesJson(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, times: [], error: 'Empty input' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, times: [], error: `Invalid JSON: ${e?.message || String(e)}` };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      times: [],
      error: 'JSON must be an array of strings like ["11:00","12:00"]',
    };
  }

  const times = parsed.map((x) => String(x).trim()).filter(Boolean);
  const bad = times.filter((t) => !isTimeLike(t));
  if (bad.length > 0) {
    return {
      ok: false,
      times: [],
      error: `Invalid time(s): ${bad.join(', ')}. Expected HH:MM e.g. 11:00`,
    };
  }

  return { ok: true, times: sanitizeOpenTimes(times), error: null };
}

function parseWeekday(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 6) return n;
  }

  const idx = WEEKDAY_NAMES.findIndex((x) => x === raw);
  if (idx >= 0) return idx;

  const idx2 = WEEKDAY_NAMES.findIndex((x) => x.startsWith(raw));
  if (idx2 >= 0) return idx2;

  return null;
}

function isIsoDate(input) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(input || '').trim());
}

async function askYesNo(rl, prompt, defaultValue = false) {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const answer = String(await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return defaultValue;
}

async function askMode(rl) {
  while (true) {
    const answer = String(
      await rl.question('Edit which schedule? Enter weekly or date (or blank to skip): '),
    )
      .trim()
      .toLowerCase();

    if (!answer) return null;
    if (answer === 'weekly' || answer === 'w') return 'weekly';
    if (answer === 'date' || answer === 'd') return 'date';
  }
}

function readExistingTimes(db, saunaName, mode, key) {
  if (mode === 'weekly') {
    const row = db
      .prepare(
        'SELECT open_times_json FROM expected_weekly_open_times WHERE sauna_name = ? AND weekday = ?',
      )
      .get(saunaName, key);
    if (!row?.open_times_json) return [];
    try {
      const p = JSON.parse(row.open_times_json);
      return Array.isArray(p) ? sanitizeOpenTimes(p) : [];
    } catch {
      return [];
    }
  }

  const row = db
    .prepare(
      'SELECT open_times_json FROM expected_date_open_times_override WHERE sauna_name = ? AND date = ?',
    )
    .get(saunaName, key);
  if (!row?.open_times_json) return [];
  try {
    const p = JSON.parse(row.open_times_json);
    return Array.isArray(p) ? sanitizeOpenTimes(p) : [];
  } catch {
    return [];
  }
}

function upsertTimes(db, saunaName, mode, key, times) {
  const json = JSON.stringify(sanitizeOpenTimes(times));

  if (mode === 'weekly') {
    db.prepare(
      `INSERT INTO expected_weekly_open_times (sauna_name, weekday, open_times_json)
       VALUES (?, ?, ?)
       ON CONFLICT(sauna_name, weekday) DO UPDATE SET
         open_times_json = excluded.open_times_json,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(saunaName, key, json);
    return;
  }

  db.prepare(
    `INSERT INTO expected_date_open_times_override (sauna_name, date, open_times_json)
     VALUES (?, ?, ?)
     ON CONFLICT(sauna_name, date) DO UPDATE SET
       open_times_json = excluded.open_times_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(saunaName, key, json);
}

async function promptForOpenTimes(rl) {
  console.log('Format example: ["11:00","12:00","13:00"]');
  console.log('Enter JSON array of times (HH:MM). Use [] for closed.');

  while (true) {
    const input = await rl.question('Open times JSON: ');
    const parsed = parseOpenTimesJson(input);
    if (parsed.ok) return parsed.times;
    console.log(parsed.error);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(SAUNA_INFO_PATH)) {
    console.error(`Missing sauna_info.csv at ${SAUNA_INFO_PATH}`);
    process.exit(1);
  }

  const saunas = readSaunaInfoCsv(SAUNA_INFO_PATH);
  const pred = makeNamePredicate(args.sauna);

  const db = new Database(args.db);
  initDb(db);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (const s of saunas) {
      if (!pred(s.name)) continue;

      console.log(`\nSauna: ${s.name}`);
      const wants = await askYesNo(rl, 'Add/update opening times?', false);
      if (!wants) continue;

      const mode = await askMode(rl);
      if (!mode) continue;

      if (mode === 'weekly') {
        while (true) {
          const w = await rl.question(
            'Weekday (0=Mon..6=Sun or name e.g. monday). Blank to cancel: ',
          );
          const weekday = parseWeekday(w);
          if (w.trim() === '') break;
          if (weekday == null) {
            console.log('Invalid weekday.');
            continue;
          }

          const existing = readExistingTimes(db, s.name, 'weekly', weekday);
          if (existing.length > 0) {
            console.log(`Existing: ${JSON.stringify(existing)}`);
          } else {
            console.log('Existing: (none)');
          }

          const entered = await promptForOpenTimes(rl);
          const merged = sanitizeOpenTimes([...existing, ...entered]);

          console.log(`Will save: ${JSON.stringify(merged)}`);
          const ok = await askYesNo(rl, 'Confirm save?', true);
          if (ok) {
            upsertTimes(db, s.name, 'weekly', weekday, merged);
            console.log('Saved.');
          } else {
            console.log('Skipped.');
          }

          break;
        }
      }

      if (mode === 'date') {
        while (true) {
          const d = await rl.question('Date override (YYYY-MM-DD). Blank to cancel: ');
          const date = String(d || '').trim();
          if (!date) break;
          if (!isIsoDate(date)) {
            console.log('Invalid date. Expected YYYY-MM-DD.');
            continue;
          }

          const existing = readExistingTimes(db, s.name, 'date', date);
          if (existing.length > 0) {
            console.log(`Existing: ${JSON.stringify(existing)}`);
          } else {
            console.log('Existing: (none)');
          }

          const entered = await promptForOpenTimes(rl);
          const merged = sanitizeOpenTimes([...existing, ...entered]);

          console.log(`Will save: ${JSON.stringify(merged)}`);
          const ok = await askYesNo(rl, 'Confirm save?', true);
          if (ok) {
            upsertTimes(db, s.name, 'date', date, merged);
            console.log('Saved.');
          } else {
            console.log('Skipped.');
          }

          break;
        }
      }
    }
  } finally {
    rl.close();
    db.close();
  }

  console.log('\nDone.');
}

main();
