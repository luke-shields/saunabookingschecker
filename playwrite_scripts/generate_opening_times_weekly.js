import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

const OUTPUT_PATH = path.join(PROJECT_ROOT, 'csvs', 'opening_times_weekly.csv');
const JSON_DIR = path.join(PROJECT_ROOT, 'temp_websites');

const DAYS_AHEAD_RAW = Number.parseInt(process.env.DAYS_AHEAD || '', 10);
const DAYS_AHEAD = Number.isFinite(DAYS_AHEAD_RAW) && DAYS_AHEAD_RAW > 0 ? DAYS_AHEAD_RAW : 28;

function parseArgs(argv) {
  const args = {
    sauna: [],
    siteKey: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sauna') {
      const v = argv[i + 1];
      if (typeof v === 'string') {
        args.sauna.push(v);
        i++;
      }
      continue;
    }
    if (a.startsWith('--sauna=')) {
      args.sauna.push(a.slice('--sauna='.length));
      continue;
    }
    if (a === '--sitekey') {
      const v = argv[i + 1];
      if (typeof v === 'string') {
        args.siteKey.push(v);
        i++;
      }
      continue;
    }
    if (a.startsWith('--sitekey=')) {
      args.siteKey.push(a.slice('--sitekey='.length));
      continue;
    }
  }

  return args;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function toIsoLocalDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekdayName(d) {
  const n = d.getDay();
  if (n === 0) return 'sunday';
  if (n === 1) return 'monday';
  if (n === 2) return 'tuesday';
  if (n === 3) return 'wednesday';
  if (n === 4) return 'thursday';
  if (n === 5) return 'friday';
  return 'saturday';
}

function compareTime(a, b) {
  const [ah, am] = String(a).split(':').map((x) => Number(x));
  const [bh, bm] = String(b).split(':').map((x) => Number(x));
  const av = (Number.isFinite(ah) ? ah : 0) * 60 + (Number.isFinite(am) ? am : 0);
  const bv = (Number.isFinite(bh) ? bh : 0) * 60 + (Number.isFinite(bm) ? bm : 0);
  return av - bv;
}

function runScrape({ sauna, siteKey }) {
  const scriptPath = path.join(PROJECT_ROOT, 'playwrite_scripts', 'open_urls.js');
  const args = [scriptPath];
  for (const s of sauna) {
    args.push('--sauna', s);
  }
  for (const k of siteKey) {
    args.push('--sitekey', k);
  }

  const res = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DAYS_AHEAD: String(DAYS_AHEAD),
    },
    stdio: 'inherit',
  });

  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) {
    throw new Error(`Scrape failed with exit code ${res.status}`);
  }
}

function loadScrapedSessions() {
  if (!fs.existsSync(JSON_DIR)) return [];
  const files = fs
    .readdirSync(JSON_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => path.join(JSON_DIR, f));

  const results = [];
  for (const p of files) {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
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

    const periods = Array.isArray(doc?.periods) ? doc.periods : [];
    for (const period of periods) {
      const sessions = Array.isArray(period?.sessions) ? period.sessions : [];
      for (const s of sessions) {
        const date = String(s?.date || '').trim();
        const time = String(s?.time || '').trim();
        if (!date || !time) continue;
        results.push({ saunaName, date, time });
      }
    }
  }

  return results;
}

function generateWeeklyOpeningTimesCsv(sessions) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = toIsoLocalDate(today);

  const perSauna = new Map();

  const seen = new Set();
  for (const s of sessions) {
    const key = `${s.saunaName}__${s.date}__${s.time}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const d = new Date(`${s.date}T00:00:00`);
    if (Number.isNaN(d.getTime())) continue;

    const diffDays = Math.floor((d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays < 0 || diffDays > DAYS_AHEAD - 1) continue;

    const wd = weekdayName(d);

    let saunaMap = perSauna.get(s.saunaName);
    if (!saunaMap) {
      saunaMap = new Map();
      perSauna.set(s.saunaName, saunaMap);
    }

    let weekdayMap = saunaMap.get(wd);
    if (!weekdayMap) {
      weekdayMap = new Map();
      saunaMap.set(wd, weekdayMap);
    }

    let dates = weekdayMap.get(s.time);
    if (!dates) {
      dates = new Set();
      weekdayMap.set(s.time, dates);
    }
    dates.add(s.date);
  }

  const lines = [];
  lines.push('SaunaName,Weekday,OpenTimes');

  const saunaNames = Array.from(perSauna.keys()).sort((a, b) => a.localeCompare(b));
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  for (const saunaName of saunaNames) {
    const saunaMap = perSauna.get(saunaName);
    if (!saunaMap) continue;

    for (const wd of weekdays) {
      const weekdayMap = saunaMap.get(wd);
      if (!weekdayMap) continue;

      const times = Array.from(weekdayMap.entries())
        .filter(([, dates]) => dates && dates.size >= 2)
        .map(([time]) => time)
        .sort(compareTime);

      if (times.length === 0) continue;

      const json = JSON.stringify(times);
      const escapedJson = `"${json.replace(/"/g, '""')}"`;

      lines.push(`${csvEscape(saunaName)},${csvEscape(wd)},${escapedJson}`);
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, lines.join('\n') + '\n', 'utf8');

  console.log(`Wrote: ${OUTPUT_PATH}`);
  console.log(
    `Range: ${todayIso} to ${toIsoLocalDate(new Date(today.getTime() + (DAYS_AHEAD - 1) * 24 * 60 * 60 * 1000))}`,
  );
}

const cli = parseArgs(process.argv.slice(2));

runScrape({ sauna: cli.sauna, siteKey: cli.siteKey });
const sessions = loadScrapedSessions();
generateWeeklyOpeningTimesCsv(sessions);
