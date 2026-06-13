const path = require('path');
const { test, expect } = require('@playwright/test');
const fs = require('fs');

const appUrl = `file://${path.resolve(__dirname, '..', '..', 'index.html')}`;
const sampleCsv = path.resolve(__dirname, '..', '..', 'assets', 'sample-ai-usage-report.csv');
const aicAllZeroCsv = path.resolve(__dirname, 'fixtures', 'aic-all-zero-standard-usage.csv');
const allZeroCsv = path.resolve(__dirname, 'fixtures', 'all-zero-usage.csv');
const meteredCsv = path.resolve(__dirname, 'fixtures', 'metered-usage.csv');
const sampleCsvText = fs.readFileSync(sampleCsv, 'utf8');
const aicAllZeroCsvText = fs.readFileSync(aicAllZeroCsv, 'utf8');
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

        destroy() {}
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

test('loads the sample CSV with actual consumption as the default view', async ({ page }) => {
  await loadSampleViaUpload(page);

  await expect(page.locator('#subtitle')).toContainText('Example Labs');
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$65.81');
  await expect(page.locator('#validationBanner')).toContainText(/Row total:? \$65\.81/);
  await expect(page.locator('#validationBanner .vb-ok')).toContainText('Validation passed');
  await expect(page.locator('#validationBanner details.vb-ok-details')).toBeVisible();
  await expect(page.locator('#validationBanner .vb-ok-body')).toBeHidden();

  await page.locator('#validationBanner details.vb-ok-details summary').click();
  await expect(page.locator('#validationBanner .vb-ok-body')).toBeVisible();
  await expect(page.locator('#validationBanner .vb-ok-body')).toContainText('quantity=0 but aic_gross_amount>0');

  await page.locator('#menuBtn').click();
  await expect(page.locator('#headerMenu')).toBeVisible();
  await expect(page.locator('#modeActualBtn')).toHaveClass(/active/);
  await expect(page.locator('#modeActualBtn')).toHaveAttribute('title', /AI credit-specific|AI credit専用列/);
});

test('switches view basis and opens compare from the header menu', async ({ page }) => {
  await loadSampleViaUpload(page);

  await page.locator('#menuBtn').click();
  await page.locator('#modeCompatibleBtn').click();
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$40.41');
  await expect(page.locator('#validationBanner')).toContainText(/Row total:? \$40\.41/);

  await page.locator('#menuBtn').click();
  await page.locator('#compareViewBtn').click();

  await expect(page.locator('#compare.panel.active')).toBeVisible();
  await expect(page.locator('#detailTabs')).toBeHidden();
  await page.locator('#menuBtn').click();
  await expect(page.locator('#modeSwitch')).toBeHidden();
  await expect(page.locator('#compareSummary')).toContainText('$25.40');
  await expect(page.locator('#compareSummary')).toContainText('2,540');
  await expect(page.locator('#tableCompare')).toContainText('2026-06-04');
  await expect(page.locator('#tableCompare')).toContainText('$24.45');

  await page.locator('#compareViewBtn').click();
  await expect(page.locator('#overview.panel.active')).toBeVisible();
  await expect(page.locator('#detailTabs')).toBeVisible();
  await page.locator('#menuBtn').click();
  await expect(page.locator('#modeSwitch')).toBeVisible();
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

  await page.goto(`${appUrl}?csv=https://example.test/sample-ai-usage-report.csv&tab=members&mode=compatible`);

  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#members.panel.active')).toBeVisible();
  await expect(page.locator('#headerMeta')).toHaveText('sample-ai-usage-report.csv');
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$40.41');
  await page.locator('#menuBtn').click();
  await expect(page.locator('#modeCompatibleBtn')).toHaveClass(/active/);
});

test('auto-switches to compatible when AIC columns total zero but standard columns have usage', async ({ page }) => {
  await loadCsvViaUpload(page, aicAllZeroCsv);

  await expect(page.locator('#subtitle')).toContainText('Example Labs');
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$2.50');
  await expect(page.locator('#validationBanner')).toContainText('GitHub UI compatible');

  await page.locator('#menuBtn').click();
  await expect(page.locator('#modeCompatibleBtn')).toHaveClass(/active/);
  await expect(page.locator('#modeActualBtn')).not.toHaveClass(/active/);
});

test('respects an explicit actual mode query parameter even when auto-switch conditions match', async ({ page }) => {
  await page.route('https://example.test/aic-all-zero-standard-usage.csv', route => {
    route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'text/csv; charset=utf-8',
      },
      body: aicAllZeroCsvText,
    });
  });

  await page.goto(`${appUrl}?csv=https://example.test/aic-all-zero-standard-usage.csv&mode=actual`);

  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$0.00');
  await expect(page.locator('#validationBanner')).not.toContainText('GitHub UI compatible');
  await page.locator('#menuBtn').click();
  await expect(page.locator('#modeActualBtn')).toHaveClass(/active/);
});

test('keeps actual mode for all-zero files with no standard usage', async ({ page }) => {
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
  await expect(page.locator('#validationBanner')).toContainText(/Row total:? \$0\.00/);
  await page.locator('#menuBtn').click();
  await expect(page.locator('#modeActualBtn')).toHaveClass(/active/);
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

test('overview cumulative chart has single dataset when all usage is pool-covered', async ({ page }) => {
  // aic-all-zero auto-switches to compatible mode; net_amount = 0 throughout
  await loadCsvViaUpload(page, aicAllZeroCsv);

  const cumConfig = await getChartConfig(page, 'chartCumulative');
  expect(cumConfig.data.datasets).toHaveLength(1);
  expect(cumConfig.data.datasets[0].label).toBe('Cumulative Gross ($)');
});
