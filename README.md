# Sauna Bookings Checker

This repo scrapes sauna booking sites (via Playwright), stores observations in SQLite, and generates simple rollup metrics.

## Prerequisites

- Node.js (recommended: use `nvm` and the version in `.nvmrc`)
- npm
- Playwright browser (Chromium)
- (Recommended) GitHub CLI (`gh`) for triggering the GitHub Action from a VS Code task

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
