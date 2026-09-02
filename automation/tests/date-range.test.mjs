// Behavior tests for the shared date-range helper (run with: node --test).
// This is the one place FROM_DAY/THROUGH_DAY validation lives; fetch.mjs,
// transform.mjs, fetch-users.mjs, transform-users.mjs, and cross-check.mjs
// all import it, so its contract is asserted once here rather than per script.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requireDay, requireDayRange, dayRange, addDays } from '../scripts/date-range.mjs';

test('requireDay accepts a valid calendar date', () => {
  assert.equal(requireDay('FROM_DAY', '2026-08-24'), '2026-08-24');
});

test('requireDay rejects a missing value', () => {
  assert.throws(() => requireDay('FROM_DAY', undefined), /FROM_DAY is not set/);
  assert.throws(() => requireDay('FROM_DAY', ''), /FROM_DAY is not set/);
});

test('requireDay rejects a malformed shape', () => {
  assert.throws(() => requireDay('FROM_DAY', '2026/08/24'), /FROM_DAY must be an ISO UTC date/);
  assert.throws(() => requireDay('FROM_DAY', 'yesterday'), /FROM_DAY must be an ISO UTC date/);
});

test('requireDay rejects an impossible calendar date', () => {
  assert.throws(() => requireDay('FROM_DAY', '2026-02-30'), /FROM_DAY is not a valid calendar date/);
  assert.throws(() => requireDay('FROM_DAY', '2026-13-01'), /FROM_DAY is not a valid calendar date/);
});

test('requireDay accepts Feb 29 only in a leap year', () => {
  assert.equal(requireDay('FROM_DAY', '2028-02-29'), '2028-02-29');
  assert.throws(() => requireDay('FROM_DAY', '2026-02-29'), /FROM_DAY is not a valid calendar date/);
});

test('requireDayRange accepts an inclusive range, including a single day', () => {
  assert.deepEqual(requireDayRange('2026-08-01', '2026-08-31'), { fromDay: '2026-08-01', throughDay: '2026-08-31' });
  assert.deepEqual(requireDayRange('2026-08-24', '2026-08-24'), { fromDay: '2026-08-24', throughDay: '2026-08-24' });
});

test('requireDayRange rejects a reversed range', () => {
  assert.throws(
    () => requireDayRange('2026-08-24', '2026-08-01'),
    /FROM_DAY \(2026-08-24\) must not be after THROUGH_DAY \(2026-08-01\)/
  );
});

test('requireDayRange rejects a missing or malformed day', () => {
  assert.throws(() => requireDayRange(undefined, '2026-08-24'), /FROM_DAY is not set/);
  assert.throws(() => requireDayRange('2026-08-01', undefined), /THROUGH_DAY is not set/);
  assert.throws(() => requireDayRange('2026-08-01', '2026-04-31'), /THROUGH_DAY is not a valid calendar date/);
});

test('dayRange lists every day, ascending, including both ends', () => {
  assert.deepEqual(dayRange('2026-08-30', '2026-09-02'), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
});

test('dayRange returns a single day for a single-day range', () => {
  assert.deepEqual(dayRange('2026-08-24', '2026-08-24'), ['2026-08-24']);
});

test('dayRange returns empty when fromDay is after throughDay', () => {
  assert.deepEqual(dayRange('2026-08-24', '2026-08-01'), []);
});

test('addDays crosses a month and a leap day correctly', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01'); // not a leap year
  assert.equal(addDays('2026-09-01', -1), '2026-08-31');
});
