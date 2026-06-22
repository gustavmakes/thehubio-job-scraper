#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://thehub.io/jobs';
const DEFAULT_COUNTRIES = [];

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const LINKS_FILE = path.join(OUTPUT_DIR, 'job_links.txt');
const JSONL_FILE = path.join(OUTPUT_DIR, 'thehub_jobs_fulltext.jsonl');
const ERRORS_FILE = path.join(OUTPUT_DIR, 'errors.jsonl');

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'all';
  const opts = {
    command,
    maxPages: null,
    maxJobs: null,
    concurrency: 5,
    slowMs: 700,
    emptyPagesToStop: 3,
    retries: 2,
    pageTimeoutMs: 45000,
    baseUrl: DEFAULT_BASE_URL,
    countries: DEFAULT_COUNTRIES,
    headful: false,
  };

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--max-pages=')) opts.maxPages = Number(arg.split('=')[1]);
    else if (arg.startsWith('--max-jobs=')) opts.maxJobs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--concurrency=')) opts.concurrency = Number(arg.split('=')[1]);
    else if (arg.startsWith('--slow-ms=')) opts.slowMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--empty-pages-to-stop=')) opts.emptyPagesToStop = Number(arg.split('=')[1]);
    else if (arg.startsWith('--url=')) opts.baseUrl = arg.slice('--url='.length);
    else if (arg.startsWith('--retries=')) opts.retries = Number(arg.split('=')[1]);
    else if (arg.startsWith('--page-timeout-ms=')) opts.pageTimeoutMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--countries=')) {
      opts.countries = arg
        .slice('--countries='.length)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (arg === '--headful') opts.headful = true;
  }

  return opts;
}

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(LINKS_FILE)) fs.writeFileSync(LINKS_FILE, '');
  if (!fs.existsSync(JSONL_FILE)) fs.writeFileSync(JSONL_FILE, '');
  if (!fs.existsSync(ERRORS_FILE)) fs.writeFileSync(ERRORS_FILE, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gotoWithRetries(page, url, opts, label) {
  let lastError;
  for (let attempt = 1; attempt <= opts.retries + 1; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.pageTimeoutMs });
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      return;
    } catch (err) {
      lastError = err;
      console.error(`[${label}:retry] ${url} attempt ${attempt}/${opts.retries + 1}: ${err.message}`);
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeCookieText(text) {
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const filtered = lines.filter((line) => {
    const lower = line.toLowerCase();
    if (lower === 'ok') return false;
    if (lower === 'show details') return false;
    if (lower === 'hide details') return false;
    if (lower.includes('we use cookies')) return false;
    if (lower.includes('cookie declaration')) return false;
    if (lower.includes('cookie policy')) return false;
    if (lower.includes('privacy policy')) return false;
    if (lower.includes('necessary cookies')) return false;
    if (lower.includes('marketing cookies')) return false;
    if (lower.includes('statistical cookies')) return false;
    if (lower.includes('unclassified cookies')) return false;
    if (lower.includes('cookieinformation')) return false;
    if (lower.includes('consent date')) return false;
    if (lower.includes('consent id')) return false;
    return true;
  });
  return cleanText(filtered.join('\n'));
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function readScrapedUrls() {
  const urls = new Set();
  const lines = readLines(JSONL_FILE);

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.job_url) urls.add(row.job_url);
    } catch (_) {}
  }

  return urls;
}

function isJobDetailUrl(href) {
  try {
    const url = new URL(href);
    return url.hostname === 'thehub.io' && /^\/jobs\/[a-f0-9]{24}$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function normalizeJobUrl(href) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function buildListingUrl(opts, pageNo) {
  const url = new URL(opts.baseUrl);
  url.searchParams.set('page', String(pageNo));

  for (const country of opts.countries || []) {
    url.searchParams.append('countryCode', country);
  }

  return url.toString();
}

async function dismissCookies(page) {
  const candidates = [
    'OK',
    'Accept all',
    'Accept All',
    'Accept',
    'Only the necessary cookies',
    'Necessary only',
    'Reject all',
  ];

  for (const text of candidates) {
    try {
      const locator = page.getByText(text, { exact: true }).first();
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 750 }).catch(() => false))) {
        await locator.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(300);
        return;
      }
    } catch (_) {}
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 750;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  });
}

async function collectLinksFromPage(page) {
  await autoScroll(page);
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.href));
  return [...new Set(links.filter(isJobDetailUrl).map(normalizeJobUrl))].sort();
}

async function collectJobLinks(opts) {
  ensureOutputDir();

  const existingLinks = new Set(readLines(LINKS_FILE));
  const browser = await chromium.launch({ headless: !opts.headful });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
  });
  const page = await context.newPage();

  let emptyPages = 0;
  let pageNo = 1;

  try {
    while (true) {
      if (opts.maxPages && pageNo > opts.maxPages) break;

      const listingUrl = buildListingUrl(opts, pageNo);
      console.log(`[collect] Page ${pageNo}: ${listingUrl}`);

      try {
        await gotoWithRetries(page, listingUrl, opts, 'collect');
        await dismissCookies(page);
        await page.waitForTimeout(700);

        const pageLinks = await collectLinksFromPage(page);
        const hasNoJobsMessage = await page.locator('text=/No jobs|No results|Nothing found/i').count().catch(() => 0);
        let newCount = 0;

        for (const link of pageLinks) {
          if (!existingLinks.has(link)) {
            existingLinks.add(link);
            fs.appendFileSync(LINKS_FILE, link + '\n');
            newCount += 1;
          }
        }

        console.log(`[collect] Found ${pageLinks.length}, new ${newCount}, total ${existingLinks.size}`);

        // TheHub can keep returning a mostly empty fallback page forever.
        // Near the end of the real results we often see 0-1 repeated job links,
        // so treat pages with very few job detail links as effectively empty.
        // Do NOT stop just because newCount is 0 on normal pages: that would
        // break resuming after a test run where pages 1-3 were already saved.
        const effectivelyEmpty = pageLinks.length < 5 || hasNoJobsMessage > 0;

        if (effectivelyEmpty) emptyPages += 1;
        else emptyPages = 0;

        if (emptyPages >= opts.emptyPagesToStop) {
          console.log(`[collect] Stopping after ${emptyPages} effectively empty pages with fewer than 5 job links.`);
          break;
        }
      } catch (err) {
        console.error(`[collect:error] Page ${pageNo}: ${err.message}`);
        appendJsonl(ERRORS_FILE, {
          stage: 'collect',
          listing_url: listingUrl,
          page: pageNo,
          error: err.message,
          scraped_at: new Date().toISOString(),
        });
      }

      pageNo += 1;
      await sleep(opts.slowMs);
    }
  } finally {
    await browser.close();
  }

  console.log(`[collect] Done. Saved ${existingLinks.size} links to ${LINKS_FILE}`);
  return [...existingLinks].sort();
}

function findBestExternalWebsite(links) {
  const badHostParts = [
    'thehub.io',
    'cookieinformation.com',
    'linkedin.com',
    'facebook.com',
    'instagram.com',
    'twitter.com',
    'x.com',
    'youtube.com',
    'youtu.be',
    'support.apple.com',
    'apps.apple.com',
    'play.google.com',
    'google.com',
    'gstatic.com',
  ];

  for (const href of links) {
    try {
      const url = new URL(href);
      const lowerHref = href.toLowerCase();
      if (badHostParts.some((part) => url.hostname.includes(part))) continue;
      if (lowerHref.includes('privacy')) continue;
      if (lowerHref.includes('cookie')) continue;
      if (lowerHref.includes('terms')) continue;
      if (lowerHref.startsWith('mailto:')) continue;
      return href;
    } catch (_) {}
  }

  return '';
}

async function scrapeJobPage(context, jobUrl, workerId, opts) {
  const page = await context.newPage();

  try {
    await gotoWithRetries(page, jobUrl, opts, 'scrape');
    await dismissCookies(page);
    await page.waitForTimeout(500);
    await autoScroll(page);

    const data = await page.evaluate(() => {
      const pageTitle = document.title || '';
      const h1 = document.querySelector('h1')?.innerText?.trim() || '';
      const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
        .map((el) => el.innerText.trim())
        .filter(Boolean);

      const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href);
      const bodyText = document.body?.innerText || '';

      const text = bodyText;

      function pickLineAfter(label) {
        const lines = bodyText.split('\n').map((line) => line.trim()).filter(Boolean);
        const idx = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
        if (idx >= 0 && lines[idx + 1]) return lines[idx + 1];
        return '';
      }

      return {
        pageTitle,
        h1,
        headings,
        links,
        text,
        company_guess: pickLineAfter('Company') || '',
        location_guess: pickLineAfter('Location') || '',
        job_type_guess: pickLineAfter('Job type') || '',
        deadline_guess: pickLineAfter('Deadline') || '',
      };
    });

    const cleanFullText = removeCookieText(data.text);
    const externalWebsite = findBestExternalWebsite(data.links || []);

    const titleFromPageTitle = cleanText(
      data.pageTitle
        .replace(/\s*\|\s*The Hub\s*$/i, '')
        .replace(/^The Hub\s*\|\s*/i, '')
    );

    const jobTitle = cleanText(data.h1 || titleFromPageTitle || (data.headings || [])[0] || '');

    return {
      job_title: jobTitle,
      job_url: jobUrl,
      company_guess: cleanText(data.company_guess),
      location_guess: cleanText(data.location_guess),
      job_type_guess: cleanText(data.job_type_guess),
      deadline_guess: cleanText(data.deadline_guess),
      external_website_guess: externalWebsite,
      full_text: cleanFullText,
      scraped_at: new Date().toISOString(),
      worker_id: workerId,
    };
  } catch (err) {
    return {
      job_url: jobUrl,
      error: err.message,
      scraped_at: new Date().toISOString(),
      worker_id: workerId,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeJobPages(opts) {
  ensureOutputDir();

  const allLinks = [...new Set(readLines(LINKS_FILE))].sort();
  const scrapedUrls = readScrapedUrls();
  let pending = allLinks.filter((url) => !scrapedUrls.has(url));

  if (opts.maxJobs) pending = pending.slice(0, opts.maxJobs);

  console.log(`[scrape] ${allLinks.length} unique links. ${scrapedUrls.size} already scraped. ${pending.length} to scrape now.`);

  if (pending.length === 0) {
    console.log(`[scrape] Done. Saved JSONL to ${JSONL_FILE}`);
    return;
  }

  const browser = await chromium.launch({ headless: !opts.headful });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
  });

  let cursor = 0;
  let completed = 0;

  async function worker(workerId) {
    while (cursor < pending.length) {
      const idx = cursor++;
      const jobUrl = pending[idx];
      console.log(`[scrape:${workerId}] ${idx + 1}/${pending.length} ${jobUrl}`);

      const row = await scrapeJobPage(context, jobUrl, workerId, opts);
      if (row.error) appendJsonl(ERRORS_FILE, { stage: 'scrape', ...row });
      else appendJsonl(JSONL_FILE, row);

      completed += 1;
      if (completed % 50 === 0 || completed === pending.length) {
        console.log(`[scrape] Progress ${completed}/${pending.length}`);
      }

      await sleep(opts.slowMs);
    }
  }

  try {
    const workerCount = Math.max(1, Math.min(opts.concurrency, pending.length));
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));
  } finally {
    await browser.close();
  }

  console.log(`[scrape] Done. Saved JSONL to ${JSONL_FILE}`);
}

async function main() {
  const opts = parseArgs();
  ensureOutputDir();

  if (!['collect', 'scrape', 'all'].includes(opts.command)) {
    console.error('Usage: node scrape-thehub-jobs.js [collect|scrape|all] [--max-pages=N] [--max-jobs=N] [--concurrency=N] [--slow-ms=N] [--countries=DK,FI,NO,SE,IS] [--url=https://thehub.io/jobs] [--retries=2] [--page-timeout-ms=45000]');
    process.exit(1);
  }

  if (opts.command === 'collect') {
    await collectJobLinks(opts);
  } else if (opts.command === 'scrape') {
    await scrapeJobPages(opts);
  } else {
    await collectJobLinks(opts);
    await scrapeJobPages(opts);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
