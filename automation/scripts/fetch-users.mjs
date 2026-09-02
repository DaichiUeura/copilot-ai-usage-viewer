#!/usr/bin/env node
// Acquisition stage: read per-user daily AI credit usage from the Copilot usage
// metrics reports and save the raw rows as per-day JSON.
// The saved JSON is consumed by transform-users.mjs to build the per-user CSV.
//
// Output contract:
//   - Never print the token or usage rows to stdout.
//   - Only print progress: "YYYY-MM-DD: N rows".
//   - Save raw JSON to USERS_RAW_DIR/YYYY-MM-DD.json only for a day the API
//     has actually generated — a day it has not reached yet is left absent,
//     never written as an empty placeholder.
//
// Environment variables:
//   AI_USAGE_PAT  (required) token with View Organization Copilot Metrics
//   ORG           (required) target organization login
//   FROM_DAY, THROUGH_DAY (required) inclusive UTC calendar days (YYYY-MM-DD)
//                 bounding the requested range — the same range given to
//                 fetch.mjs. The caller owns which period to request; this
//                 script never infers one from the clock or the report.
//   USERS_RAW_DIR (optional) where to save raw JSON; default "./out/raw-users"
//
// Range: one call to the 28-day report covers report_start_day..report_end_day.
// Only the requested days that report actually covers are saved from it.
// Requested days before report_start_day are required to complete the range,
// so they are fetched one at a time from the 1-day report. A 204 there is a day
// the reports carry no rows for, saved as the empty day it is; only a status or
// network failure is fatal. A day beyond their one-year retention answers 400,
// which is such a failure.
// Requested days after report_end_day are simply not generated yet:
// this script never fetches or synthesizes them, and a latest report that
// ends before the requested range at all is a normal "nothing yet" result,
// not an error.

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireDay, requireDayRange, dayRange, addDays } from './date-range.mjs';

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

const maxDay = (a, b) => (a > b ? a : b);
const minDay = (a, b) => (a < b ? a : b);

function reportUrl(org, pathAndQuery) {
  return `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/${pathAndQuery}`;
}

// `fetchImpl` defaults to the global fetch but is injectable so tests can
// exercise the acquisition flow — including a required-backfill failure —
// against a fake report server instead of the live API.
function fetchReport(fetchImpl, url, token) {
  return fetchImpl(url, {
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
async function downloadRows(fetchImpl, body) {
  const links = (body && Array.isArray(body.download_links)) ? body.download_links : [];
  const rows = [];
  for (const link of links) {
    const res = await fetchImpl(link, { headers: { 'User-Agent': USER_AGENT } });
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

// Pure range planning: given the requested range and the 28-day report's own
// start/end days, decide which requested days the already-downloaded window
// covers, which require a 1-day backfill call, and whether the freshest
// report day is older than the whole requested range (a normal "not
// generated yet" result, not an error). No I/O, so it is exercised directly
// by tests without a fake report server.
export function planAcquisition(range, startDay, endDay) {
  if (endDay < range.fromDay) {
    return { notGeneratedYet: true, windowDays: [], backfill: [] };
  }
  const windowStart = maxDay(startDay, range.fromDay);
  const windowEnd = minDay(endDay, range.throughDay);
  const windowDays = dayRange(windowStart, windowEnd);

  // Requested days before the window that are required to complete the range.
  // Days after the window (report_end_day < THROUGH_DAY) are simply not
  // generated yet and are left for a later run — never fetched here.
  const backfillEnd = minDay(range.throughDay, addDays(startDay, -1));
  const backfill = startDay > range.fromDay ? dayRange(range.fromDay, backfillEnd) : [];

  return { notGeneratedYet: false, windowDays, backfill };
}

// The acquisition flow with the network call injectable, so tests can run it
// end to end (including a required-backfill failure) against a fake report
// server instead of the live API. Returns { saved } on success; throws
// AcquisitionExit(code) when the run must exit non-zero, and returns
// { skipped: true } for a normal "nothing generated yet" result.
export class AcquisitionExit extends Error {
  constructor(code) {
    super(`acquisition exited with code ${code}`);
    this.code = code;
  }
}

export async function acquireUsers({
  token,
  org,
  rawDir,
  range,
  fetchImpl = fetch,
  log = console.log,
  mkdir = fs.mkdir,
  remove = fs.rm,
  save = saveDay,
}) {
  // Create the requested acquisition directory even when the report has not
  // reached this range. Its empty presence is the handoff that distinguishes a
  // normal "nothing generated yet" result from a bad transform input path.
  await mkdir(rawDir, { recursive: true });

  // A reused directory must describe this acquisition, not a previous run, so
  // the requested days are cleared before anything is written — but only once
  // the report has answered for the range, so a technical failure leaves the
  // directory as it was instead of emptying it on the way out. Only the
  // explicitly requested days are cleared; retained history outside the range
  // is unrelated and remains untouched.
  const clearRange = async () => {
    for (const day of dayRange(range.fromDay, range.throughDay)) {
      await remove(path.join(rawDir, `${day}.json`), { force: true });
    }
  };

  const latestRes = await fetchReport(fetchImpl, reportUrl(org, 'users-28-day/latest'), token);
  // res.ok is true for 204, whose body is empty — branch before parsing it.
  if (latestRes.status === 204) {
    await clearRange();
    log('28-day report has not been generated yet — nothing to fetch.');
    return { skipped: true };
  }
  if (!latestRes.ok) {
    let msg = '';
    try {
      const err = await latestRes.json();
      msg = err && err.message ? ` — ${err.message}` : '';
    } catch {}
    console.error(`28-day report: ${latestRes.status} ${latestRes.statusText}${msg}`);
    console.error('Check the token type and the View Organization Copilot Metrics permission.');
    throw new AcquisitionExit(1);
  }

  const body = await latestRes.json();
  const startDay = body.report_start_day;
  const endDay = body.report_end_day;
  if (!startDay || !endDay || !Array.isArray(body.download_links) || body.download_links.length === 0) {
    console.error('28-day report is missing a start day, an end day or download links.');
    throw new AcquisitionExit(1);
  }
  // Both days go straight into day-string comparisons and arithmetic below, so
  // reject anything that is not a plain ISO day here, where the report can be
  // named as the source, rather than further in.
  try {
    requireDay('report_start_day', startDay);
    requireDay('report_end_day', endDay);
  } catch (e) {
    console.error(`28-day report: ${e.message}`);
    throw new AcquisitionExit(1);
  }

  const plan = planAcquisition(range, startDay, endDay);
  if (plan.notGeneratedYet) {
    await clearRange();
    log(
      `Latest report ends ${endDay}, before the requested range ${range.fromDay}..${range.throughDay} — nothing generated yet.`
    );
    return { skipped: true };
  }

  log(
    `Target: org=${org} report=${startDay}..${endDay} requested=${range.fromDay}..${range.throughDay} ` +
    `window=${plan.windowDays.length} backfill=${plan.backfill.length}`
  );

  // A day inside the window with no rows is a real "nobody used credits" day,
  // so it is kept as an empty array.
  const byDay = groupByDay(await downloadRows(fetchImpl, body));
  const acquired = plan.windowDays.map((day) => [day, byDay.get(day) || []]);
  for (const [day, rows] of acquired) log(`${day}: ${rows.length} rows`);

  // Every backfill day is required: leaving one out would publish the range
  // with a gap in it rather than the genuine "not generated yet" state that
  // days after report_end_day represent. A 204 is the reports carrying no rows
  // for that day, which is the same empty day the window would have held.
  // A status or network failure is what stops the run.
  for (const day of plan.backfill) {
    let rows;
    try {
      const res = await fetchReport(fetchImpl, reportUrl(org, `users-1-day?day=${day}`), token);
      // res.ok is true for 204, whose body is empty — branch before parsing it.
      if (res.status === 204) {
        rows = [];
      } else if (!res.ok) {
        console.error(`${day}: ${res.status} ${res.statusText} — required backfill day failed.`);
        throw new AcquisitionExit(1);
      } else {
        rows = groupByDay(await downloadRows(fetchImpl, await res.json())).get(day) || [];
      }
    } catch (e) {
      if (e instanceof AcquisitionExit) throw e;
      console.error(`${day}: ${e.code || e.name} — required backfill day failed.`);
      throw new AcquisitionExit(1);
    }
    acquired.push([day, rows]);
    log(`${day}: ${rows.length} rows`);
  }

  // Nothing has been written until here, so the requested days are replaced
  // only once every one of them is in hand: a run that stops partway leaves
  // the directory holding the previous acquisition rather than half of this one.
  await clearRange();
  for (const [day, rows] of acquired) await save(rawDir, day, rows);

  log(`\nResult: ${acquired.length} day(s) saved (raw saved to ${rawDir})`);
  return { saved: acquired.length };
}

async function main() {
  const token = required('AI_USAGE_PAT');
  const org = required('ORG');
  const rawDir = process.env.USERS_RAW_DIR || './out/raw-users';

  let range;
  try {
    range = requireDayRange(process.env.FROM_DAY, process.env.THROUGH_DAY);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  try {
    await acquireUsers({ token, org, rawDir, range });
  } catch (e) {
    if (e instanceof AcquisitionExit) process.exit(e.code);
    throw e;
  }
}

// Run only when invoked as a script, so planAcquisition/acquireUsers can be
// imported for tests without starting a fetch.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error('Unexpected error:', e.message);
    process.exit(1);
  });
}
