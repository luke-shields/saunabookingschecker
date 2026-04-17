# Sauna Bookings Checker

This repo scrapes sauna booking sites (via Playwright), stores observations in SQLite, and generates simple rollup metrics.

## Prerequisites

- Node.js (recommended: use `nvm` and the version in `.nvmrc`)
- npm
- Playwright browser (Chromium)
- (Recommended) GitHub CLI (`gh`) for triggering the GitHub Action from a VS Code task
- Anthropic API key (only required for `generate:scraper`)

### Install GitHub CLI (optional)

- Install instructions: https://cli.github.com/
- macOS (Homebrew):

```bash
brew install gh
```
- After install:

```bash
gh auth login
```

## Environment variables

Create a `.env` file in the project root (copied from `.env.example`):

```bash
cp .env.example .env
```

Then fill in your values:

```dotenv
# Required for the scraper generator (generate:scraper).
# Get your key at https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-...
```

The `.env` file is git-ignored and only loaded by `generate:scraper`. All other scripts work without it.

## Setup

### VS Code (recommended)

Run the task:

- `Sauna: setup (install deps + Playwright Chromium)`

If `gh` is missing and you have Homebrew installed, this task will also install GitHub CLI automatically.

This runs:

- `npm ci`
- `npx playwright install chromium`

### Manual setup

```bash
npm ci
npx playwright install chromium
```

## Running locally

### Full pipeline

```bash
npm run update
```

This runs:

- sync opening times CSVs into SQLite
- scrape booking data into `temp_websites/*.json`
- harvest scraped data into `sauna_bookings.sqlite`

### Individual steps

- Sync CSVs into SQLite

```bash
npm run sync:csvs
```

- Scrape booking data (writes JSON)

```bash
npm run scrape:booking-data
```

- Harvest JSON into SQLite

```bash
npm run push:bookings:db
```

## GitHub Actions + `data` branch (recommended for DB updates)

The scheduled workflow (`.github/workflows/hourly-update.yml`) writes database updates to a dedicated branch:

- `data`

On every run, the workflow:

- Resets `data` to match the repo default branch (usually `main`)
- Runs the update pipeline
- Commits **only** `sauna_bookings.sqlite`

This keeps `data` up to date with `main` in terms of code/config, while avoiding constant divergence on your development branches.

### Pull the latest DB without switching branches

To update only the DB file in your current branch/working tree:

```bash
git fetch origin data
git checkout origin/data -- sauna_bookings.sqlite
```

### Trigger the workflow from VS Code

Run the task:

- `Sauna: update via GitHub Action + pull DB from data branch`

Notes:

- Requires `gh` installed + authenticated (`gh auth login`).
- The task triggers the workflow, waits for it to finish, then pulls only `sauna_bookings.sqlite` from `origin/data`.

## Repo data inputs

- Sauna metadata:
  - `csvs/sauna_info.csv`
- Expected opening times (weekly):
  - `csvs/opening_times_weekly.csv`
- Date overrides:
  - `csvs/opening_times_override.csv`

## Generating weekly opening times (automatic)

This repo can generate a suggested `opening_times_weekly.csv` by scraping the next ~3 weeks of availability.

Rule used:

- For each sauna + weekday + start time, if that time appears in **at least 2 of the next 3 weeks**, it is treated as a weekly session.

Output:

- `csvs/generated_opening_times_weekly.csv`

Run:

```bash
npm run generate:opening-times-weekly
```

Or from VS Code:

- `Sauna: generate opening times weekly (3-week heuristic)`

## Generating a scraper for a new site

Provide a booking page URL and the script will use Claude to automatically generate a Playwright adapter, then register the site in `csvs/sauna_info.csv`.

### VS Code

Run the task:

- `Sauna: generate scraper from URL`

You will be prompted for the URL (required), sauna name, and seats per session (both optional — Claude infers them from the page if left blank).

### CLI

```bash
npm run generate:scraper -- <url>

# with optional overrides
npm run generate:scraper -- <url> --name="My Sauna" --seats=8
```

Requires `ANTHROPIC_API_KEY` to be set (see [Environment variables](#environment-variables) above).

### What it does

1. Visits the URL with a headless Chromium browser and waits for the booking widget to render.
2. Sends the page HTML and a screenshot to Claude.
3. If the page uses a known platform (e.g. Acuity Scheduling, Wix Bookings), the existing adapter is reused.
4. Otherwise Claude generates a new Playwright adapter and injects it into `playwrite_scripts/open_urls.js`.
5. Appends a new row to `csvs/sauna_info.csv`.

After running, test the new scraper with:

```bash
npm run scrape:booking-data -- --sauna="My Sauna"
```

## Outputs

- SQLite DB:
  - `sauna_bookings.sqlite`
- Scraped JSON (local runs):
  - `temp_websites/*.json`

## Troubleshooting

### `gh: command not found`

Install GitHub CLI:

- https://cli.github.com/

Then authenticate:

```bash
gh auth login
```

### Playwright browser missing

If scraping fails due to missing browser binaries:

```bash
npx playwright install chromium
```
