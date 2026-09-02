#!/usr/bin/env node
// Transform stage: convert the per-day raw usage metrics rows (from
// fetch-users.mjs) into a single CSV with the same schema as the manual GitHub
// UI export, so the viewer reads API-derived data exactly like a downloaded CSV.
//
// In:  USERS_RAW_DIR (default ./out/raw-users) per-day YYYY-MM-DD.json files
//      ORG            (required) organization login written to the
//                     `organization` column
//      FROM_DAY, THROUGH_DAY (required) inclusive UTC range to publish — the
//                     same range given to fetch-users.mjs. A raw file, or a
//                     row, outside it never influences the output.
//      OUT_CSV        (default ./out/ai-credit-usage-by-user.csv)
// Out: a single CSV, written atomically (never a half-written file). Stdout:
//      range, row count, and dropped-row counts.
//
// Publication contract: input that cannot be trusted — including a missing
// USERS_RAW_DIR, corrupt JSON, or a file that is not an array of row objects —
// is fatal. A valid acquisition directory with no requested-range files, or
// valid requested-range input with no positive usage, is a normal successful
// "nothing to publish" result: it exits 0, logs why, and removes a stale
// OUT_CSV from a reused output directory.
//
//   - USERS_RAW_DIR exists but holds no file for the requested range: the
//     normal state produced when fetch-users.mjs finds that the report has not
//     generated this range yet.
//   - Requested-range rows exist but none carry positive credits: a normal
//     empty month, not fatal, and no header-only/placeholder CSV is written.
//
// Per-user note: the metrics reports carry gross consumption only. Net,
// discount and a per-model split do not exist per user in any API, so those
// columns are left empty rather than estimated — an empty net_amount means
// "not available", not "fully covered". `sku` and `model` are labels:
// ai_credits_used already sums every SKU and model, and the reports carry no
// breakdown to split it by.
//
// The optional billing-feed comparison lives in cross-check.mjs; it does not
// run as part of this script.

import fs from 'node:fs';
import path from 'node:path';
import { requireDayRange, dayRange } from './date-range.mjs';

const USERS_RAW_DIR = process.env.USERS_RAW_DIR || './out/raw-users';
const OUT_CSV = process.env.OUT_CSV || './out/ai-credit-usage-by-user.csv';

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

const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

// Both figures are rounded to six decimals, because binary floating point puts
// noise in each of them: the reports' own credit sums arrive with a long
// fractional tail, and credits * 0.01 turns 7 into 0.07000000000000001.
// A millionth of a credit is a hundredth of a cent.
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// The day files in `dir` that fall inside the requested range.
function matchingDayFiles(dir, daySet) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch (e) {
    console.error(`Cannot read input directory ${dir}: ${e.message}`);
    process.exit(1);
  }
  return files.filter((f) => daySet.has(path.basename(f, '.json'))).sort();
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

// A normal "nothing to publish" result: log why, remove a stale OUT_CSV left
// over from a reused output directory, and return so main() exits 0.
function noOutput(reason) {
  console.log(reason);
  fs.rmSync(OUT_CSV, { force: true });
}

// Rename into place so a reader never observes a half-written file, and a
// process that dies mid-write cannot corrupt a previous successful CSV.
function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
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

  const files = matchingDayFiles(USERS_RAW_DIR, daySet);
  if (files.length === 0) {
    return noOutput(`Members not generated yet: no raw JSON files for ${scopeLabel} in ${USERS_RAW_DIR}.`);
  }

  const rows = [];
  let outOfRange = 0;
  let zeroCredit = 0;

  for (const f of files) {
    const fileDay = path.basename(f, '.json');
    for (const r of readRows(USERS_RAW_DIR, f)) {
      const date = r && r.day ? String(r.day).slice(0, 10) : fileDay;
      if (!daySet.has(date)) {
        outOfRange++;
        continue;
      }
      const credits = Number(r.ai_credits_used);
      // A user with no credit usage has nothing to report, and the reports
      // also carry rows for people who only triggered other activity.
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
    return noOutput(
      `Members has no positive-credit rows for ${scopeLabel}: ` +
      `${outOfRange} row(s) outside the range, ${zeroCredit} row(s) at zero credits — publishing no Members CSV.`
    );
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // stable within a day

  const lines = [COLUMNS.map(q).join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => q(r[c])).join(','));
  writeAtomic(OUT_CSV, lines.join('\n') + '\n');

  const dates = rows.map((r) => r.date);
  console.log(
    `wrote ${rows.length} rows, range ${scopeLabel}, dates ${dates[0]}..${dates[dates.length - 1]} -> ${OUT_CSV}`
  );
  console.log(`dropped ${outOfRange} row(s) outside the range, ${zeroCredit} zero-credit row(s)`);
}

main();
