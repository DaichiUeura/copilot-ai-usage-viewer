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
const sampleCsvText = fs.readFileSync(sampleCsv, 'utf8');
const allZeroCsvText = fs.readFileSync(allZeroCsv, 'utf8');

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

// A day with no usage produces no CSV rows. The fixture has rows on 06-01, 06-02
// and 06-04, leaving a gap on 06-03 that should render as an explicit zero so the
// date axis stays evenly spaced. Nothing follows the last row (no trailing fill).
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
test('org-level CSV (single user) hides per-member tabs and shows an info banner', async ({ page }) => {
  await loadCsvViaUpload(page, orgTotalCsv);

  await expect(page.locator('#dashboard')).toHaveClass(/org-level/);
  await expect(page.locator('#detailTabs')).toBeHidden();

  // Info is a quiet note, not the prominent warn/err banner: the summary shows
  // without expanding, the detail is hidden until the note is clicked open.
  await expect(page.locator('#validationBanner .vb-full')).toHaveCount(0);
  await expect(page.locator('#validationBanner .vb-note-head')).toContainText('per-member views hidden');
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

  await expect(page.locator('#dashboard')).not.toHaveClass(/org-level/);
  await expect(page.locator('#detailTabs')).toBeVisible();
  await expect(page.locator('#validationBanner')).not.toContainText('per-member views hidden');
});
