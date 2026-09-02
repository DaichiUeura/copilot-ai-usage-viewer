#!/usr/bin/env node
// Advisory validator: compare daily AI credit totals between the billing feed
// (fetch.mjs's raw JSON) and the per-user metrics feed (fetch-users.mjs's raw
// JSON), for an automation consumer's operator logs. It never changes a CSV
// and never fails the job. It is separate from the Viewer's own reader-facing
// validation banner, which checks organization, overlap and daily Gross at the
// CSV level for whoever opens the page.
//
// In:  RAW_DIR        (default ./out/raw)        billing per-day JSON
//      USERS_RAW_DIR   (default ./out/raw-users)  per-user per-day JSON
//      FROM_DAY, THROUGH_DAY (required) the same inclusive UTC range given to
//                      the acquisition/transform scripts for this run
// Out: one log line per day whose totals differ by more than the tolerance,
//      plus a summary line. Always exits 0 once the range itself is valid.
//
// Only days both feeds actually cover (within the requested range) are
// compared; a day only one feed carries is skipped, and a range with no
// Members data at all skips the whole check — the two feeds have independent
// timelines, and there is nothing for this script to say about a day one side
// has not produced.

import fs from 'node:fs';
import path from 'node:path';
import { requireDayRange, dayRange } from './date-range.mjs';

const RAW_DIR = process.env.RAW_DIR || './out/raw';
const USERS_RAW_DIR = process.env.USERS_RAW_DIR || './out/raw-users';

// A daily total this far apart from the other feed is worth a look; below it,
// the two feeds are the same number.
const TOLERANCE = 1;

// The unit the per-user feed reports in; a billing item in any other unit is a
// different quantity and does not belong in the comparison.
const CREDIT_UNIT = 'ai-credits';

function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.usageItems)) return body.usageItems;
  if (body && Array.isArray(body.usage)) return body.usage;
  return [];
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function matchingDayFiles(dir, daySet) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }
  return files.filter((f) => daySet.has(path.basename(f, '.json'))).sort();
}

// Sum grossQuantity across the day's AI credit usage items — ai_credits_used on
// the other feed already sums every credit-priced SKU the same way. A usage item
// billed in some other unit would not be credits, so it is left out rather than
// added to a credits total.
function billingDailyTotals(daySet) {
  const totals = new Map();
  for (const f of matchingDayFiles(RAW_DIR, daySet)) {
    const body = readJSON(path.join(RAW_DIR, f));
    if (body === undefined) continue; // a file that fails to parse has nothing to compare
    const day = path.basename(f, '.json');
    const total = extractItems(body)
      .filter((it) => it && it.unitType === CREDIT_UNIT)
      .reduce((s, it) => s + Number(it.grossQuantity || 0), 0);
    totals.set(day, total);
  }
  return totals;
}

// Sum positive ai_credits_used per day. A day present with only zero or
// missing credits still counts as 0 — that is exactly the day worth comparing.
function membersDailyTotals(daySet) {
  const totals = new Map();
  for (const f of matchingDayFiles(USERS_RAW_DIR, daySet)) {
    const body = readJSON(path.join(USERS_RAW_DIR, f));
    if (!Array.isArray(body)) continue; // a file that fails to parse has nothing to compare
    const total = body.reduce((s, r) => {
      const credits = Number(r && r.ai_credits_used);
      return s + (credits > 0 ? credits : 0);
    }, 0);
    totals.set(path.basename(f, '.json'), total);
  }
  return totals;
}

function main() {
  let range;
  try {
    range = requireDayRange(process.env.FROM_DAY, process.env.THROUGH_DAY);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const daySet = new Set(dayRange(range.fromDay, range.throughDay));
  const scopeLabel = `${range.fromDay}..${range.throughDay}`;

  const members = membersDailyTotals(daySet);
  if (members.size === 0) {
    console.log(`Cross-check skipped: no Members data for ${scopeLabel}.`);
    return;
  }

  const billing = billingDailyTotals(daySet);
  if (billing.size === 0) {
    console.log(`Cross-check skipped: no billing data for ${scopeLabel}.`);
    return;
  }

  let compared = 0;
  let flagged = 0;
  for (const [day, credits] of members) {
    if (!billing.has(day)) continue;
    compared++;
    const diff = Math.abs(credits - billing.get(day));
    if (diff > TOLERANCE) {
      flagged++;
      console.log(`Cross-check ${day}: ${credits} credits (Members) vs ${billing.get(day)} (billing), diff ${diff.toFixed(4)}`);
    }
  }
  console.log(`Cross-check: ${compared} shared day(s), ${flagged} over ${TOLERANCE} credit(s)`);
}

main();
