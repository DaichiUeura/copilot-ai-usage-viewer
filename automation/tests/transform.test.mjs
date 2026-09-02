// Behavior tests for transform.mjs (run with: node --test).
// Asserts the raw API JSON -> CSV mapping: schema, org-total placeholder, value
// mapping at full precision, that a raw file outside the requested range is
// ignored, that a file whose own timePeriod contradicts its name fails instead
// of quietly leaving a gap, and that a range with no usage items in scope fails
// loudly (there is no normal empty-Overview state).

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

function runTransform(rawDir, opts = {}) {
  const outCsv = opts.outCsv || path.join(os.tmpdir(), `transform-test-${Date.now()}-${Math.random()}.csv`);
  const fromDay = opts.fromDay !== undefined ? opts.fromDay : '2026-05-01';
  const throughDay = opts.throughDay !== undefined ? opts.throughDay : '2026-05-03';
  const stdout = execFileSync('node', [transform], {
    env: { ...process.env, RAW_DIR: rawDir, OUT_CSV: outCsv, FROM_DAY: fromDay, THROUGH_DAY: throughDay },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { outCsv, stdout };
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

// Run a case that must exit non-zero, and hand back the failure to inspect.
function expectFailure(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected a non-zero exit');
}

test('maps raw API JSON to the export schema as an org-total CSV', () => {
  const csv = fs.readFileSync(runTransform(rawFixtures).outCsv, 'utf8');
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

test('a raw file outside the requested range is ignored', () => {
  // The fixtures cover 2026-05-01..03; requesting only the first two days
  // must drop 05-03 even though its file is present in RAW_DIR.
  const { outCsv } = runTransform(rawFixtures, { throughDay: '2026-05-02' });
  const { rows } = parseCsv(fs.readFileSync(outCsv, 'utf8'));
  assert.deepEqual(new Set(rows.map((r) => r.date)), new Set(['2026-05-01', '2026-05-02']));
});

test('fails (non-zero exit) when there is no input for the requested range', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-empty-'));
  assert.throws(() => runTransform(emptyDir));

  // Files exist, but entirely before the requested range.
  const err = expectFailure(() => runTransform(rawFixtures, { fromDay: '2026-06-01', throughDay: '2026-06-05' }));
  assert.match(err.stderr, /Missing raw JSON for 2026-06-01/);
});

test('fails rather than publishing a partial requested range', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-partial-'));
  fs.copyFileSync(
    path.join(rawFixtures, '2026-05-01.json'),
    path.join(dir, '2026-05-01.json')
  );

  const err = expectFailure(() =>
    runTransform(dir, { fromDay: '2026-05-01', throughDay: '2026-05-02' }));
  assert.match(err.stderr, /Missing raw JSON for 2026-05-02/);
});

test('fails when a raw file reports a day other than the one it is named for', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-mismatch-'));
  for (const day of ['2026-05-01', '2026-05-02', '2026-05-03']) {
    fs.copyFileSync(path.join(rawFixtures, `${day}.json`), path.join(dir, `${day}.json`));
  }
  // The file keeps its in-range name, so the completeness check accepts it,
  // but its body now claims a day the run was never asked to publish.
  const body = JSON.parse(fs.readFileSync(path.join(dir, '2026-05-02.json'), 'utf8'));
  body.timePeriod = { year: 2026, month: 4, day: 2 };
  fs.writeFileSync(path.join(dir, '2026-05-02.json'), JSON.stringify(body));

  const err = expectFailure(() => runTransform(dir));
  assert.match(err.stderr, /2026-05-02\.json .* reports 2026-04-02/);
});

test('names the raw file it cannot parse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-corrupt-'));
  for (const day of ['2026-05-01', '2026-05-02', '2026-05-03']) {
    fs.copyFileSync(path.join(rawFixtures, `${day}.json`), path.join(dir, `${day}.json`));
  }
  fs.writeFileSync(path.join(dir, '2026-05-02.json'), '{"usageItems": ['); // truncated

  const err = expectFailure(() => runTransform(dir));
  assert.match(err.stderr, /Cannot parse .*2026-05-02\.json/);
});

test('rejects a missing or invalid FROM_DAY/THROUGH_DAY', () => {
  const err = expectFailure(() => runTransform(rawFixtures, { fromDay: '', throughDay: '2026-05-03' }));
  assert.match(err.stderr, /FROM_DAY is not set/);
});
