// Behavior tests for fetch.mjs (run with: node --test).
// Asserts resolveDays against the explicit FROM_DAY/THROUGH_DAY contract —
// there is no implicit clock-based month, so every case states the range it
// requests — and that importing the module hands over resolveDays without
// starting a fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveDays } from '../scripts/fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fetchScript = path.join(here, '..', 'scripts', 'fetch.mjs');

function dateStrs(from, through) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${through}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

test('an explicit inclusive range resolves each day with its year/month/day', () => {
  const days = resolveDays('2026-08-01', '2026-08-03');
  assert.deepEqual(days, [
    { year: 2026, month: 8, day: 1, dateStr: '2026-08-01' },
    { year: 2026, month: 8, day: 2, dateStr: '2026-08-02' },
    { year: 2026, month: 8, day: 3, dateStr: '2026-08-03' },
  ]);
});

test('a single-day range resolves to exactly that day', () => {
  assert.deepEqual(resolveDays('2026-08-24', '2026-08-24'), [
    { year: 2026, month: 8, day: 24, dateStr: '2026-08-24' },
  ]);
});

test('a range crossing a leap day includes Feb 29', () => {
  // 2028 is a leap year; the same range in 2026 (not a leap year) has one fewer day.
  const leapDays = resolveDays('2028-02-27', '2028-03-02');
  assert.deepEqual(leapDays.map((d) => d.dateStr), ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02']);

  const nonLeapDays = resolveDays('2026-02-27', '2026-03-02');
  assert.deepEqual(nonLeapDays.map((d) => d.dateStr), dateStrs('2026-02-27', '2026-03-02'));
  assert.equal(nonLeapDays.some((d) => d.dateStr === '2026-02-29'), false);
});

test('a missing FROM_DAY or THROUGH_DAY throws', () => {
  assert.throws(() => resolveDays(undefined, '2026-08-24'), /FROM_DAY is not set/);
  assert.throws(() => resolveDays('2026-08-01', undefined), /THROUGH_DAY is not set/);
});

test('a malformed date throws', () => {
  assert.throws(() => resolveDays('2026/08/01', '2026-08-24'), /FROM_DAY must be an ISO UTC date/);
  assert.throws(() => resolveDays('2026-08-01', 'not-a-date'), /THROUGH_DAY must be an ISO UTC date/);
});

test('an impossible calendar date throws', () => {
  assert.throws(() => resolveDays('2026-02-30', '2026-03-01'), /FROM_DAY is not a valid calendar date/);
  assert.throws(() => resolveDays('2026-08-01', '2026-04-31'), /THROUGH_DAY is not a valid calendar date/);
});

test('a reversed range throws', () => {
  assert.throws(() => resolveDays('2026-08-24', '2026-08-01'), /FROM_DAY \(2026-08-24\) must not be after THROUGH_DAY \(2026-08-01\)/);
});

// `node -e` leaves process.argv[1] unset, so the entry-point guard has to cope with
// having no script path. The token, org, and range are cleared: were the guard to let
// main run, it would exit non-zero and fail this call rather than pass silently.
test('importing the module yields resolveDays without running the fetch', () => {
  const env = { ...process.env };
  delete env.AI_USAGE_PAT;
  delete env.ORG;
  delete env.FROM_DAY;
  delete env.THROUGH_DAY;
  const script = `import(${JSON.stringify(pathToFileURL(fetchScript).href)})` +
    `.then((m) => console.log(typeof m.resolveDays))`;
  // execPath, not "node": the guard is runtime behavior, so it has to be exercised
  // against the same interpreter running this suite.
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
  assert.equal(out.trim(), 'function');
});
