import 'dotenv/config';
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const SAUNA_INFO_PATH = path.join(PROJECT_ROOT, 'csvs', 'sauna_info.csv');
const OPEN_URLS_PATH = path.join(PROJECT_ROOT, 'playwrite_scripts', 'open_urls.js');

// Marker that separates SITE_ADAPTERS closing brace from what follows.
// Used to inject new adapter entries.
const ADAPTER_INJECTION_MARKER = '\n};\n\n// Backwards-compatible aliases';

function parseArgs(argv) {
  const args = { url: null, name: null, seats: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--url=')) { args.url = a.slice(6); continue; }
    if (a === '--url') { args.url = argv[++i]; continue; }
    if (a.startsWith('--name=')) { args.name = a.slice(7); continue; }
    if (a === '--name') { args.name = argv[++i]; continue; }
    if (a.startsWith('--seats=')) { args.seats = Number(a.slice(8)); continue; }
    if (a === '--seats') { args.seats = Number(argv[++i]); continue; }
    if (!a.startsWith('--') && !args.url) { args.url = a; continue; }
  }
  return args;
}

async function capturePageContent(url) {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
      // some booking widgets keep long-polling connections open
    }
    // Extra settle time for JS-heavy booking widgets to render
    await page.waitForTimeout(5_000);
    // Scroll to bottom and back to trigger lazy-loaded content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_000);
    await page.evaluate(() => window.scrollTo(0, 0));
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    await page.close();
    return { screenshot, html };
  } finally {
    await browser.close();
  }
}

function getExistingCsvRows() {
  const csv = fs.readFileSync(SAUNA_INFO_PATH, 'utf8');
  const lines = csv.split('\n');
  const keys = new Set();
  const urls = new Set();
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // CSV may have quoted fields; do a simple split on commas for key/url
    const parts = trimmed.split(',');
    if (parts.length >= 2) urls.add(parts[1].trim().replace(/^"|"$/g, ''));
    if (parts.length >= 3) keys.add(parts[2].trim().replace(/^"|"$/g, ''));
  }
  return { keys, urls };
}

function deriveSiteKey(url, existingKeys) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const base = hostname.split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
    let key = base || 'custom';
    let n = 2;
    while (existingKeys.has(key)) key = `${base}${n++}`;
    return key;
  } catch {
    return `custom${Date.now()}`;
  }
}

function buildSystemPrompt(existingAdapterKeys) {
  return `You are an expert Playwright web scraping engineer building adapters for a sauna booking availability tracker. Your adapter will be injected directly into a production codebase and must work correctly on the first attempt.

════════════════════════════════════════════════════════════════
STEP 1 — ANALYSE THE DOM BEFORE WRITING ANY CODE
════════════════════════════════════════════════════════════════

Read the HTML in full. Before writing a single line of adapter code, answer these questions internally:

1. What is the EXACT CSS selector for the booking calendar container?
   → Find it in the HTML. Use the actual class names / IDs / data-attributes you see.
   → A div or section with a clear booking-related class or id is ideal.
   → NEVER invent or guess selectors. If you see class="fh-cal__month-body", use that.

2. How does month/week navigation work?
   A) A "Next" button exists → set nextSelector + nextSuffix, host script clicks it for you.
   B) The URL encodes the period (e.g. /calendar/2026/04/) → do NOT set nextSelector.
      Instead, loop inside scrapePeriod, calling page.goto() with the incremented URL.

3. How are available dates indicated?
   → Look for CSS classes like "available", "active", "has-slots", or non-disabled buttons.
   → Look for data-* attributes that encode the date (data-date="2026-04-18" etc.).

4. After selecting a date, where do time slots appear?
   → Identify the container and the individual slot elements.
   → Find what text/attributes encode the time and the number of spots remaining.

5. What format is the time in? What format is the availability in?
   → Note the exact strings you see in the HTML (e.g. "11am", "2:30 PM", "3 left", "Sold out").
   → Decide whether the built-in helpers cover them (see STEP 3) or a normalizeSession is needed.

════════════════════════════════════════════════════════════════
STEP 2 — ADAPTER CONTRACT
════════════════════════════════════════════════════════════════

The adapter is a JavaScript object literal entry in a const SITE_ADAPTERS = { ... } block.

TypeScript-style interface:
\`\`\`ts
interface Adapter {
  key: string;                         // must equal the object key
  extractSelector?: string;            // CSS selector for the root calendar container
  nextSelector?: string;               // CSS selector for the "next period" button
                                       //   (omit entirely for URL-based navigation)
  nextSuffix?: 'next_week'|'next_month'; // label used in log messages
  getPeriodKey?(page: Page): Promise<string|null>;
    // Returns a string that changes when the visible period changes.
    // Used by the host to detect that a "next" click succeeded.
    // Include this whenever nextSelector is set.
  scrapePeriod(page: Page): Promise<{ periodLabel: string|null, sessions: Session[] }>;
  normalizeSession?(raw: RawSession): NormalizedSession;
    // Optional. Include ONLY when the site uses formats the built-in helpers don't cover.
    // See STEP 3 for exactly what the helpers already handle.
}

interface Session {           // returned by scrapePeriod — raw values are fine here
  date: string|null;          // ISO-8601: "YYYY-MM-DD"
  time: string|null;          // raw: "11am", "2:30 PM", "14:00" — all accepted
  spotsText: string|null;     // raw availability text: "3 left", "Full", "Sold out", etc.
}

interface NormalizedSession { // returned by normalizeSession — must be fully resolved
  date: string|null;
  time: string|null;          // must be "HH:MM" 24-hour after normalization
  spotsLeft: number|null;     // integer or null — call parseSpotsLeft(spotsText)
  spotsText: string|null;
}
\`\`\`

════════════════════════════════════════════════════════════════
STEP 3 — HELPERS AVAILABLE IN SCOPE
════════════════════════════════════════════════════════════════

These are already defined in the file; call them directly:

  tracedAwait(label: string, fn: () => Promise<T>): Promise<T>
    → Wraps an await with timing logs. Use for every waitForSelector / waitForFunction.
    → Example: await tracedAwait('[key] wait for calendar', () => page.waitForSelector('#cal', { timeout: 30_000 }));

  toIsoLocalDate(d: Date): string
    → Returns "YYYY-MM-DD" in local time. Use when constructing ISO dates from JS Date objects.

  parseSpotsLeft(text: string): number|null
    → Already handles ALL of these — do NOT re-implement them:
      "3 spots left"→3 | "3 left"→3 | "2 spaces left"→2 | "2 seats remaining"→2
      "Full"→0 | "Sold out"→0 | "No spots left"→0 | "Join waitlist"→0 | "Waitlist"→0
    → Returns null only for genuinely unrecognised text.

  normalizeTimeStr(text: string): string|null
    → Already handles ALL of these — do NOT re-implement them:
      "10:00"→"10:00" | "9:30"→"09:30"
      "11am"→"11:00" | "2pm"→"14:00" | "11:30am"→"11:30" | "2:30 PM"→"14:30"
    → Returns the input unchanged for formats it doesn't recognise.

  DAYS_AHEAD: number  (default 14)
    → Only include sessions within this many days from today.
    → Filter using: const cutoff = new Date(Date.now() + DAYS_AHEAD * 86_400_000);

  formatMs(ms: number): string
    → "1234" → "1.2s", "450" → "450ms". Use in log messages.

════════════════════════════════════════════════════════════════
STEP 4 — COMPLETE WORKING EXAMPLE (click-a-day pattern)
════════════════════════════════════════════════════════════════

Study this real adapter to understand the expected code style:

\`\`\`javascript
  exampleSite: {
    key: 'exampleSite',
    extractSelector: 'div.booking-calendar',
    nextSelector: "button[aria-label='Next month']",
    nextSuffix: 'next_month',
    async getPeriodKey(page) {
      return await page.evaluate(() => {
        const el = document.querySelector('div.booking-calendar .month-label');
        return el ? el.textContent.trim() : null;
      });
    },
    async scrapePeriod(page) {
      const startedAt = Date.now();
      await tracedAwait('[exampleSite] wait for calendar', () =>
        page.waitForSelector('div.booking-calendar', { timeout: 30_000 }),
      );

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const cutoff = new Date(Date.now() + DAYS_AHEAD * 86_400_000);

      const periodLabel = await page
        .locator('div.booking-calendar .month-label').first().innerText().catch(() => null);

      // Find available day tiles — use ACTUAL class names from the HTML
      const dayTileSelector = 'div.booking-calendar button.day-tile.available:not([disabled])';
      const count = await page.locator(dayTileSelector).count();
      console.log(\`[exampleSite] found \${count} available day tiles\`);

      const sessions = [];

      for (let i = 0; i < count; i++) {
        const tile = page.locator(dayTileSelector).nth(i);
        const dateAttr = await tile.getAttribute('data-date').catch(() => null);
        if (!dateAttr) continue;

        const d = new Date(\`\${dateAttr}T00:00:00\`);
        if (d < today || d > cutoff) continue;

        await tile.click({ force: true });
        await page.waitForTimeout(300);

        // Wait for slots panel — use ACTUAL selector from HTML
        try {
          await tracedAwait('[exampleSite] wait for slots', () =>
            page.waitForSelector('ul.time-slots li.slot', { timeout: 5_000 }),
          );
        } catch { continue; }

        const slots = await page.evaluate((isoDate) => {
          return Array.from(document.querySelectorAll('ul.time-slots li.slot')).map(el => ({
            date: isoDate,
            time: el.querySelector('.slot-time')?.textContent.trim() ?? null,
            spotsText: el.querySelector('.spots')?.textContent.trim() ?? null,
          }));
        }, dateAttr);

        sessions.push(...slots);
      }

      console.log(\`[exampleSite] scrapePeriod done: \${sessions.length} sessions in \${formatMs(Date.now() - startedAt)}\`);
      return { periodLabel: periodLabel?.trim() ?? null, sessions };
    },
  },
\`\`\`

════════════════════════════════════════════════════════════════
STEP 5 — WHEN AND HOW TO WRITE normalizeSession
════════════════════════════════════════════════════════════════

Only add normalizeSession if the site's data uses a format NOT already covered by
parseSpotsLeft / normalizeTimeStr (see STEP 3). Common cases that DO need it:

  • Combined text: a single element contains both time and availability
      e.g. slot.textContent = "11:00 — 3 spaces available"
      The adapter can't split these cleanly; normalizeSession parses the blob.

  • Unusual date formats: the adapter can only extract partial date info
      e.g. day number only, needing the month inferred from URL context.
      (Better to fix in scrapePeriod, but normalizeSession is the fallback.)

  • Platform-specific status strings beyond the known list
      e.g. "Enquire" (unknown availability) → spotsLeft: null
           "Members only" (treat as full) → spotsLeft: 0

Example — site where the slot element mixes time and availability in one string:

\`\`\`javascript
  mySite: {
    key: 'mySite',
    normalizeSession(raw) {
      // raw.spotsText from scrapePeriod = "10:00 AM – 2 places left"
      const timeMatch = (raw.spotsText || '').match(/(\\d{1,2}:\\d{2}\\s*(?:AM|PM)?)/i);
      const time = timeMatch ? normalizeTimeStr(timeMatch[1]) : normalizeTimeStr(raw.time);
      return {
        date: raw.date || null,
        time,
        spotsLeft: parseSpotsLeft(raw.spotsText),
        spotsText: raw.spotsText || null,
      };
    },
    async scrapePeriod(page) { /* ... */ },
  },
\`\`\`

If parseSpotsLeft and normalizeTimeStr already handle the site's formats, OMIT normalizeSession.

════════════════════════════════════════════════════════════════
STEP 7 — URL-BASED PAGINATION EXAMPLE (FareHarbor / similar)
════════════════════════════════════════════════════════════════

When the page URL contains /calendar/YYYY/MM/, paginate by navigating URLs — do NOT set nextSelector:

\`\`\`javascript
  fareharborExample: {
    key: 'fareharborExample',
    // No nextSelector — pagination handled inside scrapePeriod via URL
    async scrapePeriod(page) {
      const sessions = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const cutoff = new Date(Date.now() + DAYS_AHEAD * 86_400_000);

      // Derive starting month from URL, fall back to current month
      const urlMatch = page.url().match(/\\/calendar\\/(\\d{4})\\/(\\d{2})\\//);
      let year  = urlMatch ? Number(urlMatch[1]) : today.getFullYear();
      let month = urlMatch ? Number(urlMatch[2]) : today.getMonth() + 1;

      const baseUrl = page.url().replace(/\\/calendar\\/\\d{4}\\/\\d{2}\\//, '/calendar/YYYY/MM/');

      for (let guard = 0; guard < 3; guard++) {
        // Always navigate to a clean URL for this month to avoid stale state
        const mm = String(month).padStart(2, '0');
        const monthUrl = baseUrl.replace('YYYY', year).replace('MM', mm);
        if (guard > 0) {
          await tracedAwait(\`[fareharborExample] goto \${year}-\${mm}\`, () =>
            page.goto(monthUrl, { waitUntil: 'networkidle', timeout: 30_000 }),
          );
        }

        // Wait for ACTUAL calendar container — find this selector in the HTML
        await tracedAwait('[fareharborExample] wait for calendar', () =>
          page.waitForSelector('div#calendar-container table', { timeout: 20_000 }),
        );

        // Scrape available days for this month...
        const dayData = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('td.available[data-date]')).map(td => ({
            date: td.getAttribute('data-date'),
            // ... extract slots ...
          }));
        });

        for (const d of dayData) {
          const dt = new Date(\`\${d.date}T00:00:00\`);
          if (dt >= today && dt <= cutoff) sessions.push({ date: d.date, time: null, spotsText: null });
        }

        // Advance to next month; stop if already past the cutoff
        month++;
        if (month > 12) { month = 1; year++; }
        if (new Date(year, month - 1, 1) > cutoff) break;
      }

      return { periodLabel: null, sessions };
    },
  },
\`\`\`

════════════════════════════════════════════════════════════════
STEP 8 — HARD RULES (violating any of these will break production)
════════════════════════════════════════════════════════════════

SELECTORS
✗ WRONG — DO NOT DO THIS:
    page.waitForSelector('.fh-calendar, .calendar, [class*="calendar"]')
    // [class*="calendar"] matches SVG icons with class="icon-calendar" → 66 elements, picks the wrong one

✓ CORRECT:
    page.waitForSelector('div.fh-cal__month-body')  // exact class from the HTML
    page.waitForSelector('#booking-calendar-root')   // ID is always safe
    page.waitForSelector('table[data-component="calendar"]') // specific data attribute

✗ WRONG — standalone attribute substring:
    '[class*="booking"]', '[class*="slot"]', '[class*="calendar"]'

✓ CORRECT — always prefix with a tag name or other qualifier:
    'div[class*="booking"]', 'li[class*="slot"]', 'div[class*="fh-cal"]'

SESSION DATA
✗ WRONG — extra fields:
    { date, time, spotsText, rawHtml, isAvailable }   // extra fields silently break normalisation

✓ CORRECT — only these three:
    { date: 'YYYY-MM-DD', time: 'HH:MM', spotsText: '3 spots left' }

PAGINATION
✗ WRONG — nextSelector on a URL-paginated site:
    nextSelector: 'button.calendar-next'   // button doesn't exist on FareHarbor embed pages

✓ CORRECT — URL pagination:
    // No nextSelector; handle inside scrapePeriod with page.goto()

GENERAL
• Always use tracedAwait() for waitForSelector / waitForFunction / waitForLoadState calls.
• Always wrap the outer body of scrapePeriod in try/catch; log and return empty sessions on failure.
• Log at key milestones: entering scrapePeriod, count of days found, count of sessions extracted.
• Only return sessions within today … today+DAYS_AHEAD. Filter dates before pushing to the array.

════════════════════════════════════════════════════════════════
EXISTING ADAPTERS — reuse if the booking platform matches exactly
════════════════════════════════════════════════════════════════

${[...existingAdapterKeys].map((k) => `- ${k}`).join('\n')}

If the page is served by one of these platforms (same HTML structure, same class names), return
useExistingAdapter=true and adapterCode=null. Otherwise generate new adapter code.
Do NOT return useExistingAdapter=true unless you are certain the existing adapter's selectors
will match this page's DOM.

════════════════════════════════════════════════════════════════
RESPONSE FORMAT
════════════════════════════════════════════════════════════════

Respond with ONLY a valid JSON object. No markdown, no code fences, no prose.

{
  "siteKey": "camelCaseUniqueKey",
  "saunaName": "Human Readable Name (inferred from page title / header)",
  "seatsPerSession": 8,
  "useExistingAdapter": false,
  "adapterCode": "  camelCaseUniqueKey: {\\n    key: 'camelCaseUniqueKey',\\n    ...full adapter code...\\n  },"
}

Rules for adapterCode:
- 2-space indentation throughout
- End with a trailing comma after the closing }
- All inner string quotes use single quotes
- Newlines encoded as \\n in the JSON string
- The code must be syntactically valid ES2022 JavaScript`;
}

function extractJson(text) {
  // Direct parse
  try { return JSON.parse(text.trim()); } catch {}
  // Strip markdown fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) try { return JSON.parse(fenced[1].trim()); } catch {}
  // Find outermost { }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  throw new Error(`Cannot parse Claude response as JSON.\n\nRaw response:\n${text}`);
}

async function askClaude(url, siteKey, html, screenshot, existingAdapterKeys) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  const client = new Anthropic();
  const maxHtml = 80_000;
  const truncatedHtml =
    html.length > maxHtml
      ? `${html.slice(0, maxHtml / 2)}\n\n...[HTML truncated]...\n\n${html.slice(-maxHtml / 2)}`
      : html;

  console.log(`Sending ${Math.round(truncatedHtml.length / 1024)}KB HTML + screenshot to Claude...`);

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8_000,
    system: [
      {
        type: 'text',
        text: buildSystemPrompt(existingAdapterKeys),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyse this booking page and generate a scraper adapter.\n\nURL: ${url}\nSuggested siteKey: ${siteKey}\n\nPage HTML:\n${truncatedHtml}`,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshot.toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Based on the HTML and screenshot above, produce the JSON response.',
          },
        ],
      },
    ],
  });

  const raw = response.content.find((c) => c.type === 'text')?.text ?? '';
  return extractJson(raw);
}

function adapterKeyExists(siteKey) {
  const content = fs.readFileSync(OPEN_URLS_PATH, 'utf8');
  // Match the key as a top-level property of SITE_ADAPTERS, e.g. `  wilder: {`
  return new RegExp(`^\\s{2}${siteKey}\\s*:\\s*\\{`, 'm').test(content);
}

function injectAdapter(adapterCode) {
  const content = fs.readFileSync(OPEN_URLS_PATH, 'utf8');
  const idx = content.indexOf(ADAPTER_INJECTION_MARKER);
  if (idx === -1) {
    throw new Error(
      `Could not locate SITE_ADAPTERS injection point in ${OPEN_URLS_PATH}.\n` +
        `Expected to find: ${JSON.stringify(ADAPTER_INJECTION_MARKER)}`,
    );
  }
  // Insert the adapter code just before the closing `};` of SITE_ADAPTERS
  const updated = `${content.slice(0, idx)}\n${adapterCode}${content.slice(idx)}`;
  fs.writeFileSync(OPEN_URLS_PATH, updated, 'utf8');
}

function appendCsvRow(name, url, siteKey, seats) {
  // Quote fields that contain commas
  const quote = (v) => (String(v).includes(',') ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const line = `\n${quote(name)},${quote(url)},${quote(siteKey)},${quote(seats)}`;
  fs.appendFileSync(SAUNA_INFO_PATH, line, 'utf8');
}

// ── main ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (!args.url) {
  console.error(
    'Usage: node scripts/generate_scraper.js <url> [--name=<name>] [--seats=<n>]\n' +
      'ANTHROPIC_API_KEY must be set in the environment.',
  );
  process.exit(1);
}

console.log(`\nGenerating scraper for: ${args.url}`);

const { keys: existingKeys, urls: existingUrls } = getExistingCsvRows();

if (existingUrls.has(args.url)) {
  console.warn(`Warning: URL already exists in sauna_info.csv. Continuing anyway.`);
}

const suggestedKey = deriveSiteKey(args.url, existingKeys);

const { screenshot, html } = await capturePageContent(args.url);
console.log(`Captured page: ${Math.round(html.length / 1024)}KB HTML, ${Math.round(screenshot.length / 1024)}KB screenshot`);

const result = await askClaude(args.url, suggestedKey, html, screenshot, existingKeys);

const finalSiteKey = String(result.siteKey || suggestedKey).trim();
const finalName = args.name || String(result.saunaName || 'Unknown Sauna').trim();
const finalSeats = args.seats || Number(result.seatsPerSession) || 8;
let usingExisting = Boolean(result.useExistingAdapter);

// Guard: Claude sometimes claims an existing adapter for a platform it doesn't recognise.
// Verify the key actually exists in open_urls.js before trusting it.
if (usingExisting && !adapterKeyExists(finalSiteKey)) {
  console.error(
    `\nError: Claude said to reuse existing adapter '${finalSiteKey}' but that key does not exist in SITE_ADAPTERS.\n` +
      `Re-run the command — Claude should generate a new adapter this time.`,
  );
  process.exit(1);
}

console.log(`\nResult:`);
console.log(`  Name:          ${finalName}`);
console.log(`  SiteKey:       ${finalSiteKey}`);
console.log(`  Seats:         ${finalSeats}`);
console.log(`  Adapter:       ${usingExisting ? `reusing existing '${finalSiteKey}'` : 'new (generated)'}`);

if (!usingExisting) {
  if (!result.adapterCode || typeof result.adapterCode !== 'string') {
    console.error('Claude did not return adapter code. Cannot continue.');
    process.exit(1);
  }
  console.log('\nInjecting adapter into open_urls.js...');
  injectAdapter(result.adapterCode);
  console.log('Done.');
}

console.log('Appending row to sauna_info.csv...');
appendCsvRow(finalName, args.url, finalSiteKey, finalSeats);
console.log('Done.');

console.log(`\nAll set. Test it with:`);
console.log(`  npm run scrape:booking-data -- --sauna="${finalName}"`);
