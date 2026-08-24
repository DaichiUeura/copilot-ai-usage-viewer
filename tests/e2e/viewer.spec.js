const path = require('path');
const { test, expect } = require('@playwright/test');
const fs = require('fs');

const appUrl = `file://${path.resolve(__dirname, '..', '..', 'index.html')}`;
const sampleCsv = path.resolve(__dirname, '..', '..', 'assets', 'sample-ai-usage-report.csv');
const standardUsageCsv = path.resolve(__dirname, 'fixtures', 'aic-all-zero-standard-usage.csv');
const allZeroCsv = path.resolve(__dirname, 'fixtures', 'all-zero-usage.csv');
const meteredCsv = path.resolve(__dirname, 'fixtures', 'metered-usage.csv');
const orgTotalCsv = path.resolve(__dirname, 'fixtures', 'org-total.csv');
const dateGapCsv = path.resolve(__dirname, 'fixtures', 'date-gap.csv');
const manyModelsCsv = path.resolve(__dirname, 'fixtures', 'many-models.csv');
const perUserNoNetCsv = path.resolve(__dirname, 'fixtures', 'per-user-no-net.csv');
const perUserMismatchCsv = path.resolve(__dirname, 'fixtures', 'per-user-day-mismatch.csv');
const sampleCsvText = fs.readFileSync(sampleCsv, 'utf8');
const allZeroCsvText = fs.readFileSync(allZeroCsv, 'utf8');
const orgTotalCsvText = fs.readFileSync(orgTotalCsv, 'utf8');
const perUserNoNetCsvText = fs.readFileSync(perUserNoNetCsv, 'utf8');
const perUserMismatchCsvText = fs.readFileSync(perUserMismatchCsv, 'utf8');

function serveCsv(page, url, body) {
  return page.route(url, route => route.fulfill({
    status: 200,
    headers: {
      'access-control-allow-origin': '*',
      'content-type': 'text/csv; charset=utf-8',
    },
    body,
  }));
}

test.beforeEach(async ({ page }) => {
  await page.route('**/chart.umd.min.js', route => route.abort());
  await page.addInitScript(() => {
    window.__chartStubs = [];
    if (!window.Chart) {
      class ChartStub {
        constructor(ctx, config) {
          this.ctx = ctx;
          this.config = config;
          this.resizeCount = 0;
          window.__chartStubs.push(this);
        }

        resize() {
          this.resizeCount += 1;
        }

        destroy() {
          const i = window.__chartStubs.indexOf(this);
          if (i >= 0) window.__chartStubs.splice(i, 1);
        }
      }

      ChartStub.defaults = { color: '', borderColor: '' };
      window.Chart = ChartStub;
    }
  });
});

async function loadCsvViaUpload(page, csvPath) {
  await page.goto(appUrl);
  await page.locator('#fileInput').setInputFiles(csvPath);
  await expect(page.locator('#dashboard')).toBeVisible();
}

async function loadSampleViaUpload(page) {
  await loadCsvViaUpload(page, sampleCsv);
}

test('loads the sample CSV and totals the standard billing columns', async ({ page }) => {
  await loadSampleViaUpload(page);

  await expect(page.locator('#subtitle')).toContainText('Example Labs');
  // Single basis = standard gross_amount column ($72.08)
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$72.08');
  // No validation issues: the banner stays empty (no "all clear" line).
  await expect(page.locator('#validationBanner')).toBeEmpty();

  // Mode switch and Compare view have been removed
  await page.locator('#menuBtn').click();
  await expect(page.locator('#headerMenu')).toBeVisible();
  await expect(page.locator('#modeActualBtn')).toHaveCount(0);
  await expect(page.locator('#modeCompatibleBtn')).toHaveCount(0);
  await expect(page.locator('#compareViewBtn')).toHaveCount(0);
});

test('resizes overview charts when the viewport shrinks', async ({ page }) => {
  await loadSampleViaUpload(page);

  const before = await page.evaluate(() => window.__chartStubs.map(chart => chart.resizeCount));

  await page.setViewportSize({ width: 640, height: 900 });

  await expect.poll(async () => {
    const after = await page.evaluate(() => window.__chartStubs.map(chart => chart.resizeCount));
    return after.every((count, i) => count >= before[i] + 2);
  }).toBeTruthy();
});

test('loads a CSV from the csv query parameter', async ({ page }) => {
  await page.route('https://example.test/sample-ai-usage-report.csv', route => {
    route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'text/csv; charset=utf-8',
      },
      body: sampleCsvText,
    });
  });

  await page.goto(`${appUrl}?csv=https://example.test/sample-ai-usage-report.csv&tab=members`);

  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#members.panel.active')).toBeVisible();
  await expect(page.locator('#headerMeta')).toHaveText('sample-ai-usage-report.csv');
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$72.08');
});

test('renders an all-zero file with zero totals', async ({ page }) => {
  await page.route('https://example.test/all-zero-usage.csv', route => {
    route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'text/csv; charset=utf-8',
      },
      body: allZeroCsvText,
    });
  });

  await page.goto(`${appUrl}?csv=https://example.test/all-zero-usage.csv`);

  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$0.00');
  await expect(page.locator('#validationBanner')).toBeEmpty();
});

// Helper to get a chart stub's config by canvas element id
async function getChartConfig(page, canvasId) {
  return page.evaluate(id => {
    const stub = window.__chartStubs.find(s => s.ctx && s.ctx.canvas && s.ctx.canvas.id === id);
    return stub ? stub.config : null;
  }, canvasId);
}

test('overview cumulative chart adds net line and exhaustion plugin when metered usage exists', async ({ page }) => {
  await loadCsvViaUpload(page, meteredCsv);

  // Net badge shows non-zero amber value (total net = 0.70+1.60+1.80+1.20 = 5.30)
  const netStat = page.locator('#costBadges .cost-stat').nth(1);
  await expect(netStat).toContainText('$5.30');

  const cumConfig = await getChartConfig(page, 'chartCumulative');
  // Two datasets: Cumulative Gross + Cumulative Net
  expect(cumConfig.data.datasets).toHaveLength(2);
  expect(cumConfig.data.datasets[0].label).toBe('Cumulative Gross ($)');
  expect(cumConfig.data.datasets[1].label).toBe('Cumulative Net ($)');
  // Exhaustion line plugin attached
  expect(cumConfig.plugins.some(p => p.id === 'exhaustionLine')).toBe(true);
  // Net line starts at pool exhaustion date (06-03); prior dates are null
  const cumLabels = cumConfig.data.labels;
  const netData = cumConfig.data.datasets[1].data;
  expect(netData[cumLabels.indexOf('06-01')]).toBeNull();
  expect(netData[cumLabels.indexOf('06-02')]).toBeNull();
  expect(netData[cumLabels.indexOf('06-03')]).not.toBeNull();
});

test('overview daily-total chart is stacked covered/metered bars', async ({ page }) => {
  await loadCsvViaUpload(page, meteredCsv);

  const dtConfig = await getChartConfig(page, 'chartDateTotal');
  // Two datasets: Covered + Metered
  expect(dtConfig.data.datasets).toHaveLength(2);
  expect(dtConfig.data.datasets[0].label).toBe('Covered ($)');
  expect(dtConfig.data.datasets[1].label).toBe('Metered ($)');
  // Stacked axes
  expect(dtConfig.options.scales.y.stacked).toBe(true);
  expect(dtConfig.options.scales.x.stacked).toBe(true);
  // Exhaustion line plugin attached
  expect(dtConfig.plugins.some(p => p.id === 'exhaustionLine')).toBe(true);

  // Covered values: gross - net per day
  // day3: 1.50+2.00 - (0.70+1.60) = 3.50-2.30=1.20, day4: 3.00-3.00=0.00
  const labels = dtConfig.data.labels;
  const coveredData = dtConfig.data.datasets[0].data;
  const meteredData = dtConfig.data.datasets[1].data;
  const idx3 = labels.indexOf('06-03');
  const idx4 = labels.indexOf('06-04');
  expect(coveredData[idx3]).toBeCloseTo(1.20, 2);
  expect(meteredData[idx3]).toBeCloseTo(2.30, 2);
  expect(coveredData[idx4]).toBeCloseTo(0.00, 2);
  expect(meteredData[idx4]).toBeCloseTo(3.00, 2);
});

async function openMembersTab(page) {
  // A CSV that only Members can answer opens there with no tab strip to click.
  const tab = page.locator('.tab[data-tab="members"]');
  if (await tab.isVisible()) await tab.click();
  await expect(page.locator('#members.panel.active')).toBeVisible();
}

test('members tab ranks members by Gross and by Net in separate charts', async ({ page }) => {
  await loadCsvViaUpload(page, meteredCsv);
  await openMembersTab(page);

  // Left: ranked by Gross desc. alice 5.50 > bob 5.00.
  const gross = await getChartConfig(page, 'chartTotal');
  expect(gross.data.labels).toEqual(['alice', 'bob']);
  expect(gross.data.datasets[0].label).toBe('Gross ($)');
  expect(gross.data.datasets[0].backgroundColor).toBe('#58a6ff');

  // Right: ranked by Net desc, which differs — bob 2.80 > alice 2.50.
  const net = await getChartConfig(page, 'chartTotalNet');
  expect(net.data.labels).toEqual(['bob', 'alice']);
  expect(net.data.datasets[0].label).toBe('Net ($)');
  expect(net.data.datasets[0].backgroundColor).toBe('#d29922');
  expect(net.data.datasets[0].data[0]).toBeCloseTo(2.80, 2);

  await expect(page.locator('#membersNetEmpty')).toBeHidden();
});

// Every per-member view answers the same question — who spent what — so they all
// live under Members. Overview and Members are the only two tabs.
test('Members carries the daily trend and the member/model breakdown', async ({ page }) => {
  await loadCsvViaUpload(page, meteredCsv);
  await expect(page.locator('#detailTabs .tab')).toHaveCount(2);
  await openMembersTab(page);

  expect(await getChartConfig(page, 'chartDaily')).not.toBeNull();
  expect(await getChartConfig(page, 'chartModel')).not.toBeNull();
  await expect(page.locator('#memberModelCard')).toBeVisible();
});

// A feed that reports per-user consumption reports one model label for everyone,
// so there is no per-member model split to draw.
test('member/model chart is dropped when the CSV reports a single model', async ({ page }) => {
  await loadCsvViaUpload(page, perUserNoNetCsv);
  await openMembersTab(page);

  expect(await getChartConfig(page, 'chartModel')).toBeNull();
  await expect(page.locator('#memberModelCard')).toBeHidden();
  // The detail table drops its top-model column for the same reason.
  await expect(page.locator('#tableMain th', { hasText: 'Top Model' })).toHaveCount(0);

  // The rest of the Members views still have their axes.
  const gross = await getChartConfig(page, 'chartTotal');
  expect(gross.data.labels).toEqual(['alpha-user', 'beta-user', 'gamma-user']);
  expect(await getChartConfig(page, 'chartDaily')).not.toBeNull();
});

// The share column answers what fraction of the bill a member accounts for, so it
// is measured against the total, not against whoever spent the most.
test('Usage Share is each member share of the total gross', async ({ page }) => {
  await loadCsvViaUpload(page, meteredCsv);   // alice 5.50, bob 5.00, total 10.50
  await openMembersTab(page);

  const shares = page.locator('#tableMain td:nth-child(5)');
  await expect(shares.nth(0)).toContainText('52.4%');
  await expect(shares.nth(1)).toContainText('47.6%');
});

test('members Net chart is replaced by a caption when nothing is metered', async ({ page }) => {
  await loadCsvViaUpload(page, standardUsageCsv);
  await openMembersTab(page);

  expect(await getChartConfig(page, 'chartTotal')).not.toBeNull();
  expect(await getChartConfig(page, 'chartTotalNet')).toBeNull();
  await expect(page.locator('#membersNetEmpty')).toBeVisible();
});

// A day with no usage produces no CSV rows. The fixture has rows on 06-01, 06-02
// and 06-04, leaving a gap on 06-03 that should render as an explicit zero so the
// date axis stays evenly spaced. Nothing follows the last row (no trailing fill).
// An empty net_amount means the CSV does not carry what the organization is
// billed. Reading it as 0 would report the usage as fully covered — the one
// answer the file cannot support.
test('a CSV with no net_amount reports Net as not available, never as covered', async ({ page }) => {
  await loadCsvViaUpload(page, perUserNoNetCsv);

  // Overview answers what the organization is billed, so it has no input here.
  await expect(page.locator('.tab[data-tab="overview"]')).toBeHidden();
  await expect(page.locator('#members.panel.active')).toBeVisible();

  const badges = page.locator('#costBadges .cost-stat');
  await expect(badges.nth(0)).toContainText('$11.20');   // Gross still adds up
  await expect(badges.nth(1)).toContainText('—');
  await expect(badges.nth(1)).not.toContainText('$0.00');
  await expect(badges.nth(1)).not.toContainText('Covered by included usage');
  await expect(badges.nth(2)).toContainText('—');
  await expect(badges.nth(2)).not.toContainText('100.0%');

  // The Net ranking says why it is empty, and does not claim full coverage.
  expect(await getChartConfig(page, 'chartTotalNet')).toBeNull();
  await expect(page.locator('#membersNetEmpty')).toContainText('not available');
  await expect(page.locator('#membersNetEmpty')).not.toContainText('fully covered');

  // The detail table keeps the Net column so the gap stays visible.
  const netCells = page.locator('#tableMain td:nth-child(4)');  // header row is th
  await expect(netCells).toHaveCount(3);
  await expect(netCells.first()).toHaveText('—');
});

// A net_amount of "0" is a real zero: that usage was billed at nothing because
// the included pool covered it. Only a blank column means not available.
test('a net_amount of zero still reads as fully covered', async ({ page }) => {
  await loadCsvViaUpload(page, standardUsageCsv);

  const badges = page.locator('#costBadges .cost-stat');
  await expect(badges.nth(1)).toContainText('$0.00');
  await expect(badges.nth(1)).toContainText('Covered by included usage');
  await expect(badges.nth(2)).toContainText('100.0%');
  await expect(page.locator('.tab[data-tab="overview"]')).toBeVisible();
});

// No single feed answers both questions, so two CSVs can be open at once: the
// billing one drives Overview, the per-user one drives Members.
test('two CSVs drive Overview and Members from their own feed', async ({ page }) => {
  await serveCsv(page, 'https://example.test/org.csv', orgTotalCsvText);
  await serveCsv(page, 'https://example.test/users.csv', perUserNoNetCsvText);
  await page.goto(`${appUrl}?csv=https://example.test/org.csv&users_csv=https://example.test/users.csv`);
  await expect(page.locator('#dashboard')).toBeVisible();

  // Both tabs have an answer now, and the badges come from the billing feed.
  await expect(page.locator('#detailTabs .tab')).toHaveCount(2);
  const badges = page.locator('#costBadges .cost-stat');
  await expect(badges.nth(1)).toContainText('$1.50');
  await expect(badges.nth(2)).toContainText('81.3%');

  // Overview is the billing feed: metered from 05-03, so a Net line and the marker.
  const cum = await getChartConfig(page, 'chartCumulative');
  expect(cum.data.datasets).toHaveLength(2);
  expect(cum.plugins.some(p => p.id === 'exhaustionLine')).toBe(true);

  // Members is the per-user feed, which the billing feed has no rows for.
  await openMembersTab(page);
  const gross = await getChartConfig(page, 'chartTotal');
  expect(gross.data.labels).toEqual(['alpha-user', 'beta-user', 'gamma-user']);
  expect(await getChartConfig(page, 'chartTotalNet')).toBeNull();

  // Gross alone says nothing about cost until the pool is known to have run out.
  await expect(page.locator('#membersOrgContext')).toContainText('2026-05-03');
});

// The feeds have independent timelines — their histories can start apart and
// their newest day can differ — so no view may imply a range it does not cover.
test('each panel names its own file, date range and basis', async ({ page }) => {
  await serveCsv(page, 'https://example.test/org.csv', orgTotalCsvText);
  await serveCsv(page, 'https://example.test/users.csv', perUserNoNetCsvText);
  await page.goto(`${appUrl}?csv=https://example.test/org.csv&users_csv=https://example.test/users.csv`);
  await expect(page.locator('#dashboard')).toBeVisible();

  await expect(page.locator('#overviewCaption')).toContainText('org.csv');
  await expect(page.locator('#overviewCaption')).toContainText('2026-05-01');
  await expect(page.locator('#overviewCaption')).toContainText('2026-05-03');
  await expect(page.locator('#overviewCaption')).toContainText('Gross and Net');

  await expect(page.locator('#membersCaption')).toContainText('users.csv');
  await expect(page.locator('#membersCaption')).toContainText('2026-04-29');
  await expect(page.locator('#membersCaption')).toContainText('2026-05-03');
  await expect(page.locator('#membersCaption')).toContainText('Net not available');

  // The header no longer claims one range for both feeds.
  await expect(page.locator('#subtitle')).not.toContainText('2026-');
});

// A dropped file carries no parameter name, so content decides the slot — and the
// same rule applies to URLs, which makes the two parameters interchangeable.
test('the slot a CSV lands in follows its content, not the parameter it came from', async ({ page }) => {
  await serveCsv(page, 'https://example.test/a.csv', perUserNoNetCsvText);
  await serveCsv(page, 'https://example.test/b.csv', orgTotalCsvText);
  await page.goto(`${appUrl}?csv=https://example.test/a.csv&users_csv=https://example.test/b.csv`);
  await expect(page.locator('#dashboard')).toBeVisible();

  await expect(page.locator('#overviewCaption')).toContainText('b.csv');
  await expect(page.locator('#membersCaption')).toContainText('a.csv');
});

test('dropping both CSVs at once loads them together', async ({ page }) => {
  await page.goto(appUrl);
  await page.locator('#fileInput').setInputFiles([orgTotalCsv, perUserNoNetCsv]);
  await expect(page.locator('#dashboard')).toBeVisible();

  await expect(page.locator('#headerMeta')).toContainText('org-total.csv');
  await expect(page.locator('#headerMeta')).toContainText('per-user-no-net.csv');
  await expect(page.locator('#detailTabs .tab')).toHaveCount(2);
});

// Two feeds rarely cover the same span, so differing totals are the normal case and
// say nothing on their own. Only a disagreement where they do overlap is reported.
test('two CSVs that agree where they overlap raise nothing', async ({ page }) => {
  await page.goto(appUrl);
  await page.locator('#fileInput').setInputFiles([orgTotalCsv, perUserNoNetCsv]);
  await expect(page.locator('#dashboard')).toBeVisible();

  await expect(page.locator('#validationBanner')).toBeEmpty();
});

// Opening a CSV replaces what is on screen, so a drop reads the same whether the
// drop zone or a dashboard is showing.
test('opening a CSV over a loaded dashboard replaces it rather than adding to it', async ({ page }) => {
  await page.goto(appUrl);
  await page.locator('#fileInput').setInputFiles([orgTotalCsv, perUserNoNetCsv]);
  await expect(page.locator('#headerMeta')).toContainText('per-user-no-net.csv');

  await page.locator('#fileInput').setInputFiles(meteredCsv);
  await expect(page.locator('#headerMeta')).toHaveText('metered-usage.csv');
  await expect(page.locator('#membersCaption')).toContainText('metered-usage.csv');
});

test('two CSVs that disagree on a shared day raise a warning', async ({ page }) => {
  await page.goto(appUrl);
  await page.locator('#fileInput').setInputFiles([orgTotalCsv, perUserMismatchCsv]);
  await expect(page.locator('#dashboard')).toBeVisible();

  const banner = page.locator('#validationBanner .vb-full.warn');
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText('disagree on 1 of the 3 days');
  await expect(banner).toContainText('$0.60');
});

// Feeds sitting a month apart is a normal state while one has rolled over to a new
// month and the other has not, so this is context rather than a warning.
test('two CSVs from different periods note that nothing ties them together', async ({ page }) => {
  await page.goto(appUrl);
  await page.setInputFiles('#fileInput', [
    { name: 'org-total.csv', mimeType: 'text/csv', buffer: Buffer.from(orgTotalCsvText) },
    { name: 'january.csv', mimeType: 'text/csv',
      buffer: Buffer.from(perUserNoNetCsvText.replace(/2026-04/g, '2026-01').replace(/2026-05/g, '2026-02')) },
  ]);
  await expect(page.locator('#dashboard')).toBeVisible();

  await expect(page.locator('#validationBanner .vb-full')).toHaveCount(0);
  await expect(page.locator('#validationBanner .vb-note-head')).toContainText('no day in common');
});

// Two organizations on one screen is the reading the viewer must not let pass
// quietly: every amount below would be a mix of both.
test('two CSVs that do not name the same organization raise a warning', async ({ page }) => {
  await page.goto(appUrl);
  await page.setInputFiles('#fileInput', [
    { name: 'org-total.csv', mimeType: 'text/csv', buffer: Buffer.from(orgTotalCsvText) },
    { name: 'other-org.csv', mimeType: 'text/csv',
      buffer: Buffer.from(perUserNoNetCsvText.replace(/Example Org/g, 'Other Org')) },
  ]);
  await expect(page.locator('#dashboard')).toBeVisible();

  const banner = page.locator('#validationBanner .vb-full.warn');
  await expect(banner).toContainText('do not name the same organization');
  await expect(banner).toContainText('Other Org');
});

// A CSV that names no organization cannot be shown to be the same one, and the
// subtitle would otherwise present the other file's name as covering both.
test('an unnamed organization is reported rather than assumed to match', async ({ page }) => {
  await page.goto(appUrl);
  await page.setInputFiles('#fileInput', [
    { name: 'org-blank.csv', mimeType: 'text/csv',
      buffer: Buffer.from(orgTotalCsvText.replace(/"Example Org"/g, '""')) },
    { name: 'other-org.csv', mimeType: 'text/csv',
      buffer: Buffer.from(perUserNoNetCsvText.replace(/Example Org/g, 'Other Org')) },
  ]);
  await expect(page.locator('#dashboard')).toBeVisible();

  const banner = page.locator('#validationBanner .vb-full.warn');
  await expect(banner).toContainText('do not name the same organization');
  await expect(banner).toContainText('(not named)');
});

// Each slot holds one file, so opening two that report the same thing drops one.
test('a file pushed out by another of the same kind is reported', async ({ page }) => {
  await page.goto(appUrl);
  await page.locator('#fileInput').setInputFiles([orgTotalCsv, meteredCsv]);
  await expect(page.locator('#dashboard')).toBeVisible();

  const banner = page.locator('#validationBanner .vb-full.warn');
  await expect(banner).toContainText('1 file(s) opened but not shown');
  await expect(banner).toContainText('org-total.csv');
});

test('a CSV with no usage rows says so instead of opening an empty dashboard', async ({ page }) => {
  await page.goto(appUrl);
  await page.setInputFiles('#fileInput', {
    name: 'header-only.csv', mimeType: 'text/csv',
    buffer: Buffer.from('date,username,model,gross_amount\n'),
  });

  await expect(page.locator('#dropzone')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
  await expect(page.locator('#dropError')).toContainText('no usage rows');
});

test('date-axis charts fill interior gaps with zeros and do not extend past the last date', async ({ page }) => {
  await loadCsvViaUpload(page, dateGapCsv);

  const dtConfig = await getChartConfig(page, 'chartDateTotal');
  const labels = dtConfig.data.labels;
  // The missing day appears between its neighbors.
  expect(labels).toEqual(['06-01', '06-02', '06-03', '06-04']);
  // The filled day is a true zero, not a skipped point.
  const covered = dtConfig.data.datasets[0].data;
  expect(covered[labels.indexOf('06-03')]).toBeCloseTo(0, 2);

  // Cumulative stays flat across the gap (slope zero), then resumes.
  const cumConfig = await getChartConfig(page, 'chartCumulative');
  const cum = cumConfig.data.datasets[0].data;
  const cLabels = cumConfig.data.labels;
  expect(cum[cLabels.indexOf('06-03')]).toBeCloseTo(cum[cLabels.indexOf('06-02')], 2);
  expect(cum[cLabels.indexOf('06-04')]).toBeGreaterThan(cum[cLabels.indexOf('06-03')]);
});

test('language toggle rebuilds charts so localized series labels follow the language', async ({ page }) => {
  await loadCsvViaUpload(page, meteredCsv);

  const cumEn = await getChartConfig(page, 'chartCumulative');
  expect(cumEn.data.datasets[1].label).toBe('Cumulative Net ($)');

  // Toggle to Japanese: descriptive wrappers localize, billing metrics stay English
  await page.locator('#menuBtn').click();
  await page.locator('#langToggle').click();

  const cumJa = await getChartConfig(page, 'chartCumulative');
  expect(cumJa.data.datasets[1].label).toBe('累積 Net ($)'); // "Cumulative" localized
  const dtJa = await getChartConfig(page, 'chartDateTotal');
  expect(dtJa.data.datasets[1].label).toBe('Metered ($)'); // billing metric stays English
});

test('overview cumulative chart has single dataset when all usage is pool-covered', async ({ page }) => {
  // standard usage with net_amount = 0 throughout → no metered line
  await loadCsvViaUpload(page, standardUsageCsv);

  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$2.50');

  const cumConfig = await getChartConfig(page, 'chartCumulative');
  expect(cumConfig.data.datasets).toHaveLength(1);
  expect(cumConfig.data.datasets[0].label).toBe('Cumulative Gross ($)');
  // Without ?net_limit, the y axis is not stretched to any ceiling.
  expect(cumConfig.options.scales.y.suggestedMax).toBeUndefined();
});

// The ?net_limit= query param overlays an external reference ceiling on the
// cumulative chart's Net line. It is not derived from the CSV.
test('net_limit query param adds the limit-line plugin and stretches the y axis', async ({ page }) => {
  await page.goto(`${appUrl}?net_limit=10000`);
  await page.locator('#fileInput').setInputFiles(meteredCsv);
  await expect(page.locator('#dashboard')).toBeVisible();

  const cumConfig = await getChartConfig(page, 'chartCumulative');
  expect(cumConfig.plugins.some(p => p.id === 'limitLine')).toBe(true);
  expect(cumConfig.options.scales.y.suggestedMax).toBeCloseTo(10500, 2);
});

test('net_limit forces the Net baseline even when all usage is pool-covered', async ({ page }) => {
  // standard usage with net_amount = 0 throughout would normally hide the Net line,
  // but the limit needs its basis on screen, so the Net (zero) baseline is shown.
  await page.goto(`${appUrl}?net_limit=5`);
  await page.locator('#fileInput').setInputFiles(standardUsageCsv);
  await expect(page.locator('#dashboard')).toBeVisible();

  const cumConfig = await getChartConfig(page, 'chartCumulative');
  expect(cumConfig.data.datasets).toHaveLength(2);
  expect(cumConfig.data.datasets[1].label).toBe('Cumulative Net ($)');
  expect(cumConfig.data.datasets[1].data.every(v => v === 0)).toBe(true);
  expect(cumConfig.plugins.some(p => p.id === 'limitLine')).toBe(true);
  expect(cumConfig.options.scales.y.suggestedMax).toBeCloseTo(5.25, 2);
});

// Org-level mode: a CSV with a single distinct username (no per-member breakdown)
// is shown as Overview-only. Uses a static org-total fixture so this stays a pure
// viewer test — the transform that produces such CSVs is covered in automation/test.
test('org-level CSV (single user) hides the Members tab and shows an info banner', async ({ page }) => {
  await loadCsvViaUpload(page, orgTotalCsv);

  await expect(page.locator('#detailTabs')).toBeHidden();
  await expect(page.locator('#overview.panel.active')).toBeVisible();

  // Info is a quiet note, not the prominent warn/err banner: the summary shows
  // without expanding, the detail is hidden until the note is clicked open.
  await expect(page.locator('#validationBanner .vb-full')).toHaveCount(0);
  await expect(page.locator('#validationBanner .vb-note-head')).toContainText('the Members tab is hidden');
  const detail = page.locator('#validationBanner .vb-note-detail');
  await expect(detail).toBeHidden();
  await page.locator('#validationBanner .vb-note-head').click();
  await expect(detail).toBeVisible();

  // Subtitle shows the org but not a member count.
  await expect(page.locator('#subtitle')).toContainText('Example Org');
  await expect(page.locator('#subtitle')).not.toContainText('members');
});

test('org-level Overview still builds cumulative / model-share charts', async ({ page }) => {
  await loadCsvViaUpload(page, orgTotalCsv);

  // Metered begins on 05-03, so cumulative has gross + net and the exhaustion plugin.
  const cum = await getChartConfig(page, 'chartCumulative');
  expect(cum.data.datasets).toHaveLength(2);
  expect(cum.plugins.some(p => p.id === 'exhaustionLine')).toBe(true);
  const labels = cum.data.labels;
  const net = cum.data.datasets[1].data;
  expect(net[labels.indexOf('05-01')]).toBeNull();
  expect(net[labels.indexOf('05-03')]).not.toBeNull();

  // Model share covers both models from the fixture.
  const share = await getChartConfig(page, 'chartModelShare');
  expect(share.data.labels).toContain('Model A');
  expect(share.data.labels).toContain('Model B');
});

test('model-share doughnut folds the long tail into a single Other slice', async ({ page }) => {
  await loadCsvViaUpload(page, manyModelsCsv);

  const share = await getChartConfig(page, 'chartModelShare');
  // 10 models collapse to the top 8 plus one aggregated "Other" slice.
  expect(share.data.labels).toHaveLength(9);
  expect(share.data.labels.slice(0, 8)).toEqual([
    'Model 01', 'Model 02', 'Model 03', 'Model 04',
    'Model 05', 'Model 06', 'Model 07', 'Model 08',
  ]);
  expect(share.data.labels[8]).toBe('Other');
  // Other sums the remaining models (20 + 10) and is drawn in neutral gray.
  expect(share.data.datasets[0].data[8]).toBeCloseTo(30, 2);
  expect(share.data.datasets[0].backgroundColor[8]).toBe('#6e7681');
});

test('multi-user CSV is NOT treated as org-level (regression)', async ({ page }) => {
  await loadCsvViaUpload(page, meteredCsv);

  await expect(page.locator('#detailTabs')).toBeVisible();
  await expect(page.locator('#detailTabs .tab[data-tab="members"]')).toBeVisible();
  await expect(page.locator('#validationBanner')).not.toContainText('the Members tab is hidden');
});
