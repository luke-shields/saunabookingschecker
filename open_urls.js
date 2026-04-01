import { chromium } from 'playwright';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAYS_AHEAD = 10;

function parseSpotsLeft(text) {
  const t = String(text || '').trim();
  const m = t.match(/(\d+)\s+spots?\s+left/i);
  if (m) return Number(m[1]);
  if (/no\s+spots?\s+left/i.test(t)) return 0;
  if (/^full$/i.test(t)) return 0;
  return null;
}

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function toIsoDateFromLongMonthLabel(label) {
  // Example: "April 2, 2026"
  const m = String(label || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

async function waitForPeriodKeyChange({ page, adapter, beforeKey, timeoutMs }) {
  if (!beforeKey || !adapter.getPeriodKey) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentKey = await adapter.getPeriodKey(page);
    if (currentKey && currentKey !== beforeKey) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

function filterSessionsToNextDays(sessions, daysAhead) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + Math.max(0, daysAhead - 1));

  return sessions.filter((s) => {
    if (!s.date) return true;
    const d = new Date(`${s.date}T00:00:00`);
    if (Number.isNaN(d.getTime())) return true;
    return d >= today && d <= end;
  });
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
    .filter((r) => r.url && r.url !== '.');
}

function parseArgs(argv) {
  const args = {
    list: false,
    sauna: [],
    siteKey: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') {
      args.list = true;
      continue;
    }
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
        // fall back to substring
      }
    }
    const lowered = raw.toLowerCase();
    return (name) => String(name || '').toLowerCase().includes(lowered);
  });

  return (name) => predicates.some((p) => p(name));
}

function toSafeFileName(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAUNA_INFO_PATH = path.join(__dirname, 'sauna_info.csv');
const OUTPUT_DIR = path.join(__dirname, 'temp_websites');

const cli = parseArgs(process.argv.slice(2));

let saunas = readSaunaInfoCsv(SAUNA_INFO_PATH);
if (saunas.length === 0) {
  console.error('No sauna URLs found in sauna_info.csv');
  process.exit(1);
}

if (cli.list) {
  for (const s of saunas) {
    console.log(`${s.name} (SiteKey=${s.siteKey})`);
  }
  process.exit(0);
}

if (cli.siteKey.length > 0) {
  const wanted = new Set(cli.siteKey.map((x) => String(x || '').trim()).filter(Boolean));
  saunas = saunas.filter((s) => wanted.has(String(s.siteKey || '').trim()));
}

if (cli.sauna.length > 0) {
  const pred = makeNamePredicate(cli.sauna);
  saunas = saunas.filter((s) => pred(s.name));
}

if (saunas.length === 0) {
  console.error('No saunas matched the provided filters. Use --list to see available saunas.');
  process.exit(1);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const usedNames = new Set();

const SITE_ADAPTERS = {
  wilder: {
    key: 'wilder',
    extractSelector: "[data-hook='BookingCalendar-wrapper']",
    nextSelector: "[data-hook='next-arrow']",
    nextSuffix: 'next_week',
    async getPeriodKey(page) {
      return await page.evaluate((extractSelector) => {
        const root = document.querySelector(extractSelector);
        if (!root) return null;

        const caption = root
          .querySelector('[data-hook="caption-text"]')
          ?.textContent?.trim();

        const firstDayHook = root
          .querySelector('[data-hook^="day-availability-"]')
          ?.getAttribute('data-hook');

        return `${caption || ''}||${firstDayHook || ''}`;
      }, "[data-hook='BookingCalendar-wrapper']");
    },
    async scrapePeriod(page) {
      await page.waitForSelector("[data-hook='BookingCalendar-wrapper']", { timeout: 30_000 });
      // After period navigation the wrapper persists, but the agenda content hydrates asynchronously.
      // Best-effort wait to reduce empty-scrape risk.
      try {
        await page.waitForSelector(
          "[data-hook='BookingCalendar-wrapper'] [data-hook='agenda-slot-time']",
          { timeout: 10_000 },
        );
      } catch {
        // ignore (some weeks may have no slots)
      }
      return await page.evaluate(() => {
        const root = document.querySelector("[data-hook='BookingCalendar-wrapper']");
        if (!root) return { periodLabel: null, sessions: [] };

        const periodLabel = root
          .querySelector('[data-hook="caption-text"]')
          ?.textContent?.trim();

        const slotEls = Array.from(root.querySelectorAll('[data-hook^="agenda-slot-"]'))
          .filter((el) => /^agenda-slot-\d+$/.test(el.getAttribute('data-hook') || ''));

        const sessions = slotEls
          .map((slotEl) => {
            const dateTime = slotEl.getAttribute('aria-describedby') || null;
            const time = slotEl
              .querySelector('[data-hook="agenda-slot-time"]')
              ?.textContent?.trim();

            const spotsText = slotEl
              .querySelector('[id^="agenda-slot-spots-left-"], [data-type="agenda-slot-detail-spots-left"]')
              ?.textContent?.trim();

            return {
              dateTime,
              time: time || null,
              spotsText: spotsText || null,
            };
          })
          .filter((s) => s.dateTime || s.time || s.spotsText);

        return { periodLabel: periodLabel || null, sessions };
      });
    },
  },
  acuity: {
    key: 'acuity',
    extractSelector: 'div.monthly-calendar-v2',
    nextSelector: "button[aria-label='Next month']",
    nextSuffix: 'next_month',
    async getPeriodKey(page) {
      return await page.evaluate((extractSelector) => {
        const root = document.querySelector(extractSelector);
        if (!root) return null;

        const caption = root
          .querySelector(
            '.react-calendar__navigation__label__labelText--from, .react-calendar__navigation__label__labelText',
          )
          ?.textContent?.trim();

        const firstTileLabel = root
          .querySelector('.react-calendar__tile abbr[aria-label]')
          ?.getAttribute('aria-label');

        return `${caption || ''}||${firstTileLabel || ''}`;
      }, 'div.monthly-calendar-v2');
    },
    async scrapePeriod(page) {
      const extractSelector = 'div.monthly-calendar-v2';
      await page.waitForSelector(extractSelector, { timeout: 30_000 });

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const end = new Date(today);
      end.setDate(end.getDate() + Math.max(0, DAYS_AHEAD - 1));

      const periodLabel = await page
        .locator(
          `${extractSelector} .react-calendar__navigation__label__labelText--from, ${extractSelector} .react-calendar__navigation__label__labelText`,
        )
        .first()
        .innerText()
        .catch(() => null);

      const activeTileSelector = `${extractSelector} button.react-calendar__tile.activeday:not([disabled])`;
      const fallbackTileSelector = `${extractSelector} button.react-calendar__tile.scheduleday:not([disabled])`;

      let tileSelector = activeTileSelector;
      let tiles = page.locator(tileSelector);
      let count = await tiles.count();
      if (count === 0) {
        tileSelector = fallbackTileSelector;
        tiles = page.locator(tileSelector);
        count = await tiles.count();
      }

      const sessions = [];
      const headingLocator = page.locator("h3:has-text(',')").first();

      for (let i = 0; i < count; i++) {
        const tile = page.locator(tileSelector).nth(i);
        const dateLabel = await tile
          .locator('abbr[aria-label]')
          .getAttribute('aria-label')
          .catch(() => null);

        const isoDate = dateLabel ? toIsoDateFromLongMonthLabel(dateLabel) : null;
        if (!isoDate) continue;
        const d = new Date(`${isoDate}T00:00:00`);
        if (Number.isNaN(d.getTime())) continue;
        if (d < today || d > end) continue;

        const targetHeadingSub = dateLabel
          ? String(dateLabel).replace(/,\s*\d{4}\s*$/, '')
          : null;

        await tile.scrollIntoViewIfNeeded();
        await tile.click({ timeout: 30_000, force: true });

        // allow React to settle / times list to hydrate
        await page.waitForTimeout(150);

        // Wait for the right-side heading to reflect the clicked date (best-effort).
        if (targetHeadingSub) {
          try {
            await page.waitForFunction(
              ({ sub }) => {
                const h = Array.from(document.querySelectorAll('h3')).find((x) =>
                  (x.textContent || '').includes(','),
                );
                const t = h ? (h.textContent || '') : '';
                return t && t.includes(sub);
              },
              { timeout: 10_000 },
              { sub: targetHeadingSub },
            );
          } catch {
            // ignore
          }
        }

        // Wait for either slot buttons to render, or an explicit "no times" message.
        try {
          await page.waitForFunction(
            () => {
              const hasSlots =
                document.querySelectorAll('button.time-selection, button[aria-label*="spots left"], button[aria-label*="spot left"]').length > 0;
              const bodyText = (document.body?.innerText || '').toLowerCase();
              const hasNoTimes =
                bodyText.includes('no times') ||
                bodyText.includes('no appointments') ||
                bodyText.includes('no availability');
              return hasSlots || hasNoTimes;
            },
            { timeout: 10_000 },
          );
        } catch {
          // ignore
        }

        const slotLocatorPreferred = page.locator('button.time-selection[aria-label], button.time-selection');
        const preferredCount = await slotLocatorPreferred.count();
        const slotLocator =
          preferredCount > 0
            ? slotLocatorPreferred
            : page.locator('button[aria-label*="spots left"], .available-times-container button');

        const slotData = await slotLocator.evaluateAll((els) =>
          els
            .map((el) => {
              const aria = el.getAttribute('aria-label') || '';
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              return { aria, text };
            })
            .filter((x) => x.aria || x.text),
        );

        for (const { aria, text } of slotData) {
          const raw = aria || text;
          if (!raw) continue;
          // Common: "11:00, 6 spots left" or button text containing time + spots
          const m = String(raw).match(/(\d{1,2}:\d{2})/);
          const time = m ? m[1] : null;

          let spotsText = null;
          const m2 = String(raw).match(/(\d+\s+spots?\s+left|no\s+spots?\s+left|full)/i);
          if (m2) spotsText = m2[1];
          else spotsText = raw;

          sessions.push({
            dateLabel: dateLabel || null,
            time,
            spotsText: spotsText || null,
          });
        }
      }

      return { periodLabel: periodLabel ? periodLabel.trim() : null, sessions };
    },
  },
};

function getAdapter(siteKey) {
  const key = String(siteKey || '').trim();
  const adapter = SITE_ADAPTERS[key];
  if (!adapter) throw new Error(`Unknown SiteKey: ${key}`);
  return adapter;
}

function normalizeSessions(siteKey, rawSessions) {
  return rawSessions
    .map((s) => {
      if (siteKey === 'wilder') {
        const dateTime = s.dateTime || null;
        const date = dateTime ? String(dateTime).slice(0, 10) : null;
        return {
          date,
          time: s.time || null,
          spotsLeft: parseSpotsLeft(s.spotsText),
          spotsText: s.spotsText || null,
        };
      }

      if (siteKey === 'acuity') {
        const dateLabel = s.dateLabel || null;
        const date = dateLabel ? toIsoDateFromLongMonthLabel(dateLabel) : null;
        return {
          date,
          time: s.time || null,
          spotsLeft: parseSpotsLeft(s.spotsText),
          spotsText: s.spotsText || null,
        };
      }

      return {
        date: s.date || null,
        time: s.time || null,
        spotsLeft: typeof s.spotsLeft === 'number' ? s.spotsLeft : parseSpotsLeft(s.spotsText),
        spotsText: s.spotsText || null,
      };
    })
    .filter((s) => s.date || s.time || s.spotsText);
}

async function tryWaitForPeriodChange(page, sauna, adapter, beforeFragmentHtml) {
  try {
    const beforeKey = adapter.getPeriodKey ? await adapter.getPeriodKey(page) : null;
    if (beforeKey) {
      console.log(`Next period: key before click: ${beforeKey}`);
      console.log('Next period: waiting for period key to change');
      await page.waitForFunction(
        ({ adapterKey, before, extractSelector }) => {
          const root = document.querySelector(extractSelector);
          if (!root) return false;

          if (adapterKey === 'wilder') {
            const caption = root
              .querySelector('[data-hook="caption-text"]')
              ?.textContent?.trim();
            const firstDayHook = root
              .querySelector('[data-hook^="day-availability-"]')
              ?.getAttribute('data-hook');
            const current = `${caption || ''}||${firstDayHook || ''}`;
            return current !== before;
          }

          if (adapterKey === 'acuity') {
            const caption = root
              .querySelector(
                '.react-calendar__navigation__label__labelText--from, .react-calendar__navigation__label__labelText',
              )
              ?.textContent?.trim();
            const firstTileLabel = root
              .querySelector('.react-calendar__tile abbr[aria-label]')
              ?.getAttribute('aria-label');
            const current = `${caption || ''}||${firstTileLabel || ''}`;
            return current !== before;
          }

          return false;
        },
        { timeout: 30_000 },
        {
          adapterKey: adapter.key,
          before: beforeKey,
          extractSelector: adapter.extractSelector,
        },
      );

      const afterKey = adapter.getPeriodKey ? await adapter.getPeriodKey(page) : null;
      console.log(`Next period: key after click: ${afterKey}`);
      console.log('Next period: detected period change via key');
      return;
    }
  } catch {
    // fall through to other strategies
  }

  if (adapter.extractSelector && beforeFragmentHtml) {
    console.log('Next period: waiting for extracted fragment outerHTML to change');
    await page.waitForFunction(
      ({ selector, before }) => {
        const el = document.querySelector(selector);
        return el && el.outerHTML !== before;
      },
      { timeout: 30_000 },
      { selector: adapter.extractSelector, before: beforeFragmentHtml },
    );
    console.log('Next period: detected period change via fragment outerHTML');
    return;
  }

  console.log('Next period: waiting for networkidle as a fallback');
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    // ignore
  }
}

for (let i = 0; i < saunas.length; i++) {
  const sauna = saunas[i];
  const page = await context.newPage();

  const adapter = getAdapter(sauna.siteKey);

  console.log(`Scraping JSON: ${sauna.name} -> ${sauna.url}`);
  await page.goto(sauna.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    // ignore (some sites keep long-polling / analytics connections open)
  }

  let baseName = toSafeFileName(sauna.name) || `sauna_${i + 1}`;
  if (usedNames.has(baseName)) baseName = `${baseName}_${i + 1}`;
  usedNames.add(baseName);

  const result = {
    saunaName: sauna.name,
    url: sauna.url,
    siteKey: adapter.key,
    scrapedAt: new Date().toISOString(),
    periods: [],
    errors: [],
  };

  try {
    const current = await adapter.scrapePeriod(page);
    result.periods.push({
      label: current.periodLabel || null,
      sessions: filterSessionsToNextDays(
        normalizeSessions(adapter.key, current.sessions || []),
        DAYS_AHEAD,
      ),
    });
  } catch (e) {
    const message =
      e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    result.errors.push({ stage: 'scrape_current', message });
  }

  if (adapter.nextSelector) {
    const suffix = adapter.nextSuffix || 'next_period';
    try {
      const beforeFragment = adapter.extractSelector
        ? await page.locator(adapter.extractSelector).evaluate((el) => el.outerHTML)
        : null;
      const beforeKey = adapter.getPeriodKey ? await adapter.getPeriodKey(page) : null;

      const nextButton = page.locator(adapter.nextSelector).first();
      await nextButton.waitFor({ state: 'visible', timeout: 30_000 });
      await nextButton.scrollIntoViewIfNeeded();

      console.log(`Next period: clicking ${adapter.nextSelector}`);
      await nextButton.click({ timeout: 30_000, force: true });

      // Prefer polling the adapter key getter (more reliable than in-page waitForFunction)
      let changed = false;
      if (beforeKey && adapter.getPeriodKey) {
        changed = await waitForPeriodKeyChange({
          page,
          adapter,
          beforeKey,
          timeoutMs: 30_000,
        });
      }

      if (!changed && adapter.extractSelector && beforeFragment) {
        // Fallback: just wait for some DOM churn, but don't fail the scrape if it doesn't happen
        try {
          await page.waitForFunction(
            ({ selector, before }) => {
              const el = document.querySelector(selector);
              return el && el.outerHTML !== before;
            },
            { timeout: 10_000 },
            { selector: adapter.extractSelector, before: beforeFragment },
          );
          changed = true;
        } catch {
          // ignore
        }
      }

      if (!changed) {
        result.errors.push({
          stage: `wait_${suffix}`,
          message: 'Timed out waiting for period key/DOM change; attempting scrape anyway.',
        });
      }

      const next = await adapter.scrapePeriod(page);
      result.periods.push({
        label: next.periodLabel || null,
        sessions: filterSessionsToNextDays(
          normalizeSessions(adapter.key, next.sessions || []),
          DAYS_AHEAD,
        ),
        suffix,
      });
    } catch (e) {
      try {
        const debugPath = path.join(OUTPUT_DIR, `${baseName}_${suffix}_error.png`);
        await page.screenshot({ path: debugPath, fullPage: true });
        console.warn(`Wrote debug screenshot: ${debugPath}`);
      } catch {
        // ignore
      }

      const message =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      result.errors.push({ stage: `scrape_${suffix}`, message });
      console.warn(`Warning: failed to scrape ${suffix} for ${sauna.name}. ${message}`);
    }
  }

  const outPath = path.join(OUTPUT_DIR, `${baseName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Wrote: ${outPath}`);

  await page.close();
}

await browser.close();
