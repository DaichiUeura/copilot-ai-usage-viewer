// Behavior tests for transform-users.mjs (run with: node --test).
// Asserts the per-user metrics rows -> CSV mapping: schema, the gross-only
// columns, the month scope taken from the data, and that an empty result fails
// loudly instead of publishing an empty CSV.

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
  const stdout = execFileSync('node', [transform], {
    env: { ...process.env, USERS_RAW_DIR: rawDir, OUT_CSV: out, ORG, ...(opts.env || {}) },
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

// Build a billing raw directory from { 'YYYY-MM-DD': totalCredits }, splitting
// each day over two SKUs so the cross-check has to sum all of them.
function writeBillingDir(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-raw-'));
  for (const [day, total] of Object.entries(days)) {
    fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify({
      organization: 'Example Org',
      usageItems: [
        { sku: 'Copilot AI Credits', grossQuantity: total - 1 },
        { sku: 'Copilot Cloud Agent', grossQuantity: 1 },
      ],
    }));
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

test('tolerates missing days, empty days and unrelated files', () => {
  const dir = writeRawDir({
    '2026-05-04': { alice: 5 },
    '2026-05-06': { alice: 6 },
    '2026-05-07': { alice: 7 },
    '2026-05-08': {},
  });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a day file');
  fs.writeFileSync(path.join(dir, 'report-meta.json'), '{"broken":');

  const { out, stdout } = runTransform(dir);
  const { rows } = readCsv(out);

  // 2026-05-05 was never fetched, so it is simply absent — no zero row for it.
  assert.deepEqual(rows.map((r) => r.date), ['2026-05-04', '2026-05-06', '2026-05-07']);
  assert.match(stdout, /dates 2026-05-04\.\.2026-05-07/);
});

test('trims to the month of the newest day, independent of the local time zone', () => {
  const dir = writeRawDir({
    '2026-04-25': { alice: 4, mallory: 40 },
    '2026-04-30': { alice: 5, mallory: 50 },
    '2026-05-01': { alice: 6 },
    '2026-05-15': { alice: 7 },
  });

  const east = runTransform(dir, { env: { TZ: 'Pacific/Kiritimati' } });
  const west = runTransform(dir, { env: { TZ: 'Pacific/Niue' } });
  const { rows } = readCsv(east.out);

  assert.deepEqual(rows.map((r) => r.date), ['2026-05-01', '2026-05-15']);
  // April is out of scope, so a member who only used credits in April is gone.
  assert.equal(rows.some((r) => r.username === 'mallory'), false);
  assert.match(east.stdout, /scope 2026-05 \(latest 2026-05-15\)/);
  assert.match(east.stdout, /dropped 4 row\(s\) outside the month/);

  // The scope comes from the data, never from the clock.
  assert.deepEqual(fs.readFileSync(east.out), fs.readFileSync(west.out));
});

test('keeps the previous month in full until the new month has data', () => {
  const dir = writeRawDir({
    '2026-04-03': { alice: 3 },
    '2026-04-30': { alice: 4 },
  });
  const before = readCsv(runTransform(dir).out);

  // No data for the new month yet, so the completed month stays whole — and the
  // days it never had are not invented.
  assert.deepEqual(before.rows.map((r) => r.date), ['2026-04-03', '2026-04-30']);

  fs.writeFileSync(path.join(dir, '2026-05-01.json'),
    JSON.stringify([{ day: '2026-05-01', user_login: 'alice', ai_credits_used: 9 }]));
  const after = readCsv(runTransform(dir).out);

  assert.deepEqual(after.rows.map((r) => r.date), ['2026-05-01']);
});

test('fails without writing a CSV when nothing survives', () => {
  const outCsv = path.join(os.tmpdir(), `transform-users-keep-${Date.now()}.csv`);
  fs.writeFileSync(outCsv, 'previous run\n');

  expectFailure(() => runTransform(fs.mkdtempSync(path.join(os.tmpdir(), 'users-empty-')), { outCsv }));

  const allZero = writeRawDir({ '2026-05-10': { alice: 0, bob: 0 } });
  const zeroErr = expectFailure(() => runTransform(allZero, { outCsv }));
  assert.match(zeroErr.stderr, /No rows in scope 2026-05 \(latest available day 2026-05-10\)/);
  assert.match(zeroErr.stderr, /2 row\(s\) dropped as zero credits/);

  // The last good CSV must survive a run that produced nothing.
  assert.equal(fs.readFileSync(outCsv, 'utf8'), 'previous run\n');

  const corrupt = writeRawDir({ '2026-05-10': { alice: 5 } });
  fs.writeFileSync(path.join(corrupt, '2026-05-11.json'), '[{"day":');
  const corruptErr = expectFailure(() => runTransform(corrupt, { outCsv }));

  // A missing day is normal; a corrupt one means the fetch stage broke.
  assert.match(corruptErr.stderr, /2026-05-11\.json/);

  const notRows = writeRawDir({ '2026-05-10': { alice: 5 } });
  fs.writeFileSync(path.join(notRows, '2026-05-11.json'), '[null]');
  const notRowsErr = expectFailure(() => runTransform(notRows, { outCsv }));

  // A file that parses but holds something other than rows names itself too.
  assert.match(notRowsErr.stderr, /2026-05-11\.json/);
});

test('reports a cross-check warning without failing the job', () => {
  // Fixture daily totals: 1242, 5, 15.25 credits.
  const agreeing = writeBillingDir({ '2026-05-04': 1242, '2026-05-05': 5, '2026-05-09': 999 });
  const clean = runTransform(rawFixtures, { env: { BILLING_RAW_DIR: agreeing } });

  // 2026-05-06 (here only) and 2026-05-09 (billing only) are not compared.
  assert.match(clean.stdout, /Cross-check: 2 shared day\(s\), 0 over 1 credit\(s\)/);

  const drifting = writeBillingDir({ '2026-05-04': 1300, '2026-05-05': 5 });
  const warned = runTransform(rawFixtures, { env: { BILLING_RAW_DIR: drifting } });

  assert.match(warned.stdout, /Cross-check 2026-05-04: 1242 credits here vs 1300 in billing/);
  assert.match(warned.stdout, /Cross-check: 2 shared day\(s\), 1 over 1 credit\(s\)/);

  // A day the reports came back empty for is the one most worth comparing, so it
  // has to count as a shared day rather than quietly reading as agreement.
  const withEmptyDay = writeRawDir({ '2026-05-04': { alice: 100 }, '2026-05-05': {} });
  const gap = runTransform(withEmptyDay, {
    env: { BILLING_RAW_DIR: writeBillingDir({ '2026-05-04': 100, '2026-05-05': 900 }) },
  });

  assert.match(gap.stdout, /Cross-check 2026-05-05: 0 credits here vs 900 in billing/);
  assert.match(gap.stdout, /Cross-check: 2 shared day\(s\), 1 over 1 credit\(s\)/);
});
