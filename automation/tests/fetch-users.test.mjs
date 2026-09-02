// Behavior tests for fetch-users.mjs (run with: node --test).
// Asserts the pure range-planning logic (planAcquisition) and the end-to-end
// acquisition flow (acquireUsers) against a fake report server — no live API
// call is made. Covers: a report ending before the requested range (normal,
// no-op), a window that fully covers the request, a required one-day
// backfill (both succeeding and failing fatally), days after the window being
// left ungenerated rather than fetched or synthesized, and which of those
// outcomes clear the requested days from a reused acquisition directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { planAcquisition, acquireUsers, AcquisitionExit } from '../scripts/fetch-users.mjs';
import { requireDayRange } from '../scripts/date-range.mjs';

function fakeResponse(status, jsonBody, textBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => jsonBody,
    text: async () => textBody ?? (jsonBody === undefined ? '' : JSON.stringify(jsonBody)),
  };
}

function ndjson(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

test('planAcquisition: a report ending before the requested range is normal, not an error', () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  assert.deepEqual(planAcquisition(range, '2026-05-01', '2026-05-20'), {
    notGeneratedYet: true,
    windowDays: [],
    backfill: [],
  });
});

test('planAcquisition: the 28-day window fully covering the request needs no backfill', () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  assert.deepEqual(planAcquisition(range, '2026-05-10', '2026-06-10'), {
    notGeneratedYet: false,
    windowDays: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'],
    backfill: [],
  });
});

test('planAcquisition: requested days before the window are a required backfill', () => {
  const range = requireDayRange('2026-06-01', '2026-06-30');
  const plan = planAcquisition(range, '2026-06-03', '2026-06-30');
  assert.deepEqual(plan.backfill, ['2026-06-01', '2026-06-02']);
  assert.deepEqual(plan.windowDays[0], '2026-06-03');
});

test('planAcquisition: requested days after report_end_day are left out, not fetched or synthesized', () => {
  const range = requireDayRange('2026-06-01', '2026-06-20');
  const plan = planAcquisition(range, '2026-05-25', '2026-06-15');
  assert.deepEqual(plan.windowDays, [
    '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07',
    '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15',
  ]);
  assert.deepEqual(plan.backfill, []);
  // 2026-06-16..2026-06-20 are simply absent from both lists.
});

test('acquireUsers: a 204 latest report is a normal skip that clears the range', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  const logs = [];
  const removed = [];
  const result = await acquireUsers({
    token: 't', org: 'o', rawDir: '/unused', range,
    fetchImpl: async () => fakeResponse(204),
    log: (m) => logs.push(m),
    mkdir: async () => {},
    remove: async (file) => { removed.push(path.basename(file, '.json')); },
  });
  assert.deepEqual(result, { skipped: true });
  assert.match(logs.join('\n'), /has not been generated yet/);
  // "Nothing generated" is an answer about the range, so a previous run's
  // days must not survive it and be republished as this run's result.
  assert.deepEqual(removed, [
    '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
  ]);
});

test('acquireUsers: an auth/metadata failure on the 28-day report is fatal', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  const removed = [];
  await assert.rejects(
    acquireUsers({
      token: 't', org: 'o', rawDir: '/unused', range,
      fetchImpl: async () => fakeResponse(403, { message: 'Forbidden' }),
      log: () => {},
      mkdir: async () => {},
      remove: async (file) => { removed.push(path.basename(file, '.json')); },
    }),
    (e) => e instanceof AcquisitionExit && e.code === 1
  );
  // A run that never got an answer for the range must leave a reused
  // directory as it found it, rather than emptying it on the way out.
  assert.deepEqual(removed, []);
});

test('acquireUsers: a report missing start/end day or download links is fatal', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  const removed = [];
  await assert.rejects(
    acquireUsers({
      token: 't', org: 'o', rawDir: '/unused', range,
      fetchImpl: async () => fakeResponse(200, { report_start_day: '2026-06-01' }), // no report_end_day, no links
      log: () => {},
      mkdir: async () => {},
      remove: async (file) => { removed.push(path.basename(file, '.json')); },
    }),
    (e) => e instanceof AcquisitionExit && e.code === 1
  );
  assert.deepEqual(removed, []);
});

test('acquireUsers: a report ending before the range saves nothing and does not throw', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  const saved = [];
  const removed = [];
  let directoryCreated = false;
  const result = await acquireUsers({
    token: 't', org: 'o', rawDir: '/unused', range,
    fetchImpl: async (url) => {
      if (url.includes('users-28-day/latest')) {
        return fakeResponse(200, { report_start_day: '2026-05-01', report_end_day: '2026-05-20', download_links: ['https://x/link'] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    log: () => {},
    mkdir: async () => { directoryCreated = true; },
    remove: async (file) => { removed.push(path.basename(file, '.json')); },
    save: async (dir, day, rows) => saved.push([day, rows.length]),
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(directoryCreated, true);
  assert.deepEqual(removed, [
    '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
  ]);
  assert.deepEqual(saved, []);
});

test('acquireUsers: saves window days as-is, including an empty day', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-03');
  const saved = [];
  const order = [];
  const result = await acquireUsers({
    token: 't', org: 'o', rawDir: '/unused', range,
    fetchImpl: async (url) => {
      if (url.includes('users-28-day/latest')) {
        return fakeResponse(200, { report_start_day: '2026-05-10', report_end_day: '2026-06-10', download_links: ['https://x/link'] });
      }
      if (url.includes('/link')) {
        return fakeResponse(200, undefined, ndjson([
          { day: '2026-06-01', user_login: 'alice', ai_credits_used: 5 },
          { day: '2026-06-03', user_login: 'bob', ai_credits_used: 2 },
        ]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    log: () => {},
    mkdir: async () => {},
    remove: async (file) => { order.push(`remove ${path.basename(file, '.json')}`); },
    save: async (dir, day, rows) => { order.push(`save ${day}`); saved.push([day, rows.length]); },
  });
  assert.deepEqual(result, { saved: 3 });
  // Every requested day is cleared once the whole range is in hand, and only
  // then written, so a reused directory holds this run's result or the
  // previous one's — never a mix of the two.
  assert.deepEqual(order, [
    'remove 2026-06-01', 'remove 2026-06-02', 'remove 2026-06-03',
    'save 2026-06-01', 'save 2026-06-02', 'save 2026-06-03',
  ]);
  assert.deepEqual(saved, [
    ['2026-06-01', 1],
    ['2026-06-02', 0], // a day the window covers with no rows is a real empty day
    ['2026-06-03', 1],
  ]);
});

test('acquireUsers: a succeeding required backfill day is saved like any other day', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  const saved = [];
  const result = await acquireUsers({
    token: 't', org: 'o', rawDir: '/unused', range,
    fetchImpl: async (url) => {
      if (url.includes('users-28-day/latest')) {
        return fakeResponse(200, { report_start_day: '2026-06-03', report_end_day: '2026-06-05', download_links: ['https://x/window'] });
      }
      if (url.includes('/window')) {
        return fakeResponse(200, undefined, ndjson([{ day: '2026-06-03', user_login: 'alice', ai_credits_used: 5 }]));
      }
      if (url.includes('users-1-day?day=2026-06-01')) {
        return fakeResponse(200, { download_links: ['https://x/backfill-01'] });
      }
      if (url.includes('/backfill-01')) {
        return fakeResponse(200, undefined, ndjson([{ day: '2026-06-01', user_login: 'alice', ai_credits_used: 1 }]));
      }
      if (url.includes('users-1-day?day=2026-06-02')) {
        return fakeResponse(200, { download_links: [] }); // no rows that day
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    log: () => {},
    mkdir: async () => {},
    save: async (dir, day, rows) => saved.push([day, rows.length]),
  });
  assert.deepEqual(result, { saved: 5 });
  assert.deepEqual(saved.map(([day]) => day), ['2026-06-03', '2026-06-04', '2026-06-05', '2026-06-01', '2026-06-02']);
});

test('acquireUsers: a required backfill day answering 204 is a day with no rows', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  const saved = [];
  const result = await acquireUsers({
    token: 't', org: 'o', rawDir: '/unused', range,
    fetchImpl: async (url) => {
      if (url.includes('users-28-day/latest')) {
        return fakeResponse(200, { report_start_day: '2026-06-03', report_end_day: '2026-06-05', download_links: ['https://x/window'] });
      }
      if (url.includes('/window')) return fakeResponse(200, undefined, '');
      // The 1-day report answers 204 for a day it carries no rows for.
      if (url.includes('users-1-day')) return fakeResponse(204);
      throw new Error(`unexpected fetch: ${url}`);
    },
    log: () => {},
    mkdir: async () => {},
    remove: async () => {},
    save: async (dir, day, rows) => saved.push([day, rows.length]),
  });
  assert.deepEqual(result, { saved: 5 });
  assert.deepEqual(saved, [
    ['2026-06-03', 0], ['2026-06-04', 0], ['2026-06-05', 0],
    ['2026-06-01', 0], ['2026-06-02', 0],
  ]);
});

test('acquireUsers: a report naming its days in some other format is fatal', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-05');
  await assert.rejects(
    acquireUsers({
      token: 't', org: 'o', rawDir: '/unused', range,
      fetchImpl: async () => fakeResponse(200, {
        report_start_day: '2026-06-03T00:00:00Z', // not a plain ISO day
        report_end_day: '2026-06-05',
        download_links: ['https://x/window'],
      }),
      log: () => {},
      mkdir: async () => {},
      remove: async () => {},
    }),
    (e) => e instanceof AcquisitionExit && e.code === 1
  );
});

test('acquireUsers: a required backfill day answering a non-2xx status is fatal', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-02');
  const saved = [];
  const removed = [];
  await assert.rejects(
    acquireUsers({
      token: 't', org: 'o', rawDir: '/unused', range,
      fetchImpl: async (url) => {
        if (url.includes('users-28-day/latest')) {
          return fakeResponse(200, { report_start_day: '2026-06-02', report_end_day: '2026-06-05', download_links: ['https://x/window'] });
        }
        if (url.includes('/window')) return fakeResponse(200, undefined, '');
        if (url.includes('users-1-day')) return fakeResponse(500, { message: 'boom' });
        throw new Error(`unexpected fetch: ${url}`);
      },
      log: () => {},
      mkdir: async () => {},
      remove: async (file) => { removed.push(path.basename(file, '.json')); },
      save: async (dir, day) => { saved.push(day); },
    }),
    (e) => e instanceof AcquisitionExit && e.code === 1
  );
  // A run that stops partway writes nothing and clears nothing, so the
  // directory still holds whatever the previous acquisition left.
  assert.deepEqual(saved, []);
  assert.deepEqual(removed, []);
});

test('acquireUsers: a network error on a required backfill day is fatal', async () => {
  const range = requireDayRange('2026-06-01', '2026-06-02');
  await assert.rejects(
    acquireUsers({
      token: 't', org: 'o', rawDir: '/unused', range,
      fetchImpl: async (url) => {
        if (url.includes('users-28-day/latest')) {
          return fakeResponse(200, { report_start_day: '2026-06-02', report_end_day: '2026-06-05', download_links: ['https://x/window'] });
        }
        if (url.includes('/window')) return fakeResponse(200, undefined, '');
        if (url.includes('users-1-day')) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        throw new Error(`unexpected fetch: ${url}`);
      },
      log: () => {},
      mkdir: async () => {},
      save: async () => {},
    }),
    (e) => e instanceof AcquisitionExit && e.code === 1
  );
});
