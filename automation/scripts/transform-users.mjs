#!/usr/bin/env node
// Transform stage: convert the per-day raw usage metrics rows (from
// fetch-users.mjs) into a single CSV with the same schema as the manual GitHub
// UI export, so the viewer reads API-derived data exactly like a downloaded CSV.
//
// In:  USERS_RAW_DIR   (default ./out/raw-users)  per-day YYYY-MM-DD.json files
//      ORG             (required) organization login written to the `organization` column
//      OUT_CSV         (default ./out/ai-credit-usage-by-user.csv)
//      BILLING_RAW_DIR (optional) raw JSON from fetch.mjs; enables a daily total
//                      cross-check that only warns and never fails the job
// Out: a single CSV. Stdout: scope, row count + date range.
//      Exits non-zero when there is no input / no rows in scope.
//
// Per-user note: the metrics reports carry gross consumption only. Net, discount
// and a per-model split do not exist per user in any API, so those columns are
// left empty rather than estimated — an empty net_amount means "not available",
// not "fully covered". `sku` and `model` are labels: ai_credits_used already
// sums every SKU and model, and the reports carry no breakdown to split it by.
//
// Scope: the CSV covers the month of the newest day present in USERS_RAW_DIR,
// from the 1st through that day. Early in a month, before the new month has any
// data, that is still the previous month in full.

import fs from 'node:fs';
import path from 'node:path';

const USERS_RAW_DIR = process.env.USERS_RAW_DIR || './out/raw-users';
const OUT_CSV = process.env.OUT_CSV || './out/ai-credit-usage-by-user.csv';
const BILLING_RAW_DIR = process.env.BILLING_RAW_DIR || '';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Environment variable ${name} is not set.`);
    process.exit(2);
  }
  return v;
}

const ORG = required('ORG');

// Same column order as the GitHub export, minus the deprecated aic_* columns.
const COLUMNS = [
  'date', 'username', 'product', 'sku', 'model', 'quantity', 'unit_type',
  'applied_cost_per_quantity', 'gross_amount', 'discount_amount', 'net_amount',
  'total_monthly_quota', 'organization', 'repository', 'cost_center_name',
];

const PRICE_PER_CREDIT = 0.01;
const MODEL_PLACEHOLDER = '(all models)';
// A daily total this far apart from the billing API is worth a look; below it,
// the two feeds are the same number.
const CROSS_CHECK_TOLERANCE = 1;

const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

// Both figures are rounded to six decimals, because binary floating point puts
// noise in each of them: the reports' own credit sums arrive with a long
// fractional tail, and credits * 0.01 turns 7 into 0.07000000000000001.
// A millionth of a credit is a hundredth of a cent.
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function dayFiles(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    console.error(`Input directory not found: ${dir}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No raw JSON files in ${dir}`);
    process.exit(1);
  }
  return files;
}

function readRows(dir, file) {
  const full = path.join(dir, file);
  let body;
  try {
    body = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    console.error(`Cannot parse ${full}: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(body) || body.some((r) => !r || typeof r !== 'object')) {
    console.error(`Expected an array of rows in ${full}`);
    process.exit(1);
  }
  return body;
}

// Pull the usageItems array out of a billing response (tolerate shape variations).
function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.usageItems)) return body.usageItems;
  if (body && Array.isArray(body.usage)) return body.usage;
  return [];
}

// Compare the daily credit totals against the billing feed, on the days both
// sides carry. The two feeds have independent timelines, so this only reports
// what it sees; it never changes the output or the exit code.
function crossCheck(dailyCredits) {
  const billingTotals = new Map();
  let files;
  try {
    files = fs.readdirSync(BILLING_RAW_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    console.log(`Cross-check skipped: ${BILLING_RAW_DIR} not found`);
    return;
  }
  for (const f of files) {
    let body;
    try {
      body = JSON.parse(fs.readFileSync(path.join(BILLING_RAW_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    // ai_credits_used sums every SKU, so the billing side is summed the same way.
    const total = extractItems(body).reduce((s, it) => s + Number(it.grossQuantity || 0), 0);
    billingTotals.set(path.basename(f, '.json'), total);
  }

  let compared = 0;
  let flagged = 0;
  for (const [day, credits] of dailyCredits) {
    if (!billingTotals.has(day)) continue;
    compared++;
    const diff = Math.abs(credits - billingTotals.get(day));
    if (diff > CROSS_CHECK_TOLERANCE) {
      flagged++;
      console.log(`Cross-check ${day}: ${credits} credits here vs ${billingTotals.get(day)} in billing (diff ${diff.toFixed(4)})`);
    }
  }
  console.log(`Cross-check: ${compared} shared day(s), ${flagged} over ${CROSS_CHECK_TOLERANCE} credit(s)`);
}

function main() {
  const files = dayFiles(USERS_RAW_DIR);
  const latest = path.basename(files[files.length - 1], '.json');
  const scopeMonth = latest.slice(0, 7);

  const rows = [];
  const dailyCredits = new Map();
  let outOfScope = 0;
  let zeroCredit = 0;

  for (const f of files) {
    const fileDay = path.basename(f, '.json');
    // Register the day even when it has no rows: a day this side is empty for is
    // exactly the day worth comparing against billing.
    if (fileDay.startsWith(scopeMonth) && !dailyCredits.has(fileDay)) dailyCredits.set(fileDay, 0);
    for (const r of readRows(USERS_RAW_DIR, f)) {
      const date = r && r.day ? String(r.day).slice(0, 10) : fileDay;
      if (!date.startsWith(scopeMonth)) {
        outOfScope++;
        continue;
      }
      const credits = Number(r.ai_credits_used);
      dailyCredits.set(date, (dailyCredits.get(date) || 0) + (credits > 0 ? credits : 0));
      // A user with no credit usage has nothing to report, and the reports also
      // carry rows for people who only triggered other activity.
      if (!(credits > 0)) {
        zeroCredit++;
        continue;
      }
      rows.push({
        date,
        username: r.user_login,
        product: 'Copilot',
        sku: 'Copilot AI Credits',
        model: MODEL_PLACEHOLDER,
        quantity: round6(credits),
        unit_type: 'ai-credits',
        applied_cost_per_quantity: PRICE_PER_CREDIT,
        gross_amount: round6(credits * PRICE_PER_CREDIT),
        discount_amount: '',
        net_amount: '',
        total_monthly_quota: '',
        organization: ORG,
        repository: '',
        cost_center_name: '',
      });
    }
  }

  if (rows.length === 0) {
    console.error(
      `No rows in scope ${scopeMonth} (latest available day ${latest}): ` +
      `${outOfScope} row(s) dropped as outside the month, ${zeroCredit} row(s) dropped as zero credits.`
    );
    process.exit(1);
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // stable within a day

  const lines = [COLUMNS.map(q).join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => q(r[c])).join(','));

  fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n');

  const dates = rows.map((r) => r.date);
  console.log(
    `wrote ${rows.length} rows, scope ${scopeMonth} (latest ${latest}), ` +
    `dates ${dates[0]}..${dates[dates.length - 1]} -> ${OUT_CSV}`
  );
  console.log(`dropped ${outOfScope} row(s) outside the month, ${zeroCredit} zero-credit row(s)`);

  if (BILLING_RAW_DIR) crossCheck(dailyCredits);
}

main();
