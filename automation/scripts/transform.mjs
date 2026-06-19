#!/usr/bin/env node
// Transform stage: convert the per-day raw AI credit usage JSON (from fetch.mjs)
// into a single CSV with the same schema as the manual GitHub UI export, so the
// viewer reads API-derived data exactly like a downloaded CSV.
//
// In:  RAW_DIR  (default ./out/raw)  per-day YYYY-MM-DD.json files
//      OUT_CSV  (default ./out/ai-credit-usage.csv)
// Out: a single CSV. Stdout: row count + date range.
//      Exits non-zero when there is no input / no usage items.
//
// Org-level note: the API has no per-user dimension, so `username` is a constant
// placeholder "(org total)". One CSV row per usageItem (date x product x sku x
// model x unitType). Amounts are written at full precision to match API totals.

import fs from 'node:fs';
import path from 'node:path';

const RAW_DIR = process.env.RAW_DIR || './out/raw';
const OUT_CSV = process.env.OUT_CSV || './out/ai-credit-usage.csv';

// Same column order as the GitHub export, minus the deprecated aic_* columns.
const COLUMNS = [
  'date', 'username', 'product', 'sku', 'model', 'quantity', 'unit_type',
  'applied_cost_per_quantity', 'gross_amount', 'discount_amount', 'net_amount',
  'total_monthly_quota', 'organization', 'repository', 'cost_center_name',
];

const USERNAME_PLACEHOLDER = '(org total)';

const pad = (n) => String(n).padStart(2, '0');
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.usageItems)) return body.usageItems;
  if (body && Array.isArray(body.usage)) return body.usage;
  return [];
}

function dateOf(body, file) {
  const tp = body && body.timePeriod;
  if (tp && tp.year && tp.month && tp.day) return `${tp.year}-${pad(tp.month)}-${pad(tp.day)}`;
  return path.basename(file, '.json'); // fallback to filename (YYYY-MM-DD)
}

function main() {
  let files;
  try {
    files = fs.readdirSync(RAW_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    console.error(`Input directory not found: ${RAW_DIR}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No raw JSON files in ${RAW_DIR}`);
    process.exit(1);
  }

  const rows = [];
  for (const f of files) {
    const body = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), 'utf8'));
    const date = dateOf(body, f);
    const org = (body && body.organization) || '';
    for (const it of extractItems(body)) {
      rows.push({
        date,
        username: USERNAME_PLACEHOLDER,
        product: it.product,
        sku: it.sku,
        model: it.model,
        quantity: it.grossQuantity,
        unit_type: it.unitType,
        applied_cost_per_quantity: it.pricePerUnit,
        gross_amount: it.grossAmount,
        discount_amount: it.discountAmount,
        net_amount: it.netAmount,
        total_monthly_quota: '',
        organization: org,
        repository: '',
        cost_center_name: '',
      });
    }
  }

  if (rows.length === 0) {
    console.error('No usage items found in raw JSON.');
    process.exit(1);
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // stable within a day

  const lines = [COLUMNS.map(q).join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => q(r[c])).join(','));

  fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n');

  const dates = rows.map((r) => r.date);
  console.log(`wrote ${rows.length} rows, dates ${dates[0]}..${dates[dates.length - 1]} -> ${OUT_CSV}`);
}

main();
