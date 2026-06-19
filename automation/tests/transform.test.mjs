// Behavior tests for transform.mjs (run with: node --test).
// Asserts the raw API JSON -> CSV mapping: schema, org-total placeholder, value
// mapping at full precision, and that empty input fails loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const transform = path.join(here, '..', 'scripts', 'transform.mjs');
const rawFixtures = path.join(here, 'fixtures', 'ai-credit-raw');

const EXPECTED_HEADER =
  'date,username,product,sku,model,quantity,unit_type,applied_cost_per_quantity,' +
  'gross_amount,discount_amount,net_amount,total_monthly_quota,organization,' +
  'repository,cost_center_name';

function runTransform(rawDir) {
  const outCsv = path.join(os.tmpdir(), `transform-test-${Date.now()}-${Math.random()}.csv`);
  execFileSync('node', [transform], { env: { ...process.env, RAW_DIR: rawDir, OUT_CSV: outCsv } });
  return outCsv;
}

// Parse a CSV where every field is double-quoted (transform always quotes).
function parseCsv(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',').map((c) => c.replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.replace(/^"|"$/g, ''));
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
  return { header, rows };
}

test('maps raw API JSON to the export schema as an org-total CSV', () => {
  const csv = fs.readFileSync(runTransform(rawFixtures), 'utf8');
  const { header, rows } = parseCsv(csv);

  // Same column order as the GitHub export, minus the deprecated aic_* columns.
  assert.equal(header.join(','), EXPECTED_HEADER);

  // One row per usageItem (3 fixture days x 2 models).
  assert.equal(rows.length, 6);

  // Every row is the org-total placeholder, organization read from the JSON.
  for (const r of rows) {
    assert.equal(r.username, '(org total)');
    assert.equal(r.organization, 'Example Org');
    // The API has no per-row quota / repo / cost center.
    assert.equal(r.total_monthly_quota, '');
    assert.equal(r.repository, '');
    assert.equal(r.cost_center_name, '');
  }

  // Value mapping at full precision (grossQuantity/grossAmount/discountAmount/netAmount).
  const meteredRow = rows.find((r) => r.date === '2026-05-03' && r.model === 'Model A');
  assert.equal(meteredRow.quantity, '200');
  assert.equal(meteredRow.gross_amount, '2');
  assert.equal(meteredRow.discount_amount, '0.8');
  assert.equal(meteredRow.net_amount, '1.2');
});

test('fails (non-zero exit) when there is no input', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-empty-'));
  assert.throws(() => runTransform(emptyDir));
});
