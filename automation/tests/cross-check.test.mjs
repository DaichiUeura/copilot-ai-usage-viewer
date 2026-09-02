// Behavior tests for cross-check.mjs (run with: node --test).
// Asserts the advisory billing-vs-Members validator: it compares only days
// both feeds cover within the requested range, applies the >1-credit
// tolerance, counts only credit-priced billing items, skips a day either feed
// left unreadable, skips cleanly when Members has no data, and never exits
// non-zero over a discrepancy (only a misconfigured range is a script error).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'cross-check.mjs');

function writeBillingDir(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-raw-'));
  for (const [day, total] of Object.entries(days)) {
    fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify({
      organization: 'Example Org',
      usageItems: [
        { sku: 'Copilot AI Credits', unitType: 'ai-credits', grossQuantity: total - 1 },
        { sku: 'Copilot Cloud Agent', unitType: 'ai-credits', grossQuantity: 1 },
      ],
    }));
  }
  return dir;
}

function writeMembersDir(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'members-raw-'));
  for (const [day, users] of Object.entries(days)) {
    const rows = Object.entries(users).map(([user_login, credits]) => ({ day, user_login, ai_credits_used: credits }));
    fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify(rows));
  }
  return dir;
}

function run(rawDir, usersRawDir, opts = {}) {
  const fromDay = opts.fromDay !== undefined ? opts.fromDay : '2026-05-01';
  const throughDay = opts.throughDay !== undefined ? opts.throughDay : '2026-05-09';
  return execFileSync('node', [script], {
    env: { ...process.env, RAW_DIR: rawDir, USERS_RAW_DIR: usersRawDir, FROM_DAY: fromDay, THROUGH_DAY: throughDay },
    encoding: 'utf8',
  });
}

function expectFailure(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected a non-zero exit');
}

test('agreeing daily totals produce no warning', () => {
  const billing = writeBillingDir({ '2026-05-04': 1242, '2026-05-05': 5 });
  const members = writeMembersDir({ '2026-05-04': { alice: 1242 }, '2026-05-05': { bob: 5 } });
  const stdout = run(billing, members);
  assert.match(stdout, /Cross-check: 2 shared day\(s\), 0 over 1 credit\(s\)/);
});

test('a difference over the tolerance is logged, and only shared days are compared', () => {
  const billing = writeBillingDir({ '2026-05-04': 1300, '2026-05-09': 999 }); // 05-09 outside Members data
  const members = writeMembersDir({ '2026-05-04': { alice: 1242 }, '2026-05-06': { bob: 5 } }); // 05-06 outside billing data
  const stdout = run(billing, members);
  assert.match(stdout, /Cross-check 2026-05-04: 1242 credits \(Members\) vs 1300 \(billing\), diff 58\.0000/);
  assert.match(stdout, /Cross-check: 1 shared day\(s\), 1 over 1 credit\(s\)/);
});

test('an empty Members day still counts as a shared day worth comparing', () => {
  const billing = writeBillingDir({ '2026-05-04': 100, '2026-05-05': 900 });
  const members = writeMembersDir({ '2026-05-04': { alice: 100 }, '2026-05-05': {} }); // fetched, but nobody used credits
  const stdout = run(billing, members);
  assert.match(stdout, /Cross-check 2026-05-05: 0 credits \(Members\) vs 900 \(billing\), diff 900\.0000/);
  assert.match(stdout, /Cross-check: 2 shared day\(s\), 1 over 1 credit\(s\)/);
});

test('skips cleanly when Members has no data published', () => {
  const billing = writeBillingDir({ '2026-05-04': 100 });
  const emptyMembers = fs.mkdtempSync(path.join(os.tmpdir(), 'members-empty-'));
  const stdout = run(billing, emptyMembers);
  assert.match(stdout, /Cross-check skipped: no Members data/);
});

test('skips cleanly when billing has no data in range', () => {
  const members = writeMembersDir({ '2026-05-04': { alice: 5 } });
  const emptyBilling = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-empty-'));
  const stdout = run(emptyBilling, members);
  assert.match(stdout, /Cross-check skipped: no billing data/);
});

test('only compares days within the requested range', () => {
  const billing = writeBillingDir({ '2026-05-04': 100, '2026-05-20': 500 });
  const members = writeMembersDir({ '2026-05-04': { alice: 100 }, '2026-05-20': { alice: 1 } }); // 05-20 out of range below
  const stdout = run(billing, members, { fromDay: '2026-05-01', throughDay: '2026-05-10' });
  assert.match(stdout, /Cross-check: 1 shared day\(s\), 0 over 1 credit\(s\)/);
});

test('a Members day that cannot be read is skipped, not compared as zero', () => {
  const billing = writeBillingDir({ '2026-05-04': 1242, '2026-05-05': 900 });
  const members = writeMembersDir({ '2026-05-04': { alice: 1242 } });
  fs.writeFileSync(path.join(members, '2026-05-05.json'), '[{"day": "2026-05-05"'); // truncated
  const stdout = run(billing, members);
  // Reading the truncated day as an empty array would invent a 900-credit gap.
  assert.doesNotMatch(stdout, /Cross-check 2026-05-05/);
  assert.match(stdout, /Cross-check: 1 shared day\(s\), 0 over 1 credit\(s\)/);
});

test('a billing item priced in another unit stays out of the credits total', () => {
  const billing = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-raw-'));
  fs.writeFileSync(path.join(billing, '2026-05-04.json'), JSON.stringify({
    usageItems: [
      { sku: 'Copilot AI Credits', unitType: 'ai-credits', grossQuantity: 1242 },
      { sku: 'Something Else', unitType: 'gb-hours', grossQuantity: 500 },
    ],
  }));
  const members = writeMembersDir({ '2026-05-04': { alice: 1242 } });
  const stdout = run(billing, members);
  assert.match(stdout, /Cross-check: 1 shared day\(s\), 0 over 1 credit\(s\)/);
});

test('never fails the job over a discrepancy', () => {
  const billing = writeBillingDir({ '2026-05-04': 99999 });
  const members = writeMembersDir({ '2026-05-04': { alice: 1 } });
  assert.doesNotThrow(() => run(billing, members));
});

test('rejects a missing or invalid FROM_DAY/THROUGH_DAY', () => {
  const billing = writeBillingDir({ '2026-05-04': 100 });
  const members = writeMembersDir({ '2026-05-04': { alice: 100 } });
  const err = expectFailure(() => run(billing, members, { fromDay: '' }));
  assert.match(err.stderr, /FROM_DAY is not set/);
});
