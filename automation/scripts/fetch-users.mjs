#!/usr/bin/env node
// Acquisition stage: read per-user daily AI credit usage from the Copilot usage
// metrics reports and save the raw rows as per-day JSON.
// The saved JSON is consumed by transform-users.mjs to build the per-user CSV.
//
// Output contract:
//   - Never print the token or usage rows to stdout.
//   - Only print progress: "YYYY-MM-DD: N rows".
//   - Always save raw JSON to USERS_RAW_DIR/YYYY-MM-DD.json (an array of rows).
//
// Environment variables:
//   AI_USAGE_PAT  (required) token with View Organization Copilot Metrics
//   ORG           (required) target organization login
//   USERS_RAW_DIR (optional) where to save raw JSON; default "./out/raw-users"
//
// Range: one call to the 28-day report covers report_start_day..report_end_day.
// Days of report_end_day's month that fall before report_start_day are fetched
// one at a time from the 1-day report. Days before that month are saved too;
// trimming the CSV to a single month is transform-users.mjs's job.

import fs from 'node:fs/promises';
import path from 'node:path';

const API_VERSION = '2026-03-10';
const USER_AGENT = 'copilot-ai-credits-overview';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Environment variable ${name} is not set.`);
    process.exit(2);
  }
  return v;
}

const pad = (n) => String(n).padStart(2, '0');

// Dates are UTC calendar days throughout: parse and format them through
// Date.UTC/getUTC* only, so the local time zone can never shift a day.
function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDay(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}

function dayRange(fromDay, toDay) {
  const days = [];
  for (let d = parseDay(fromDay); formatDay(d) <= toDay; d = addDays(d, 1)) days.push(formatDay(d));
  return days;
}

// Days of report_end_day's month that the 28-day window does not reach. The
// window's start comes from the API rather than being recomputed, so the count
// stays right whatever length the report covers.
function backfillDays(reportStartDay, reportEndDay) {
  const end = parseDay(reportEndDay);
  const monthStart = formatDay(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)));
  if (reportStartDay <= monthStart) return [];
  return dayRange(monthStart, formatDay(addDays(parseDay(reportStartDay), -1)));
}

function reportUrl(org, pathAndQuery) {
  return `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/${pathAndQuery}`;
}

function fetchReport(url, token) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    },
  });
}

// The report body only carries links; the rows come from pre-signed URLs, which
// reject a request that also sends an Authorization header.
async function downloadRows(body) {
  const links = (body && Array.isArray(body.download_links)) ? body.download_links : [];
  const rows = [];
  for (const link of links) {
    const res = await fetch(link, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`download link returned ${res.status} ${res.statusText}`);
    const text = await res.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) rows.push(JSON.parse(trimmed));
    }
  }
  return rows;
}

function groupByDay(rows) {
  const byDay = new Map();
  for (const r of rows) {
    if (!r || !r.day) continue;
    const day = String(r.day).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  return byDay;
}

async function saveDay(rawDir, day, rows) {
  await fs.writeFile(path.join(rawDir, `${day}.json`), JSON.stringify(rows, null, 2));
}

async function main() {
  const token = required('AI_USAGE_PAT');
  const org = required('ORG');
  const rawDir = process.env.USERS_RAW_DIR || './out/raw-users';

  const latestRes = await fetchReport(reportUrl(org, 'users-28-day/latest'), token);
  // res.ok is true for 204, whose body is empty — branch before parsing it.
  if (latestRes.status === 204) {
    console.log('28-day report has not been generated yet — nothing to fetch.');
    return;
  }
  if (!latestRes.ok) {
    let msg = '';
    try {
      const err = await latestRes.json();
      msg = err && err.message ? ` — ${err.message}` : '';
    } catch {}
    console.error(`28-day report: ${latestRes.status} ${latestRes.statusText}${msg}`);
    console.error('Check the token type and the View Organization Copilot Metrics permission.');
    process.exit(1);
  }

  const body = await latestRes.json();
  const startDay = body.report_start_day;
  const endDay = body.report_end_day;
  if (!startDay || !endDay || !Array.isArray(body.download_links) || body.download_links.length === 0) {
    console.error('28-day report is missing a start day, an end day or download links.');
    process.exit(1);
  }

  await fs.mkdir(rawDir, { recursive: true });

  const backfill = backfillDays(startDay, endDay);
  console.log(`Target: org=${org} report=${startDay}..${endDay} backfill=${backfill.length}`);

  // A day inside the window with no rows is a real "nobody used credits" day, so
  // save it as an empty array. A day that could not be fetched is left absent,
  // which keeps the newest file in the directory equal to the newest report day.
  const byDay = groupByDay(await downloadRows(body));
  let saved = 0;
  for (const day of dayRange(startDay, endDay)) {
    const rows = byDay.get(day) || [];
    await saveDay(rawDir, day, rows);
    saved++;
    console.log(`${day}: ${rows.length} rows`);
  }

  let skipped = 0;
  for (const day of backfill) {
    let rows;
    try {
      const res = await fetchReport(reportUrl(org, `users-1-day?day=${day}`), token);
      // res.ok is true for 204, whose body is empty — branch before parsing it.
      if (res.status === 204) {
        skipped++;
        console.log(`${day}: 204 (report not generated) — skipped`);
        continue;
      }
      if (!res.ok) {
        skipped++;
        console.log(`${day}: ${res.status} ${res.statusText} — skipped`);
        continue;
      }
      rows = groupByDay(await downloadRows(await res.json())).get(day) || [];
    } catch (e) {
      // One backfill day is worth a retry tomorrow, not the whole run.
      skipped++;
      console.log(`${day}: ${e.code || e.name} — skipped`);
      continue;
    }
    await saveDay(rawDir, day, rows);
    saved++;
    console.log(`${day}: ${rows.length} rows`);
  }

  console.log(`\nResult: ${saved} days saved / ${skipped} skipped (raw saved to ${rawDir})`);
}

main().catch((e) => {
  console.error('Unexpected error:', e.message);
  process.exit(1);
});
