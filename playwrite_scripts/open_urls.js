import { chromium } from 'playwright';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAYS_AHEAD_RAW = Number.parseInt(process.env.DAYS_AHEAD || '', 10);
const DAYS_AHEAD = Number.isFinite(DAYS_AHEAD_RAW) && DAYS_AHEAD_RAW > 0 ? DAYS_AHEAD_RAW : 14;

function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

const TRACE_AWAITS = process.env.TRACE_AWAITS === '1';
let AWAIT_SEQ = 0;

async function tracedAwait(label, fn) {
  if (!TRACE_AWAITS) return await fn();
  const id = ++AWAIT_SEQ;
  const t0 = Date.now();
  console.log(`[await ${id}] ${label}`);
  try {
    const res = await fn();
    console.log(`[await ${id}] done in ${formatMs(Date.now() - t0)}`);
    return res;
  } catch (e) {
    const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    console.log(`[await ${id}] failed in ${formatMs(Date.now() - t0)}: ${msg}`);
    throw e;
  }
}

function toIsoLocalDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseSpotsLeft(text) {
  const t = String(text || "").trim();
  // "3 spots left", "1 spot left"
  const mSpots = t.match(/(\d+)\s+spots?\s+left/i);
  if (mSpots) return Number(mSpots[1]);
  // "3 left", "1 left"
  const mLeft = t.match(/\b(\d+)\s+left\b/i);
  if (mLeft) return Number(mLeft[1]);
  // "3 spaces left", "2 spaces remaining"
  const mSpaces = t.match(
    /\b(\d+)\s+(?:spaces?|seats?|places?)\s+(?:left|remaining|available)\b/i,
  );
  if (mSpaces) return Number(mSpaces[1]);
  // Zero availability
  if (/no\s+spots?\s+left/i.test(t)) return 0;
  if (
    /\b(?:full|sold\s*out|no\s+availability|join\s+waitlist|waitlist)\b/i.test(
      t,
    )
  )
    return 0;
  return null;
}

function normalizeTimeStr(raw) {
  if (!raw) return null;
  const t = String(raw).trim();
  // Already HH:MM
  if (/^\d{1,2}:\d{2}$/.test(t)) {
    const [h, m] = t.split(":");
    return `${String(Number(h)).padStart(2, "0")}:${m}`;
  }
  // 12-hour: "11am", "2pm", "11:30am", "2:30 PM"
  const m12 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (m12) {
    let h = Number(m12[1]);
    const mins = m12[2] ?? "00";
    const ampm = m12[3].toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${mins}`;
  }
  return t;
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
      const location = getCsvField(r, 'location');
      return {
        name: typeof name === 'string' ? name.trim() : String(name ?? '').trim(),
        url: typeof url === 'string' ? url.trim() : String(url ?? '').trim(),
        siteKey:
          typeof siteKey === 'string' ? siteKey.trim() : String(siteKey ?? '').trim(),
        location: location ? String(location).trim() : null,
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
      const startedAt = Date.now();
      const key = await page.evaluate((extractSelector) => {
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
      return key;
    },
    async scrapePeriod(page) {
      const startedAt = Date.now();
      await tracedAwait('[wilder] waitForSelector BookingCalendar-wrapper', () =>
        page.waitForSelector("[data-hook='BookingCalendar-wrapper']", { timeout: 30_000 }),
      );

      const wrapper = page.locator("[data-hook='BookingCalendar-wrapper']").first();
      const wrapperCount = await wrapper.count();

      try {
        const htmlSnippet = await wrapper.evaluate((el) => (el.outerHTML || '').slice(0, 800));
      } catch {
        console.log('[wilder] could not read wrapper outerHTML');
      }

      const captionText = await wrapper
        .locator('[data-hook="caption-text"]')
        .first()
        .innerText()
        .catch(() => null);

      const dayButtons = wrapper.locator('button.rdp-button_reset, button[role="gridcell"], [data-hook^="day-availability-"]');
      const dayCount = await dayButtons.count().catch(() => 0);

      const disabledCount = await wrapper
        .locator('button[disabled], button[aria-disabled="true"]')
        .count()
        .catch(() => 0);

      // After period navigation the wrapper persists, but the agenda content hydrates asynchronously.
      // Best-effort wait to reduce empty-scrape risk.
      const waitSlotsStartedAt = Date.now();
      try {
        await tracedAwait('[wilder] waitForSelector agenda-slot-time', () =>
          page.waitForSelector(
            "[data-hook='BookingCalendar-wrapper'] [data-hook='agenda-slot-time']",
            { timeout: 10_000 },
          ),
        );
      } catch {
      }

      const evalStartedAt = Date.now();
      const res = await page.evaluate(() => {
        const root = document.querySelector("[data-hook='BookingCalendar-wrapper']");
        if (!root) return { periodLabel: null, sessions: [], debug: { hasRoot: false } };

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

        const debug = {
          hasRoot: true,
          slotEls: slotEls.length,
          hasAgendaSlotTime: root.querySelectorAll('[data-hook="agenda-slot-time"]').length,
          hasCaptionText: Boolean(root.querySelector('[data-hook="caption-text"]')),
        };

        return { periodLabel: periodLabel || null, sessions, debug };
      });
      console.log(`[wilder] page.evaluate extracted sessions=${(res.sessions || []).length} in ${formatMs(Date.now() - evalStartedAt)}`);
      if (res && res.debug) console.log(`[wilder] debug: ${JSON.stringify(res.debug)}`);
      console.log(`[wilder] scrapePeriod: done in ${formatMs(Date.now() - startedAt)}`);
      return { periodLabel: res.periodLabel || null, sessions: res.sessions || [] };
    },
  },
  wembury: {
    key: 'wembury',
    extractSelector: "[data-hook='BookingCalendar-wrapper']",
    nextSelector: "[data-hook='next-arrow']",
    nextSuffix: 'next_week',
    async getPeriodKey(page) {
      const startedAt = Date.now();
      const key = await page.evaluate((extractSelector) => {
        const root = document.querySelector(extractSelector);
        if (!root) return null;

        const caption = root
          .querySelector('[data-hook="caption-text"]')
          ?.textContent?.trim();

        const weekText = Array.from(root.querySelectorAll('span[aria-live="polite"]'))
          .map((x) => (x.textContent || '').trim())
          .find(Boolean);

        const dataDates = Array.from(root.querySelectorAll('button[data-date]'))
          .map((b) => b.getAttribute('data-date') || '')
          .filter(Boolean)
          .join(',');

        const selected = root
          .querySelector('[data-hook="selected-date"]')
          ?.textContent?.trim();

        return `${caption || ''}||${weekText || ''}||${selected || ''}||${dataDates || ''}`;
      }, "[data-hook='BookingCalendar-wrapper']");
      console.log(`[wembury] getPeriodKey: ${key || '(null)'} in ${formatMs(Date.now() - startedAt)}`);
      return key;
    },
    async scrapePeriod(page) {
      const startedAt = Date.now();
      console.log('[wembury] scrapePeriod: start');
      await tracedAwait('[wembury] waitForSelector BookingCalendar-wrapper', () =>
        page.waitForSelector("[data-hook='BookingCalendar-wrapper']", { timeout: 30_000 }),
      );

      const wrapper = page.locator("[data-hook='BookingCalendar-wrapper']").first();
      const wrapperCount = await wrapper.count();
      console.log(`[wembury] wrapper count=${wrapperCount}`);

      const captionText = await wrapper
        .locator('[data-hook="caption-text"]')
        .first()
        .innerText()
        .catch(() => null);

      const weekLive = await wrapper
        .locator('span[aria-live="polite"]')
        .first()
        .innerText()
        .catch(() => null);

      console.log(
        `[wembury] header caption=${captionText ? JSON.stringify(captionText.trim()) : '(missing)'} week=${weekLive ? JSON.stringify(weekLive.trim()) : '(missing)'}`,
      );

      const parseDataDateToIso = (raw) => {
        const m = String(raw || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (!m) return null;
        const y = Number(m[1]);
        const monthIndex = Number(m[2]);
        const d = Number(m[3]);
        if (!Number.isFinite(y) || !Number.isFinite(monthIndex) || !Number.isFinite(d)) return null;
        const mm = String(monthIndex + 1).padStart(2, '0');
        const dd = String(d).padStart(2, '0');
        return `${y}-${mm}-${dd}`;
      };

      const days = await wrapper
        .locator('button[data-date]')
        .evaluateAll((els) =>
          els.map((b) => {
            const dataDate = b.getAttribute('data-date') || null;
            const disabled = b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true';
            const hasAvailableDot = Boolean(
              b.querySelector('[data-available="true"]') ||
                b.querySelector('[aria-label="Available Spots"]') ||
                b.querySelector('[data-hook="dot-icon"]'),
            );
            const aria = b.getAttribute('aria-label') || null;
            const ariaSelected = b.getAttribute('aria-selected') || null;
            return { dataDate, disabled, hasAvailableDot, aria, ariaSelected };
          }),
        )
        .catch(() => []);

      const parsedDays = (days || [])
        .map((d) => ({
          ...d,
          iso: d && d.dataDate ? parseDataDateToIso(d.dataDate) : null,
        }))
        .filter((d) => d && d.iso);

      const availableDays = parsedDays.filter((d) => !d.disabled && d.hasAvailableDot);
      console.log(`[wembury] days in view=${parsedDays.length} available(dot+enabled)=${availableDays.length}`);
      if (availableDays.length > 0) {
        console.log(`[wembury] available day isos: ${availableDays.map((d) => d.iso).join(', ')}`);
      }

      const sessions = [];
      const seen = new Set();

      for (let i = 0; i < availableDays.length; i++) {
        const day = availableDays[i];
        const clickStartedAt = Date.now();
        console.log(`[wembury] day ${i + 1}/${availableDays.length}: clicking ${day.iso} (data-date=${day.dataDate})`);

        const dayBtn = wrapper.locator(`button[data-date="${day.dataDate}"]`).first();
        await tracedAwait(`[wembury] day ${i + 1}/${availableDays.length} click`, () =>
          dayBtn.click({ timeout: 10_000, force: true, noWaitAfter: true }),
        );
        console.log(`[wembury] day ${i + 1}/${availableDays.length}: click returned in ${formatMs(Date.now() - clickStartedAt)}`);

        await tracedAwait(`[wembury] day ${i + 1}/${availableDays.length} waitForTimeout(150)`, () =>
          page.waitForTimeout(150),
        );

        try {
          await tracedAwait(`[wembury] day ${i + 1}/${availableDays.length} waitForSelector agenda-slot-time`, () =>
            page.waitForSelector(
              "[data-hook='BookingCalendar-wrapper'] [data-hook='agenda-slot-time']",
              { timeout: 2_000 },
            ),
          );
        } catch {
          // ignore
        }

        const dayEvalStartedAt = Date.now();
        const daySlots = await page.evaluate(() => {
          const root = document.querySelector("[data-hook='BookingCalendar-wrapper']");
          if (!root) return [];
          const slotEls = Array.from(root.querySelectorAll('[data-hook^="agenda-slot-"]'))
            .filter((el) => /^agenda-slot-\d+$/.test(el.getAttribute('data-hook') || ''));

          return slotEls
            .map((slotEl) => {
              const time = slotEl
                .querySelector('[data-hook="agenda-slot-time"]')
                ?.textContent?.trim();
              const spotsText = slotEl
                .querySelector('[id^="agenda-slot-spots-left-"], [data-type="agenda-slot-detail-spots-left"]')
                ?.textContent?.trim();
              return { time: time || null, spotsText: spotsText || null };
            })
            .filter((s) => s.time || s.spotsText);
        });

        console.log(
          `[wembury] day ${i + 1}/${availableDays.length}: extracted ${daySlots.length} slots in ${formatMs(Date.now() - dayEvalStartedAt)}`,
        );

        for (const s of daySlots) {
          const key = `${day.iso}||${s.time || ''}||${s.spotsText || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          sessions.push({ date: day.iso, time: s.time || null, spotsText: s.spotsText || null });
        }
      }

      console.log(`[wembury] scrapePeriod done: sessions=${sessions.length} in ${formatMs(Date.now() - startedAt)}`);
      return { periodLabel: captionText ? captionText.trim() : null, sessions };
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
      const startedAt = Date.now();
      await tracedAwait('[acuity] waitForSelector calendar', () =>
        page.waitForSelector(extractSelector, { timeout: 30_000 }),
      );

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const end = new Date(today);
      end.setDate(end.getDate() + Math.max(0, DAYS_AHEAD - 1));

      console.log(`[acuity] calendar ready (target end=${toIsoLocalDate(end)})`);

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

      console.log(`[acuity] using tile selector: ${tileSelector}`);
      console.log(`[acuity] found ${count} candidate day tiles`);

      const sessions = [];
      const headingLocator = page.locator("h3:has-text(',')").first();

      for (let i = 0; i < count; i++) {
        const tileStartedAt = Date.now();
        const tile = page.locator(tileSelector).nth(i);
        const labelStartedAt = Date.now();
        const dateLabel = await tracedAwait(`[acuity] day ${i + 1}/${count} getAttribute aria-label`, () =>
          tile
            .locator('abbr[aria-label]')
            .getAttribute('aria-label', { timeout: 5_000 })
            .catch(() => null),
        );
        console.log(
          `[acuity] day ${i + 1}/${count}: date label read in ${formatMs(Date.now() - labelStartedAt)}`,
        );

        console.log(`[acuity] day ${i + 1}/${count}: ${dateLabel || '(no label)'}`);

        const isoDate = dateLabel ? toIsoDateFromLongMonthLabel(dateLabel) : null;
        if (!isoDate) {
          console.log(`[acuity] day ${i + 1}/${count}: skip (could not parse date)`);
          continue;
        }
        const d = new Date(`${isoDate}T00:00:00`);
        if (Number.isNaN(d.getTime())) {
          console.log(`[acuity] day ${i + 1}/${count}: skip (invalid date)`);
          continue;
        }
        if (d < today || d > end) {
          console.log(`[acuity] day ${i + 1}/${count}: skip (outside horizon ${isoDate})`);
          if (d > end) {
            console.log(
              `[acuity] day ${i + 1}/${count}: date is after horizon end (${isoDate} > ${toIsoLocalDate(end)}); stopping tile scan`,
            );
            break;
          }
          continue;
        }

        const targetHeadingSub = dateLabel
          ? String(dateLabel).replace(/,\s*\d{4}\s*$/, '')
          : null;

        const scrollStartedAt = Date.now();
        try {
          await tracedAwait(`[acuity] day ${i + 1}/${count} scrollIntoViewIfNeeded`, () =>
            tile.scrollIntoViewIfNeeded({ timeout: 5_000 }),
          );
          console.log(
            `[acuity] day ${i + 1}/${count}: scrolled into view in ${formatMs(Date.now() - scrollStartedAt)}`,
          );
        } catch {
          console.log(
            `[acuity] day ${i + 1}/${count}: scrollIntoViewIfNeeded timed out after ${formatMs(Date.now() - scrollStartedAt)}; continuing`,
          );
        }
        const clickStartedAt = Date.now();
        await tracedAwait(`[acuity] day ${i + 1}/${count} tile.click`, () =>
          tile.click({ timeout: 10_000, force: true, noWaitAfter: true }),
        );
        console.log(
          `[acuity] day ${i + 1}/${count}: clicked in ${formatMs(Date.now() - clickStartedAt)} (iso=${isoDate})`,
        );

        await tracedAwait(`[acuity] day ${i + 1}/${count} waitForTimeout(150)`, () =>
          page.waitForTimeout(150),
        );

        // Wait for the right-side heading to reflect the clicked date (best-effort).
        if (targetHeadingSub) {
          try {
            const headingWaitStartedAt = Date.now();
            await tracedAwait(`[acuity] day ${i + 1}/${count} waitForFunction heading`, () =>
              page.waitForFunction(
                ({ sub }) => {
                  const h = Array.from(document.querySelectorAll('h3')).find((x) =>
                    (x.textContent || '').includes(','),
                  );
                  const t = h ? (h.textContent || '') : '';
                  return t && t.includes(sub);
                },
                { sub: targetHeadingSub },
                { timeout: 2_500 },
              ),
            );
            console.log(
              `[acuity] day ${i + 1}/${count}: heading synced in ${formatMs(Date.now() - headingWaitStartedAt)}`,
            );
          } catch {
            // ignore
          }
        }

        // Wait for either slot buttons to render, or an explicit "no times" message.
        try {
          const slotsWaitStartedAt = Date.now();
          await tracedAwait(`[acuity] day ${i + 1}/${count} waitForFunction slots/no-times`, () =>
            page.waitForFunction(
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
              undefined,
              { timeout: 3_000 },
            ),
          );
          console.log(
            `[acuity] day ${i + 1}/${count}: slots/no-times condition satisfied in ${formatMs(Date.now() - slotsWaitStartedAt)}`,
          );
        } catch {
          // ignore
        }

        const slotQueryStartedAt = Date.now();
        const slotData = await tracedAwait(`[acuity] day ${i + 1}/${count} page.evaluate slot query`, () =>
          page.evaluate(() => {
            const selector =
              'button.time-selection[aria-label], button.time-selection, button[aria-label*="spots left"], button[aria-label*="spot left"], .available-times-container button';
            return Array.from(document.querySelectorAll(selector))
              .map((el) => {
                const aria = el.getAttribute('aria-label') || '';
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                return { aria, text };
              })
              .filter((x) => x.aria || x.text);
          }),
        );
        console.log(
          `[acuity] day ${i + 1}/${count}: slot query returned ${slotData.length} elements in ${formatMs(Date.now() - slotQueryStartedAt)}`,
        );

        const slotParseStartedAt = Date.now();

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

        console.log(
          `[acuity] day ${i + 1}/${count}: parsed ${slotData.length} slot elements in ${formatMs(Date.now() - slotParseStartedAt)}`,
        );

        console.log(
          `[acuity] day ${i + 1}/${count}: extracted ${slotData.length} slots in ${formatMs(Date.now() - tileStartedAt)}`,
        );
      }

      console.log(`[acuity] scrapePeriod done: sessions=${sessions.length} in ${formatMs(Date.now() - startedAt)}`);

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
        await tracedAwait('[acuityWeekly] waitForSelector weekly calendar', () =>
          page.waitForSelector(weeklySelector, { timeout: 5_000 }),
        );
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
        await tracedAwait('[acuityWeekly] frame.waitForSelector weekly calendar', () =>
          frame.waitForSelector(weeklySelector, { timeout: 30_000 }),
        );
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

        try {
          await tracedAwait(`[acuityWeekly] loop ${guard}/8 waitForSelector slot buttons`, () =>
            ctx.waitForSelector(`${weeklySelector} button.time-selection`, { timeout: 10_000 }),
          );
        } catch {
          console.log(
            `[acuityWeekly] loop ${guard}/8: timed out waiting for slot buttons; stopping (range=${rangeNow || '(unknown)'})`,
          );
          break;
        }
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
        const clickStartedAt = Date.now();
        await tracedAwait(`[acuityWeekly] loop ${guard}/8 moreTimes.click`, () =>
          moreTimes.click({ timeout: 10_000, force: true, noWaitAfter: true }),
        );
        console.log(
          `[acuityWeekly] loop ${guard}/8: click More Times returned in ${formatMs(Date.now() - clickStartedAt)}`,
        );

        if (beforeRange) {
          const waitStartedAt = Date.now();
          const deadline = Date.now() + 4_000;
          while (Date.now() < deadline) {
            const current = await ctx
              .locator(weeklySelector)
              .first()
              .getAttribute('aria-label')
              .catch(() => null);
            if (current && current !== beforeRange) break;
            await tracedAwait(`[acuityWeekly] loop ${guard}/8 waitForTimeout(200)`, () =>
              ctx.waitForTimeout(200),
            );
          }
          console.log(
            `[acuityWeekly] loop ${guard}/8: waited ${formatMs(Date.now() - waitStartedAt)} for range label change`,
          );
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
  blackpoolSandsSauna: {
    key: 'blackpoolSandsSauna',
    extractSelector: 'table.calendar-small',
    async scrapePeriod(page) {
      const startedAt = Date.now();
      const sessions = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const cutoff = new Date(Date.now() + DAYS_AHEAD * 86_400_000);

      try {
        const urlMatch = page.url().match(/\/calendar\/(\d{4})\/(\d{2})\//);
        let year = urlMatch ? Number(urlMatch[1]) : today.getFullYear();
        let month = urlMatch ? Number(urlMatch[2]) : today.getMonth() + 1;
        const urlTemplate = page.url().replace(/\/calendar\/\d{4}\/\d{2}\//, '/calendar/YYYY/MM/');

        for (let guard = 0; guard < 3; guard++) {
          const mm = String(month).padStart(2, '0');
          const monthUrl = urlTemplate.replace('YYYY', String(year)).replace('MM', mm);

          if (guard > 0) {
            await tracedAwait(`[blackpoolSandsSauna] goto ${year}-${mm}`, () =>
              page.goto(monthUrl, { waitUntil: 'networkidle', timeout: 30_000 }),
            );
          }

          await tracedAwait('[blackpoolSandsSauna] wait for calendar', () =>
            page.waitForSelector('table.calendar-small', { timeout: 30_000 }),
          );
          await page.waitForTimeout(500);

          // Find available (enabled) day buttons in the current month
          const availableDays = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('table.calendar-small button.calendar-small-day.month-current'));
            const monthNameToNum = {
              January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
              July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
            };
            return btns
              .filter(b => !b.disabled && !b.hasAttribute('disabled'))
              .map((b, idx) => {
                const title = b.getAttribute('title') || b.getAttribute('aria-label') || '';
                // e.g. "Saturday, 18 April 2026"
                const m = title.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
                let iso = null;
                if (m) {
                  const day = Number(m[1]);
                  const mon = monthNameToNum[m[2]];
                  const yr = Number(m[3]);
                  if (mon) {
                    iso = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  }
                }
                return { idx, iso, title };
              })
              .filter(d => d.iso);
          });

          console.log(`[blackpoolSandsSauna] month ${year}-${mm}: ${availableDays.length} available days`);

          for (const day of availableDays) {
            const d = new Date(`${day.iso}T00:00:00`);
            if (d < today || d > cutoff) continue;

            // Click the day button
            const btn = page.locator('table.calendar-small button.calendar-small-day.month-current:not([disabled])').nth(
              availableDays.indexOf(day),
            );
            try {
              await btn.click({ force: true, timeout: 5_000 });
            } catch (err) {
              console.log(`[blackpoolSandsSauna] click failed for ${day.iso}: ${err.message}`);
              continue;
            }

            // Wait for availability list to render
            try {
              await tracedAwait(`[blackpoolSandsSauna] wait for slots ${day.iso}`, () =>
                page.waitForSelector('a[href*="/availability/"]', { timeout: 8_000 }),
              );
            } catch {
              console.log(`[blackpoolSandsSauna] no slots rendered for ${day.iso}`);
              continue;
            }
            await page.waitForTimeout(400);

            const daySlots = await page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a[href*="/availability/"]'));
              const results = [];
              const seen = new Set();
              for (const a of links) {
                const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                // Find nearest container row to get availability text
                let container = a.closest('tr') || a.closest('li') || a.closest('div');
                let containerText = container ? (container.textContent || '').replace(/\s+/g, ' ').trim() : text;
                const key = `${text}|${containerText}`;
                if (seen.has(key)) continue;
                seen.add(key);
                results.push({ linkText: text, containerText });
              }
              return results;
            });

            for (const s of daySlots) {
              // Extract time from link text, e.g. "Saturday, 18 April 2026 @ 12pm" or "12pm"
              const timeMatch = s.linkText.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))/) ||
                                s.linkText.match(/(\d{1,2}:\d{2})/);
              const rawTime = timeMatch ? timeMatch[1] : null;
              sessions.push({
                date: day.iso,
                time: rawTime,
                spotsText: s.containerText,
              });
            }
          }

          // Advance to next month
          month++;
          if (month > 12) { month = 1; year++; }
          if (new Date(year, month - 1, 1) > cutoff) break;
        }
      } catch (err) {
        console.log(`[blackpoolSandsSauna] scrapePeriod error: ${err.message}`);
      }

      console.log(`[blackpoolSandsSauna] scrapePeriod done: ${sessions.length} sessions in ${formatMs(Date.now() - startedAt)}`);
      return { periodLabel: null, sessions };
    },
    normalizeSession(raw) {
      const spotsText = raw.spotsText || null;
      let spotsLeft = parseSpotsLeft(spotsText);
      // Blackpool Sands: "Call to book" or a bare "Open Session" listing
      // (no "X left" / waitlist indicator) means the session is empty / fully
      // available (no bookings yet). Use a large sentinel that the harvest
      // logic clamps to seats_per_session (=> 0 booked, 0% full).
      if (spotsLeft === null && spotsText) {
        const t = String(spotsText);
        const isWaitlist = /\b(?:full|sold\s*out|join\s+waitlist|waitlist)\b/i.test(t);
        const isCallToBook = /call\s+to\s+book/i.test(t);
        const isOpenSession = /open\s+session/i.test(t);
        if (!isWaitlist && (isCallToBook || isOpenSession)) {
          spotsLeft = 9999;
        }
      }
      return {
        date: raw.date || null,
        time: raw.time ? normalizeTimeStr(raw.time) : null,
        spotsLeft,
        spotsText,
      };
    },
  },
  orchardsauna: {
    key: 'orchardsauna',
    extractSelector: 'div.schedulePage',
    nextSelector: 'button[aria-label="Next week"]',
    nextSuffix: 'next_week',
    async getPeriodKey(page) {
      return await page.evaluate(() => {
        const weekElement = document.querySelector('.weeklyCalendar .week-header, .calendar-header .week-range, [class*="week"][class*="header"]');
        return weekElement ? weekElement.textContent.trim() : null;
      });
    },
    async scrapePeriod(page) {
      const startedAt = Date.now();
      await tracedAwait('[orchardsauna] wait for calendar', () =>
        page.waitForSelector('div.schedulePage', { timeout: 30_000 }),
      );

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const cutoff = new Date(Date.now() + DAYS_AHEAD * 86_400_000);

      const periodLabel = await page.evaluate(() => {
        const weekEl = document.querySelector('.weeklyCalendar .week-header, .calendar-header .week-range, [class*="week"][class*="header"]');
        return weekEl ? weekEl.textContent.trim() : null;
      });

      const sessions = await page.evaluate((todayMs, cutoffMs) => {
        const results = [];
        const today = new Date(todayMs);
        const cutoff = new Date(cutoffMs);

        // Find all appointment slots
        const slots = document.querySelectorAll('.appointmentSlot, [class*="appointment"][class*="slot"], .time-slot, [data-appointment-type-id]');
        
        slots.forEach(slot => {
          try {
            // Extract date
            let dateStr = null;
            const dateEl = slot.closest('[data-date]') || slot.querySelector('[data-date]');
            if (dateEl) {
              dateStr = dateEl.getAttribute('data-date');
            } else {
              // Try to find date from day column
              const dayColumn = slot.closest('.day-column, [class*="day"], .calendar-day');
              if (dayColumn) {
                const dayHeader = dayColumn.querySelector('.day-header, [class*="day"][class*="header"], .date-header');
                if (dayHeader) {
                  const dayText = dayHeader.textContent.trim();
                  // This would need more logic to convert to ISO date
                  // For now, skip if we can't determine date
                  return;
                }
              }
            }

            if (!dateStr) return;

            const sessionDate = new Date(dateStr + 'T00:00:00');
            if (sessionDate < today || sessionDate > cutoff) return;

            // Extract time
            let time = null;
            const timeEl = slot.querySelector('.time, [class*="time"], .appointment-time') || slot;
            if (timeEl) {
              const timeText = timeEl.textContent.trim();
              const timeMatch = timeText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?|\d{1,2}\s*(?:AM|PM))/i);
              if (timeMatch) {
                time = timeMatch[1];
              }
            }

            // Extract session title and location
            let sessionTitle = '';
            let location = null;
            const titleEl = slot.querySelector('.appointment-title, .session-title, [class*="title"], .appointmentTitle') || slot;
            if (titleEl) {
              sessionTitle = titleEl.textContent.trim();
              
              // Extract location from title
              if (sessionTitle.includes('Paddock Sauna')) {
                location = 'Paddock Sauna';
              } else if (sessionTitle.includes('Pasture Sauna')) {
                location = 'Pasture Sauna';
              }
            }

            // Extract availability
            let spotsText = null;
            const availEl = slot.querySelector('.spots-left, .availability, [class*="spots"], [class*="available"], .appointment-availability');
            if (availEl) {
              spotsText = availEl.textContent.trim();
            } else {
              // Check if slot has sold out or full indication
              const slotText = slot.textContent.toLowerCase();
              if (slotText.includes('full') || slotText.includes('sold out') || slotText.includes('no spots')) {
                spotsText = 'Full';
              } else if (slotText.includes('spot') || slotText.includes('space') || slotText.includes('left')) {
                const spotMatch = slotText.match(/(\d+)\s*(?:spots?|spaces?)\s*(?:left|available|remaining)/i);
                if (spotMatch) {
                  spotsText = spotMatch[1] + ' spots left';
                }
              }
            }

            if (time) {
              const session = {
                date: dateStr,
                time: time,
                spotsText: spotsText
              };
              
              if (location) {
                session.location = location;
              }
              
              results.push(session);
            }
          } catch (e) {
            console.warn('Error processing slot:', e);
          }
        });

        return results;
      }, today.getTime(), cutoff.getTime());

      console.log(`[orchardsauna] scrapePeriod done: ${sessions.length} sessions in ${formatMs(Date.now() - startedAt)}`);
      return { periodLabel: periodLabel?.trim() ?? null, sessions };
    },
  },
};

// Backwards-compatible aliases (old sauna_info.csv values)
SITE_ADAPTERS.wilder = SITE_ADAPTERS.wilder;

function getAdapter(siteKey) {
  const key = String(siteKey || '').trim();
  const adapter = SITE_ADAPTERS[key];
  if (!adapter) throw new Error(`Unknown SiteKey: ${key}`);
  return adapter;
}

function normalizeSessions(siteKey, rawSessions) {
  const adapter = SITE_ADAPTERS[siteKey];
  if (typeof adapter?.normalizeSession === "function") {
    return rawSessions
      .map((s) => {
        const norm = adapter.normalizeSession(s);
        // Preserve location from raw session if adapter didn't set it
        if (norm && s.location && !norm.location) norm.location = s.location;
        return norm;
      })
      .filter((s) => s && (s.date || s.time || s.spotsText));
  }

  return rawSessions
    .map((s) => {
      const loc = s.location || null;

      if (siteKey === 'wilder' || siteKey === 'wilder' || siteKey === 'wemburyWildSauna') {
        const dateTime = s.dateTime || null;
        const date = dateTime ? String(dateTime).slice(0, 10) : null;
        return {
          date,
          time: s.time || null,
          spotsLeft: parseSpotsLeft(s.spotsText),
          spotsText: s.spotsText || null,
          ...(loc && { location: loc }),
        };
      }

      if (siteKey === 'wembury') {
        const date = s.date || (s.dateTime ? String(s.dateTime).slice(0, 10) : null);
        return {
          date: date || null,
          time: s.time || null,
          spotsLeft: parseSpotsLeft(s.spotsText),
          spotsText: s.spotsText || null,
          ...(loc && { location: loc }),
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
          ...(loc && { location: loc }),
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
          ...(loc && { location: loc }),
        };
      }

      return {
        date: s.date || null,
        time: normalizeTimeStr(s.time),
        spotsLeft:
          typeof s.spotsLeft === "number"
            ? s.spotsLeft
            : parseSpotsLeft(s.spotsText),
        spotsText: s.spotsText || null,
        ...(loc && { location: loc }),
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

          if (adapterKey === 'wilder' || adapterKey === 'wilder' || adapterKey === 'wemburyWildSauna') {
            const caption = root
              .querySelector('[data-hook="caption-text"]')
              ?.textContent?.trim();
            const firstDayHook = root
              .querySelector('[data-hook^="day-availability-"]')
              ?.getAttribute('data-hook');
            const current = `${caption || ''}||${firstDayHook || ''}`;
            return current !== before;
          }

          if (adapterKey === 'wembury') {
            const caption = root
              .querySelector('[data-hook="caption-text"]')
              ?.textContent?.trim();
            const weekText = Array.from(root.querySelectorAll('span[aria-live="polite"]'))
              .map((x) => (x.textContent || '').trim())
              .find(Boolean);
            const dataDates = Array.from(root.querySelectorAll('button[data-date]'))
              .map((b) => b.getAttribute('data-date') || '')
              .filter(Boolean)
              .join(',');
            const selected = root
              .querySelector('[data-hook="selected-date"]')
              ?.textContent?.trim();
            const current = `${caption || ''}||${weekText || ''}||${selected || ''}||${dataDates || ''}`;
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
        {
          adapterKey: adapter.key,
          before: beforeKey,
          extractSelector: adapter.extractSelector,
        },
        { timeout: 30_000 },
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
      { selector: adapter.extractSelector, before: beforeFragmentHtml },
      { timeout: 30_000 },
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

// ── Group saunas by URL to avoid scraping the same page multiple times ─────
const urlGroups = new Map();
for (let i = 0; i < saunas.length; i++) {
  const sauna = saunas[i];
  const key = sauna.url;
  if (!urlGroups.has(key)) urlGroups.set(key, []);
  urlGroups.get(key).push({ ...sauna, _index: i });
}

function filterSessionsByLocation(sessions, locationFilter) {
  if (!locationFilter) return sessions;
  const loc = locationFilter.toLowerCase();
  return sessions.filter((s) => {
    if (!s.location) return false;
    return String(s.location).toLowerCase() === loc;
  });
}

for (const [url, group] of urlGroups) {
  // Use the first sauna's siteKey for the adapter (all saunas sharing a URL must use the same adapter)
  const primarySauna = group[0];
  const adapter = getAdapter(primarySauna.siteKey);
  const page = await context.newPage();
  const urlStartedAt = Date.now();

  const hasLocations = group.some((s) => s.location);
  console.log(`Scraping JSON: ${url} (${group.length} sauna(s)${hasLocations ? ', multi-location' : ''})`);
  console.log(`Scraping JSON: using adapter=${adapter.key}`);

  await tracedAwait(`[main] page.goto ${primarySauna.name}`, () =>
    page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }),
  );
  try {
    await tracedAwait(`[main] waitForLoadState networkidle ${primarySauna.name}`, () =>
      page.waitForLoadState('networkidle', { timeout: 15_000 }),
    );
  } catch {
    // ignore (some sites keep long-polling / analytics connections open)
  }
  console.log(`Scraping JSON: page loaded in ${formatMs(Date.now() - urlStartedAt)}`);

  // Scrape all periods for this URL once
  const allPeriods = [];
  const allErrors = [];

  try {
    const t0 = Date.now();
    const current = await tracedAwait(`[main] adapter.scrapePeriod current (${adapter.key})`, () =>
      adapter.scrapePeriod(page),
    );
    console.log(
      `Scraping JSON: scraped current period in ${formatMs(Date.now() - t0)} (rawSessions=${(current.sessions || []).length})`,
    );
    allPeriods.push({
      label: current.periodLabel || null,
      sessions: filterSessionsToNextDays(
        normalizeSessions(adapter.key, current.sessions || []),
        DAYS_AHEAD,
      ),
    });
    console.log(`Scraping JSON: current period sessions(after normalize/filter)=${allPeriods[0].sessions.length}`);
  } catch (e) {
    const message =
      e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    allErrors.push({ stage: 'scrape_current', message });
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
        try {
          await page.waitForFunction(
            ({ selector, before }) => {
              const el = document.querySelector(selector);
              return el && el.outerHTML !== before;
            },
            { selector: adapter.extractSelector, before: beforeFragment },
            { timeout: 10_000 },
          );
          changed = true;
        } catch {
          // ignore
        }
      }

      if (!changed) {
        allErrors.push({
          stage: `wait_${suffix}`,
          message: 'Timed out waiting for period key/DOM change; attempting scrape anyway.',
        });
      }

      const next = await adapter.scrapePeriod(page);
      console.log(
        `Scraping JSON: scraped ${suffix} period (rawSessions=${(next.sessions || []).length})`,
      );
      allPeriods.push({
        label: next.periodLabel || null,
        sessions: filterSessionsToNextDays(
          normalizeSessions(adapter.key, next.sessions || []),
          DAYS_AHEAD,
        ),
      });
      console.log(
        `Scraping JSON: ${suffix} period sessions(after normalize/filter)=${allPeriods[allPeriods.length - 1].sessions.length}`,
      );
    } catch (e) {
      const message =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      allErrors.push({ stage: `scrape_${suffix}`, message });
      console.warn(`Warning: failed to scrape ${suffix}. ${message}`);
    }
  }

  // Split results into per-sauna JSON files, filtering by location when configured
  for (const sauna of group) {
    let baseName = toSafeFileName(sauna.name) || `sauna_${sauna._index + 1}`;
    if (usedNames.has(baseName)) baseName = `${baseName}_${sauna._index + 1}`;
    usedNames.add(baseName);

    // Filter periods by location if this sauna row has a Location column
    const periods = allPeriods.map((p) => ({
      label: p.label,
      sessions: sauna.location
        ? filterSessionsByLocation(p.sessions, sauna.location)
        : p.sessions,
    }));

    const result = {
      saunaName: sauna.name,
      url: sauna.url,
      siteKey: adapter.key,
      scrapedAt: new Date().toISOString(),
      ...(sauna.location && { location: sauna.location }),
      periods,
      errors: [...allErrors],
    };

    const outPath = path.join(OUTPUT_DIR, `${baseName}.json`);
    const totalSessions = periods.reduce(
      (sum, p) => sum + ((p && p.sessions && Array.isArray(p.sessions) ? p.sessions.length : 0) || 0),
      0,
    );
    console.log(
      `Scraping JSON: writing ${sauna.name}${sauna.location ? ` [${sauna.location}]` : ''} (periods=${periods.length}, sessions=${totalSessions}, errors=${result.errors.length})`,
    );
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`Wrote: ${outPath}`);
  }

  console.log(`Scraping JSON: done for ${url} in ${formatMs(Date.now() - urlStartedAt)}`);
  await page.close();
}

await browser.close();
