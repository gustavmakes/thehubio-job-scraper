# TheHub.io Jobs Scraper

A small Playwright-based scraper for collecting job posting URLs from TheHub.io and extracting the visible text from each job page.

## What it does

1. Opens paginated TheHub.io job listing pages
2. Collects job posting URLs matching `/jobs/{id}`
3. Deduplicates links
4. Visits each job page
5. Extracts visible page text and basic metadata
6. Saves results locally as JSONL
7. Supports resumable scraping if the process stops or crashes

## Installation

```bash
npm install
npx playwright install chromium
```

## Test run

```bash
npm run test
```

The test run collects a few listing pages and scrapes a small number of job postings.

## Collect job links only

```bash
node scrape-thehub-jobs.js collect
```

You can limit pages:

```bash
node scrape-thehub-jobs.js collect --max-pages=40
```

## Full run

```bash
node scrape-thehub-jobs.js all --concurrency=5 --slow-ms=700
```

For a slower, gentler run:

```bash
node scrape-thehub-jobs.js all --concurrency=3 --slow-ms=1500
```

## Country filter

You can filter by country codes:

```bash
node scrape-thehub-jobs.js all --countries=DK,FI,NO,SE,IS --concurrency=5 --slow-ms=700
```

## Output

The scraper writes local files to:

```text
output/job_links.txt
output/thehub_jobs_fulltext.jsonl
output/errors.jsonl
```

These files are intentionally ignored by Git and should not be committed.

Each JSONL record contains fields similar to:

```json
{
  "title": "Example role",
  "job_url": "https://thehub.io/jobs/example-id",
  "company": "Example company",
  "location": "Copenhagen",
  "full_text": "Visible text from the page...",
  "scraped_at": "2026-06-22T00:00:00.000Z"
}
```

## Resume behavior

The scraper appends successful results to `output/thehub_jobs_fulltext.jsonl`.

If it stops midway, run the same command again. Already-scraped job URLs are skipped.

If some pages fail, they are written to `output/errors.jsonl`. You can retry by clearing that file and running the scraper again:

```bash
: > output/errors.jsonl
node scrape-thehub-jobs.js all --concurrency=3 --slow-ms=1500
```

## GitHub sharing

This repository should include only the scraper code and documentation.

Do not commit:

```text
output/
node_modules/
*.jsonl
*.csv
job_links.txt
errors.jsonl
```

## Responsible use

This project is intended for personal research and educational use.

Please respect TheHub.io's terms, robots.txt, and rate limits. Do not use aggressive concurrency. Do not republish scraped data without permission.

## License

MIT
