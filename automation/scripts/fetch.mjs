#!/usr/bin/env node
// Acquisition stage: read the organization's daily AI credit usage for an
// explicit inclusive UTC day range and save the raw JSON. transform.mjs
// consumes the saved JSON to build the viewer CSV.
//
// Output contract:
//   - Never print the token or response body (usage data) to stdout.
//   - Only print progress: "YYYY-MM-DD: 200 OK (N items)".
//   - Always save raw JSON to RAW_DIR/YYYY-MM-DD.json.
//   - Every requested day is required: a failed or missing day is fatal, so a
//     technical failure never produces a silently partial Overview. That is
//     also why a reused RAW_DIR needs no clearing here: a successful run has
//     rewritten every day of the range, and an unsuccessful one stops the
//     pipeline before the leftovers can be read.
//
// Environment variables:
//   AI_USAGE_PAT (required) token with Organization Administration: read
//   ORG          (required) target organization login
//   FROM_DAY, THROUGH_DAY (required) inclusive UTC calendar days (YYYY-MM-DD)
//                bounding the requested range. The caller — a workflow
//                computing the current UTC month, or a manual backfill —
//                owns which period to request; this script never infers one
//                from the clock.
//   RAW_DIR      (optional) where to save raw JSON; default "./out/raw"

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireDayRange, dayRange } from './date-range.mjs';

const API_VERSION = '2022-11-28';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Environment variable ${name} is not set.`);
    process.exit(2);
  }
  return v;
}

// Every day the requested inclusive range covers, each carrying the
// year/month/day the per-day billing endpoint takes as query parameters (it
// has no range form of its own). Throws on a missing, malformed, impossible,
// or reversed FROM_DAY/THROUGH_DAY.
export function resolveDays(fromDay, throughDay) {
  const range = requireDayRange(fromDay, throughDay);
  return dayRange(range.fromDay, range.throughDay).map((dateStr) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return { year, month, day, dateStr };
  });
}

async function fetchDay(org, token, year, month, day) {
  const url =
    `https://api.github.com/organizations/${encodeURIComponent(org)}` +
    `/settings/billing/ai_credit/usage?year=${year}&month=${month}&day=${day}`;
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'copilot-ai-credits-overview',
    },
  });
}

// Pull the usageItems array out of the response (tolerate shape variations).
function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.usageItems)) return body.usageItems;
  if (body && Array.isArray(body.usage)) return body.usage;
  return [];
}

async function main() {
  const token = required('AI_USAGE_PAT');
  const org = required('ORG');
  const rawDir = process.env.RAW_DIR || './out/raw';

  let days;
  try {
    days = resolveDays(process.env.FROM_DAY, process.env.THROUGH_DAY);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  await fs.mkdir(rawDir, { recursive: true });

  console.log(`Target: org=${org} ${days[0].dateStr}..${days[days.length - 1].dateStr} days=${days.length}`);

  let ok = 0;
  const failedDays = [];

  for (const { year, month, day, dateStr } of days) {
    let res;
    try {
      res = await fetchDay(org, token, year, month, day);
    } catch (e) {
      failedDays.push(dateStr);
      console.log(`${dateStr}: network error (${e.code || e.name})`);
      continue;
    }

    if (!res.ok) {
      failedDays.push(dateStr);
      // The error message (not usage data) is useful for diagnosis; print it briefly.
      let msg = '';
      try {
        const body = await res.json();
        msg = body && body.message ? ` — ${body.message}` : '';
      } catch {}
      console.log(`${dateStr}: ${res.status} ${res.statusText}${msg}`);
      continue;
    }

    let body;
    try {
      body = await res.json();
    } catch {
      failedDays.push(dateStr);
      console.log(`${dateStr}: 200 but JSON parse failed`);
      continue;
    }

    const items = extractItems(body);
    ok++;
    console.log(`${dateStr}: 200 OK (${items.length} items)`);
    await fs.writeFile(path.join(rawDir, `${dateStr}.json`), JSON.stringify(body, null, 2));
  }

  console.log(`\nResult: ${ok} ok / ${failedDays.length} failed (raw saved to ${rawDir})`);

  if (failedDays.length > 0) {
    console.error(
      `\n${failedDays.length} of ${days.length} requested day(s) failed: ${failedDays.join(', ')}. ` +
      'Every requested day is required; check the token and permissions, then retry.'
    );
    process.exit(1);
  }
}

// Run only when invoked as a script, so resolveDays can be imported on its own.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error('Unexpected error:', e.message);
    process.exit(1);
  });
}
