const path = require('path');
const { test, expect } = require('@playwright/test');
const fs = require('fs');

const appUrl = `file://${path.resolve(__dirname, '..', '..', 'index.html')}`;
const sampleCsv = path.resolve(__dirname, '..', '..', 'assets', 'sample-ai-usage-report.csv');
const sampleCsvText = fs.readFileSync(sampleCsv, 'utf8');

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

async function loadSampleViaUpload(page) {
  await page.goto(appUrl);
  await page.locator('#fileInput').setInputFiles(sampleCsv);
  await expect(page.locator('#dashboard')).toBeVisible();
}

test('loads the sample CSV with actual consumption as the default view', async ({ page }) => {
  await loadSampleViaUpload(page);

  await expect(page.locator('#subtitle')).toContainText('Example Labs');
  await expect(page.locator('#costBadges .cost-stat').first()).toContainText('$65.81');
  await expect(page.locator('#validationBanner')).toContainText('Row total $65.81');

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
  await expect(page.locator('#validationBanner')).toContainText('Row total $40.41');

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
    return page.evaluate(() => window.__chartStubs.map(chart => chart.resizeCount));
  }).toEqual(before.map(count => count + 2));
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