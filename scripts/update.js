import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {
    db: null,
    sauna: [],
    siteKey: [],
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
    if (a === '--sitekey') {
      const v = argv[i + 1];
      if (typeof v === 'string' && v.trim()) {
        args.siteKey.push(v.trim());
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

function runOrExit(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (typeof r.status === 'number' && r.status !== 0) process.exit(r.status);
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
}

export function main() {
  const args = parseArgs(process.argv.slice(2));

  const scrapeArgs = ['run', 'scrape:booking-data'];
  if (args.sauna.length || args.siteKey.length) {
    scrapeArgs.push('--');
    for (const s of args.sauna) scrapeArgs.push('--sauna', s);
    for (const k of args.siteKey) scrapeArgs.push('--sitekey', k);
  }

  const harvestArgs = ['run', 'push:bookings:db'];
  if (args.db) harvestArgs.push('--', '--db', args.db);

  console.log('Update: scraping booking data (JSON)');
  runOrExit('npm', scrapeArgs);

  console.log('Update: pushing bookings into database');
  runOrExit('npm', harvestArgs);

  console.log('Update: done');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
