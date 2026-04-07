import { chromium } from 'playwright';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAYS_AHEAD = 10;

function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function toIsoLocalDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
const PROJECT_ROOT = path.join(__dirname, '..');
const SAUNA_INFO_PATH = path.join(PROJECT_ROOT, 'csvs', 'sauna_info.csv');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'temp_websites');

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
  acuityWeekly: {
    key: 'acuityWeekly',
    extractSelector: '#weekly-calendar-region',
    async scrapePeriod(page) {
      const startedAt = Date.now();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const end = new Date(today);
      end.setDate(end.getDate() + Math.max(0, DAYS_AHEAD - 1));
      const targetEndIso = toIsoLocalDate(end);

      const weeklySelector = '#weekly-calendar-region';
      let ctx = page;
      try {
        console.log('[acuityWeekly] waiting for weekly calendar on main page');
        await page.waitForSelector(weeklySelector, { timeout: 5_000 });
        console.log('[acuityWeekly] found weekly calendar on main page');
      } catch {
        console.log('[acuityWeekly] weekly calendar not found on main page; searching for Acuity iframe');
        const findAcuityFrame = () =>
          page
            .frames()
            .find((f) => /acuityscheduling\.com\/schedule\.php/i.test(String(f.url() || '')));

        let frame = findAcuityFrame();
        const deadline = Date.now() + 30_000;
        while (!frame && Date.now() < deadline) {
          await page.waitForTimeout(250);
          frame = findAcuityFrame();
        }
        if (!frame) throw new Error('Could not find Acuity schedule iframe');
        console.log(`[acuityWeekly] using iframe frame url=${frame.url()}`);
        ctx = frame;
        await frame.waitForSelector(weeklySelector, { timeout: 30_000 });
        console.log('[acuityWeekly] found weekly calendar in iframe');
      }

      const periodLabel = await ctx
        .locator(weeklySelector)
        .first()
        .getAttribute('aria-label')
        .catch(() => null);

      console.log(`[acuityWeekly] period: ${periodLabel || '(unknown range)'}`);

      const sessions = [];
      const seen = new Set();

      const monthToNumber = (name) => {
        const n = String(name || '').trim().toLowerCase();
        if (MONTHS[n]) return MONTHS[n];
        const short = n.slice(0, 3);
        const map = {
          jan: 1,
          feb: 2,
          mar: 3,
          apr: 4,
          may: 5,
          jun: 6,
          jul: 7,
          aug: 8,
          sep: 9,
          oct: 10,
          nov: 11,
          dec: 12,
        };
        return map[short] || null;
      };

      const parseIsoFromMonthDay = ({ monthName, day, yearHint }) => {
        const monthNum = monthToNumber(monthName);
        if (!monthNum) return null;
        let year = typeof yearHint === 'number' ? yearHint : today.getFullYear();
        if (today.getMonth() === 11 && monthNum === 1) year += 1;
        const mm = String(monthNum).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        return `${year}-${mm}-${dd}`;
      };

      const parseWeeklyRangeIso = (rangeLabel) => {
        // Example: "Currently showing Apr 10 to Apr 18"
        const raw = String(rangeLabel || '').trim();
        const m = raw.match(/Currently\s+showing\s+([A-Za-z]+)\s+(\d{1,2})\s+to\s+([A-Za-z]+)\s+(\d{1,2})/i);
        if (!m) return { fromIso: null, toIso: null };
        const fromIso = parseIsoFromMonthDay({ monthName: m[1], day: Number(m[2]) });
        let toIso = parseIsoFromMonthDay({ monthName: m[3], day: Number(m[4]) });
        if (fromIso && toIso) {
          // Handle ranges that wrap into the next year.
          const fromMonth = Number(fromIso.slice(5, 7));
          const toMonth = Number(toIso.slice(5, 7));
          if (Number.isFinite(fromMonth) && Number.isFinite(toMonth) && toMonth < fromMonth) {
            const y = Number(toIso.slice(0, 4));
            toIso = `${y + 1}${toIso.slice(4)}`;
          }
        }
        return { fromIso, toIso };
      };

      const parseIsoFromWeeklyAria = (aria) => {
        const parts = String(aria || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        const tail = parts.length > 0 ? parts[parts.length - 1] : null;
        if (!tail) return null;
        const m = tail.match(/^(?:[A-Za-z]+)\s+([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
        if (!m) return null;
        const monthNum = monthToNumber(m[1]);
        if (!monthNum) return null;
        const day = Number(m[2]);
        let year = m[3] ? Number(m[3]) : today.getFullYear();
        if (!m[3] && today.getMonth() === 11 && monthNum === 1) year += 1;
        const mm = String(monthNum).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        return `${year}-${mm}-${dd}`;
      };

      const getMaxSessionDate = () => {
        const dates = sessions
          .map((s) => (s && typeof s === 'object' ? s.date : null))
          .filter(Boolean)
          .sort();
        return dates.length > 0 ? dates[dates.length - 1] : null;
      };

      let guard = 0;
      while (guard < 8) {
        guard++;

        const loopStartedAt = Date.now();
        const rangeNow = await ctx
          .locator(weeklySelector)
          .first()
          .getAttribute('aria-label')
          .catch(() => null);

        const { fromIso: rangeFromIso, toIso: rangeToIso } = parseWeeklyRangeIso(rangeNow);
        if (rangeFromIso) {
          const rangeFromDate = new Date(`${rangeFromIso}T00:00:00`);
          if (!Number.isNaN(rangeFromDate.getTime()) && rangeFromDate > end) {
            console.log(
              `[acuityWeekly] loop ${guard}/8: range starts after target end (${rangeFromIso} > ${targetEndIso}); stopping pagination`,
            );
            break;
          }
        }

        console.log(
          `[acuityWeekly] loop ${guard}/8: range=${rangeNow || '(unknown)'} (target end=${targetEndIso})`,
        );

        await ctx.waitForSelector(`${weeklySelector} button.time-selection`, { timeout: 30_000 });
        const slotLocator = ctx.locator('button.time-selection[aria-label], button.time-selection');
        const slotData = await slotLocator.evaluateAll((els) =>
          els
            .map((el) => {
              const aria = el.getAttribute('aria-label') || '';
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              return { aria, text };
            })
            .filter((x) => x.aria || x.text),
        );

        console.log(`[acuityWeekly] loop ${guard}/8: found ${slotData.length} slot buttons`);

        const beforeCount = sessions.length;

        for (const { aria, text } of slotData) {
          const raw = aria || text;
          if (!raw) continue;
          const m = String(raw).match(/(\d{1,2}:\d{2})/);
          const time = m ? m[1] : null;

          const isoDate = parseIsoFromWeeklyAria(raw);
          if (isoDate) {
            const d = new Date(`${isoDate}T00:00:00`);
            if (!Number.isNaN(d.getTime()) && (d < today || d > end)) continue;
          }

          let spotsText = null;
          const m2 = String(raw).match(/(\d+\s+spots?\s+left|no\s+spots?\s+left|full)/i);
          if (m2) spotsText = m2[1];
          else spotsText = raw;

          const key = `${isoDate || ''}||${time || ''}||${spotsText || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);

          sessions.push({
            date: isoDate || null,
            time,
            spotsText: spotsText || null,
          });
        }

        const added = sessions.length - beforeCount;
        console.log(
          `[acuityWeekly] loop ${guard}/8: added ${added} sessions (total=${sessions.length}) in ${formatMs(Date.now() - loopStartedAt)}`,
        );

        const maxIso = getMaxSessionDate();
        const maxDate = maxIso ? new Date(`${maxIso}T00:00:00`) : null;
        if (maxDate && !Number.isNaN(maxDate.getTime()) && maxDate >= end) break;

        const moreTimes = ctx.locator("button[aria-label='More Times']").first();
        const canMore = (await moreTimes.count()) > 0;
        if (!canMore) break;

        const beforeRange = await ctx
          .locator(weeklySelector)
          .first()
          .getAttribute('aria-label')
          .catch(() => null);

        console.log(`[acuityWeekly] loop ${guard}/8: clicking More Times (before=${beforeRange || 'unknown'})`);
        await moreTimes.click({ timeout: 30_000, force: true });
        if (beforeRange) {
          try {
            await ctx.waitForFunction(
              ({ selector, before }) => {
                const el = document.querySelector(selector);
                const after = el ? el.getAttribute('aria-label') : null;
                return Boolean(after) && after !== before;
              },
              { timeout: 15_000 },
              { selector: weeklySelector, before: String(beforeRange) },
            );
          } catch {
            // ignore
          }
        }

        const afterRange = await ctx
          .locator(weeklySelector)
          .first()
          .getAttribute('aria-label')
          .catch(() => null);
        console.log(`[acuityWeekly] loop ${guard}/8: after More Times: ${afterRange || 'unknown'}`);

        const { fromIso: afterFromIso } = parseWeeklyRangeIso(afterRange);
        if (afterFromIso) {
          const afterFromDate = new Date(`${afterFromIso}T00:00:00`);
          if (!Number.isNaN(afterFromDate.getTime()) && afterFromDate > end) {
            console.log(
              `[acuityWeekly] loop ${guard}/8: next range starts after target end (${afterFromIso} > ${targetEndIso}); stopping pagination`,
            );
            break;
          }
        }
      }

      console.log(`[acuityWeekly] scrapePeriod done: sessions=${sessions.length} in ${formatMs(Date.now() - startedAt)}`);
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

      if (siteKey === 'acuityWeekly') {
        const dateLabel = s.dateLabel || null;
        const date = s.date || (dateLabel ? toIsoDateFromLongMonthLabel(dateLabel) : null);
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

  const saunaStartedAt = Date.now();
  const adapter = getAdapter(sauna.siteKey);

  console.log(`Scraping JSON: ${sauna.name} -> ${sauna.url}`);
  console.log(`Scraping JSON: using adapter=${adapter.key}`);
  await page.goto(sauna.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    // ignore (some sites keep long-polling / analytics connections open)
  }
  console.log(`Scraping JSON: page loaded in ${formatMs(Date.now() - saunaStartedAt)}`);

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
    const t0 = Date.now();
    const current = await adapter.scrapePeriod(page);
    console.log(
      `Scraping JSON: scraped current period in ${formatMs(Date.now() - t0)} (rawSessions=${(current.sessions || []).length})`,
    );
    result.periods.push({
      label: current.periodLabel || null,
      sessions: filterSessionsToNextDays(
        normalizeSessions(adapter.key, current.sessions || []),
        DAYS_AHEAD,
      ),
    });
    console.log(`Scraping JSON: current period sessions(after normalize/filter)=${result.periods[0].sessions.length}`);
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
      console.log(
        `Scraping JSON: scraped ${suffix} period (rawSessions=${(next.sessions || []).length})`,
      );
      result.periods.push({
        label: next.periodLabel || null,
        sessions: filterSessionsToNextDays(
          normalizeSessions(adapter.key, next.sessions || []),
          DAYS_AHEAD,
        ),
      });
      console.log(
        `Scraping JSON: ${suffix} period sessions(after normalize/filter)=${result.periods[result.periods.length - 1].sessions.length}`,
      );
    } catch (e) {
      const message =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      result.errors.push({ stage: `scrape_${suffix}`, message });
      console.warn(`Warning: failed to scrape ${suffix} for ${sauna.name}. ${message}`);
    }
  }

  const outPath = path.join(OUTPUT_DIR, `${baseName}.json`);
  const totalSessions = result.periods.reduce(
    (sum, p) => sum + ((p && p.sessions && Array.isArray(p.sessions) ? p.sessions.length : 0) || 0),
    0,
  );
  console.log(
    `Scraping JSON: writing output file (periods=${result.periods.length}, sessions=${totalSessions}, errors=${result.errors.length})`,
  );
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Wrote: ${outPath}`);
  console.log(`Scraping JSON: done in ${formatMs(Date.now() - saunaStartedAt)}`);

  await page.close();
}

await browser.close();
