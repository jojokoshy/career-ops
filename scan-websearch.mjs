#!/usr/bin/env node

/**
 * scan-websearch.mjs — WebSearch-powered job scanner
 *
 * Covers companies that don't expose Greenhouse/Ashby/Lever APIs
 * (Google Cloud, AWS, Microsoft, Salesforce, etc.) by running
 * `claude -p` with Haiku to perform web searches.
 *
 * Complements scan.mjs — run both for full coverage.
 * Approximate cost: ~$0.08/run on Haiku.
 *
 * Usage:
 *   node scan-websearch.mjs                  # scan all websearch companies
 *   node scan-websearch.mjs --dry-run        # preview without writing files
 *   node scan-websearch.mjs --company Google # scan one company
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const MODEL = 'haiku';
const CONCURRENCY = 3;
const CLAUDE_TIMEOUT_MS = 60_000;

mkdirSync('data', { recursive: true });

// ── Filters (mirrors scan.mjs) ──────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const include = (locationFilter.include || []).map(k => k.toLowerCase());
  const exclude = (locationFilter.exclude || []).map(k => k.toLowerCase());
  return (location) => {
    if (!location) return true;
    const lower = location.toLowerCase();
    if (exclude.length > 0 && exclude.some(k => lower.includes(k))) return false;
    if (include.length === 0) return true;
    return include.some(k => lower.includes(k));
  };
}

// ── Dedup (mirrors scan.mjs) ────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf-8').matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(m[1]);
    }
  }
  if (existsSync(APPLICATIONS_PATH)) {
    for (const m of readFileSync(APPLICATIONS_PATH, 'utf-8').matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(m[0]);
    }
  }
  return seen;
}

// ── Pipeline / history writers (mirrors scan.mjs) ──────────────────

function appendToPipeline(offers) {
  if (!offers.length) return;
  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\twebsearch\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Claude runner ───────────────────────────────────────────────────

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--model', MODEL], {
      timeout: CLAUDE_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.slice(0, 300) || `exit code ${code}`));
    });
    proc.on('error', reject);
  });
}

function extractJobs(output, fallbackCompany) {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(j => j && typeof j.title === 'string' && typeof j.url === 'string')
      .map(j => ({
        title: j.title.trim(),
        company: (j.company || fallbackCompany).trim(),
        url: j.url.trim(),
        location: (j.location || '').trim(),
      }));
  } catch {
    return [];
  }
}

// ── Per-company search ──────────────────────────────────────────────

async function searchCompany(company) {
  const prompt =
    `You are a job listing extractor. Use the WebSearch tool to search for current job openings.\n\n` +
    `Search query: ${company.scan_query}\n\n` +
    `Extract job postings from the search results and return them as a JSON array.\n` +
    `Each object must have exactly these fields:\n` +
    `  { "title": string, "company": string, "url": string, "location": string }\n` +
    `Rules:\n` +
    `- url must be a direct link to the specific job posting (not a homepage or search page)\n` +
    `- location is the job location as shown in the posting (e.g. "Singapore", "Remote")\n` +
    `- LOCATION FILTER (STRICT): Only include jobs where the location is clearly one of: Singapore, APAC, Asia Pacific, Asia-Pacific, Remote, Global, or Worldwide. If the location is a city/country outside this list (e.g. USA, London, Berlin, Sydney) or cannot be determined at all, SKIP that job — do not include it.\n` +
    `- If no qualifying jobs are found, return []\n` +
    `Return ONLY the JSON array, no other text.`;

  const output = await runClaude(prompt);
  return extractJobs(output, company.name);
}

// ── Parallel execution ──────────────────────────────────────────────

async function parallelRun(tasks, limit) {
  let i = 0;
  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found.');
    process.exit(1);
  }

  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  const targets = (config.tracked_companies || [])
    .filter(c => c.enabled !== false && c.scan_method === 'websearch' && c.scan_query)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));

  if (targets.length === 0) {
    console.log('No websearch companies configured in portals.yml.');
    process.exit(0);
  }

  console.log(`WebSearch scan — ${targets.length} companies (model: ${MODEL})`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const seenUrls = loadSeenUrls();
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    try {
      const jobs = await searchCompany(company);
      totalFound += jobs.length;
      for (const job of jobs) {
        if (!titleFilter(job.title)) { totalFiltered++; continue; }
        if (!locationFilter(job.location)) { totalFiltered++; continue; }
        if (seenUrls.has(job.url)) { totalDupes++; continue; }
        seenUrls.add(job.url);
        newOffers.push(job);
      }
      process.stdout.write('.');
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
      process.stdout.write('x');
    }
  });

  await parallelRun(tasks, CONCURRENCY);
  console.log('\n');

  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  console.log(`${'━'.repeat(45)}`);
  console.log(`WebSearch Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies searched:    ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered out:          ${totalFiltered}`);
  console.log(`Duplicates skipped:    ${totalDupes}`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.company}: ${e.error}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
