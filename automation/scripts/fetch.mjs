#!/usr/bin/env node
// Acquisition stage: read the organization's daily AI credit usage and save raw JSON.
// The saved JSON is consumed by transform.mjs to build the viewer CSV.
//
// Output contract:
//   - Never print the token or response body (usage data) to stdout.
//   - Only print progress: "YYYY-MM-DD: 200 OK (N items)".
//   - Always save raw JSON to RAW_DIR/YYYY-MM-DD.json.
//
// Environment variables:
//   AI_USAGE_PAT (required) token with Organization Administration: read
//   ORG          (required) target organization login
//   YEAR, MONTH  (optional) backfill a specific month; defaults to the month of
//                "yesterday" (UTC). A past month is fetched in full; the current
//                month is fetched from day 1 to yesterday.
//   RAW_DIR      (optional) where to save raw JSON; default "./out/raw"

import fs from 'node:fs/promises';
import path from 'node:path';

const API_VERSION = '2022-11-28';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Environment variable ${name} is not set.`);
    process.exit(2);
  }
  return v;
}

function daysInMonth(year, month /* 1-12 */) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Decide which days to fetch.
// Default: the month that "yesterday" (UTC) belongs to, days 1..yesterday.
//   - On the 1st of a month, yesterday is the last day of the previous month, so
//     the previous (now complete) month is fetched in full — avoids a blank view.
// Override YEAR/MONTH: a past month is fetched in full; if it equals the current
//   month-of-yesterday, it is fetched 1..yesterday.
function resolveDays() {
  const today = new Date();
  const yest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const yYear = yest.getUTCFullYear();
  const yMonth = yest.getUTCMonth() + 1;
  const yDay = yest.getUTCDate();

  const year = parseInt(process.env.YEAR || '', 10) || yYear;
  const month = parseInt(process.env.MONTH || '', 10) || yMonth;

  const isCurrent = year === yYear && month === yMonth;
  const lastDay = isCurrent ? yDay : daysInMonth(year, month);

  const days = [];
  for (let d = 1; d <= lastDay; d++) days.push(d);
  return { year, month, days };
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

  const { year, month, days } = resolveDays();
  if (days.length === 0) {
    console.log('No days to fetch.');
    return;
  }
  await fs.mkdir(rawDir, { recursive: true });

  console.log(`Target: org=${org} ${year}-${String(month).padStart(2, '0')} days=${days.length}`);

  let ok = 0;
  let failed = 0;
  let firstErrorStatus = 0;

  for (const day of days) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    let res;
    try {
      res = await fetchDay(org, token, year, month, day);
    } catch (e) {
      failed++;
      if (!firstErrorStatus) firstErrorStatus = -1;
      console.log(`${dateStr}: network error (${e.code || e.name})`);
      continue;
    }

    if (!res.ok) {
      failed++;
      if (!firstErrorStatus) firstErrorStatus = res.status;
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
      console.log(`${dateStr}: 200 but JSON parse failed`);
      failed++;
      continue;
    }

    const items = extractItems(body);
    ok++;
    console.log(`${dateStr}: 200 OK (${items.length} items)`);
    await fs.writeFile(path.join(rawDir, `${dateStr}.json`), JSON.stringify(body, null, 2));
  }

  console.log(`\nResult: ${ok} ok / ${failed} failed (raw saved to ${rawDir})`);

  if (failed > 0 && ok === 0) {
    console.error(`\nAll requests failed (first status: ${firstErrorStatus}). Check token type and permissions.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e.message);
  process.exit(1);
});
