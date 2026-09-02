// Behavior tests for transform-users.mjs (run with: node --test).
// Asserts the per-user metrics rows -> CSV mapping: schema, the gross-only
// columns, and the publication contract for the explicit FROM_DAY/THROUGH_DAY
// range — a not-yet-generated range and a range with only zero-credit rows
// both succeed with no OUT_CSV (and remove a stale one), while corrupt input
// remains fatal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const transform = path.join(here, '..', 'scripts', 'transform-users.mjs');
const rawFixtures = path.join(here, 'fixtures', 'ai-credit-users-raw');
const ORG = 'example-org';

const EXPECTED_HEADER =
  'date,username,product,sku,model,quantity,unit_type,applied_cost_per_quantity,' +
  'gross_amount,discount_amount,net_amount,total_monthly_quota,organization,' +
  'repository,cost_center_name';

function runTransform(rawDir, opts = {}) {
  const out = opts.outCsv || path.join(os.tmpdir(), `transform-users-test-${Date.now()}-${Math.random()}.csv`);
  const fromDay = opts.fromDay !== undefined ? opts.fromDay : '2026-05-04';
  const throughDay = opts.throughDay !== undefined ? opts.throughDay : '2026-05-06';
  const stdout = execFileSync('node', [transform], {
    env: { ...process.env, USERS_RAW_DIR: rawDir, OUT_CSV: out, ORG, FROM_DAY: fromDay, THROUGH_DAY: throughDay, ...(opts.env || {}) },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { out, stdout };
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

function readCsv(out) {
  return parseCsv(fs.readFileSync(out, 'utf8'));
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

// Build a raw directory from { 'YYYY-MM-DD': { login: credits } }.
// A null value writes a row with no ai_credits_used field at all.
function writeRawDir(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'users-raw-'));
  for (const [day, users] of Object.entries(days)) {
    const rows = Object.entries(users).map(([user_login, credits]) =>
      credits === null ? { day, user_login } : { day, user_login, ai_credits_used: credits });
    fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify(rows));
  }
  return dir;
}

test('maps per-user metrics rows to the export schema', () => {
  const { rows, header } = readCsv(runTransform(rawFixtures).out);

  // Same column order as the GitHub export, so the viewer reads it unchanged.
  assert.equal(header.join(','), EXPECTED_HEADER);

  // One row per user per day that used credits (3 + 2 + 3 across the fixtures).
  assert.equal(rows.length, 8);

  for (const r of rows) {
    assert.equal(r.product, 'Copilot');
    assert.equal(r.sku, 'Copilot AI Credits');
    assert.equal(r.model, '(all models)');
    assert.equal(r.unit_type, 'ai-credits');
    assert.equal(r.applied_cost_per_quantity, '0.01');
    assert.equal(r.organization, ORG);
    // Per-user net, discount and quota do not exist in the metrics reports.
    assert.equal(r.discount_amount, '');
    assert.equal(r.net_amount, '');
    assert.equal(r.total_monthly_quota, '');
    assert.equal(r.repository, '');
    assert.equal(r.cost_center_name, '');
  }

  // gross_amount is quantity x 0.01, free of binary floating point noise.
  const alice = rows.find((r) => r.date === '2026-05-04' && r.username === 'alice');
  assert.equal(alice.quantity, '7');
  assert.equal(alice.gross_amount, '0.07');
  const bob = rows.find((r) => r.date === '2026-05-04' && r.username === 'bob');
  assert.equal(bob.quantity, '1234.5');
  assert.equal(bob.gross_amount, '12.345');
  const carol = rows.find((r) => r.date === '2026-05-04' && r.username === 'carol');
  assert.equal(carol.gross_amount, '0.005');

  const dates = rows.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort());
});

test('drops rows with no credit usage', () => {
  const dir = writeRawDir({
    '2026-05-04': { alice: 12, bob: 0 },
    '2026-05-05': { alice: 0, carol: null, dave: 3 },
  });
  const { rows } = readCsv(runTransform(dir).out);

  // Someone at zero — or with the field absent — has nothing to report.
  assert.deepEqual(rows.map((r) => `${r.date}/${r.username}`), ['2026-05-04/alice', '2026-05-05/dave']);
});

test('a raw file outside the requested range is ignored, with no zero row invented for a day never fetched', () => {
  const dir = writeRawDir({
    '2026-05-04': { alice: 5 },
    '2026-05-05': { alice: 6 }, // outside the requested 05-04..05-04 range below
    '2026-05-08': {},
  });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a day file');

  const { out, stdout } = runTransform(dir, { fromDay: '2026-05-04', throughDay: '2026-05-04' });
  const { rows } = readCsv(out);

  assert.deepEqual(rows.map((r) => r.date), ['2026-05-04']);
  assert.match(stdout, /range 2026-05-04\.\.2026-05-04/);
});

test('a row whose own day field falls outside the range is dropped even if the filename is in range', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'users-raw-'));
  fs.writeFileSync(path.join(dir, '2026-05-04.json'), JSON.stringify([
    { day: '2026-05-04', user_login: 'alice', ai_credits_used: 5 },
    { day: '2026-04-30', user_login: 'mallory', ai_credits_used: 40 }, // embedded date outside range
  ]));
  const { rows } = readCsv(runTransform(dir, { fromDay: '2026-05-04', throughDay: '2026-05-04' }).out);
  assert.deepEqual(rows.map((r) => r.username), ['alice']);
});

test('fails when the input directory is missing', () => {
  const outCsv = path.join(os.tmpdir(), `transform-users-notgen-${Date.now()}.csv`);
  fs.writeFileSync(outCsv, 'stale previous run\n');

  const error = expectFailure(() =>
    runTransform(path.join(os.tmpdir(), `users-raw-does-not-exist-${Date.now()}`), { outCsv }));

  assert.match(error.stderr, /Cannot read input directory/);
  assert.equal(fs.readFileSync(outCsv, 'utf8'), 'stale previous run\n');
});

test('succeeds with no OUT_CSV when the directory exists but has no files in range', () => {
  const dir = writeRawDir({ '2026-04-01': { alice: 5 } }); // entirely outside the requested range
  const outCsv = path.join(os.tmpdir(), `transform-users-empty-${Date.now()}.csv`);
  fs.writeFileSync(outCsv, 'stale previous run\n');

  const { stdout } = runTransform(dir, { outCsv });

  assert.match(stdout, /Members not generated yet/);
  assert.equal(fs.existsSync(outCsv), false);
});

test('succeeds with no OUT_CSV when every in-range row is zero-credit, and removes a stale CSV', () => {
  const dir = writeRawDir({ '2026-05-04': { alice: 0, bob: 0 } });
  const outCsv = path.join(os.tmpdir(), `transform-users-zero-${Date.now()}.csv`);
  fs.writeFileSync(outCsv, 'stale previous run\n');

  const { stdout } = runTransform(dir, { outCsv, fromDay: '2026-05-04', throughDay: '2026-05-04' });

  assert.match(stdout, /no positive-credit rows/);
  assert.equal(fs.existsSync(outCsv), false);
});

test('the first positive row after a run with no output restores the CSV', () => {
  const outCsv = path.join(os.tmpdir(), `transform-users-restore-${Date.now()}.csv`);

  const zeroDir = writeRawDir({ '2026-05-04': { alice: 0 } });
  runTransform(zeroDir, { outCsv, fromDay: '2026-05-04', throughDay: '2026-05-04' });
  assert.equal(fs.existsSync(outCsv), false);

  const positiveDir = writeRawDir({ '2026-05-04': { alice: 5 } });
  runTransform(positiveDir, { outCsv, fromDay: '2026-05-04', throughDay: '2026-05-04' });
  assert.equal(fs.existsSync(outCsv), true);
  const { rows } = readCsv(outCsv);
  assert.deepEqual(rows.map((r) => r.username), ['alice']);
});

test('fails (technical error) without writing a CSV, and leaves a previous CSV in place', () => {
  const outCsv = path.join(os.tmpdir(), `transform-users-keep-${Date.now()}.csv`);
  fs.writeFileSync(outCsv, 'previous run\n');

  const corrupt = writeRawDir({ '2026-05-04': { alice: 5 } });
  fs.writeFileSync(path.join(corrupt, '2026-05-05.json'), '[{"day":');
  const corruptErr = expectFailure(() => runTransform(corrupt, { outCsv, fromDay: '2026-05-04', throughDay: '2026-05-05' }));
  assert.match(corruptErr.stderr, /2026-05-05\.json/);

  // A technical failure must not touch the last-good CSV.
  assert.equal(fs.readFileSync(outCsv, 'utf8'), 'previous run\n');

  const notRows = writeRawDir({ '2026-05-04': { alice: 5 } });
  fs.writeFileSync(path.join(notRows, '2026-05-05.json'), '[null]');
  const notRowsErr = expectFailure(() => runTransform(notRows, { outCsv, fromDay: '2026-05-04', throughDay: '2026-05-05' }));
  assert.match(notRowsErr.stderr, /2026-05-05\.json/);
  assert.equal(fs.readFileSync(outCsv, 'utf8'), 'previous run\n');
});

test('rejects a missing or invalid FROM_DAY/THROUGH_DAY', () => {
  const err = expectFailure(() => runTransform(rawFixtures, { fromDay: '' }));
  assert.match(err.stderr, /FROM_DAY is not set/);
});

test('rejects a missing ORG', () => {
  const err = expectFailure(() => runTransform(rawFixtures, { env: { ORG: '' } }));
  assert.match(err.stderr, /ORG is not set/);
});
