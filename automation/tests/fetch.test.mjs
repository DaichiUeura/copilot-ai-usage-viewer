// Behavior tests for fetch.mjs (run with: node --test).
// Asserts which days resolveDays picks: the current month runs to today, any other
// month is taken in full, and YEAR/MONTH selects a month explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDays } from '../scripts/fetch.mjs';

// resolveDays reads YEAR/MONTH from the environment, so every case states both —
// undefined meaning "not set" — rather than inheriting whatever the shell exports.
function withEnv({ YEAR, MONTH }, fn) {
  const saved = { YEAR: process.env.YEAR, MONTH: process.env.MONTH };
  const apply = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply({ YEAR, MONTH });
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

function range(from, to) {
  const out = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}

const noOverride = { YEAR: undefined, MONTH: undefined };

test('mid-month: the current month up to today', () => {
  const r = withEnv(noOverride, () => resolveDays(new Date('2026-08-24T05:00:00Z')));
  assert.deepEqual(r, { year: 2026, month: 8, days: range(1, 24) });
});

test('last day of the month: the current month in full', () => {
  const r = withEnv(noOverride, () => resolveDays(new Date('2026-08-31T23:00:00Z')));
  assert.deepEqual(r, { year: 2026, month: 8, days: range(1, 31) });
});

test('1st of the month: the previous month in full', () => {
  const r = withEnv(noOverride, () => resolveDays(new Date('2026-08-01T05:00:00Z')));
  assert.deepEqual(r, { year: 2026, month: 7, days: range(1, 31) });
});

test('YEAR/MONTH selecting a past month: that month in full', () => {
  const r = withEnv({ YEAR: '2026', MONTH: '6' }, () =>
    resolveDays(new Date('2026-08-24T05:00:00Z')));
  assert.deepEqual(r, { year: 2026, month: 6, days: range(1, 30) });
});

test('YEAR/MONTH selecting the current month: still stops at today', () => {
  const r = withEnv({ YEAR: '2026', MONTH: '8' }, () =>
    resolveDays(new Date('2026-08-24T05:00:00Z')));
  assert.deepEqual(r, { year: 2026, month: 8, days: range(1, 24) });
});
