# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A single-file, in-browser **viewer** for the GitHub Copilot AI Usage Report CSV.
Drop a billing export onto `index.html` and it visualizes spend by org, member,
model, and day. CSV is parsed in the browser and never uploaded.

Before proposing or building features, read **[docs/scope.md](docs/scope.md)**.
The short version: it is a *viewer* (describes the loaded CSV — no forecasting or
prediction), kept deliberately simple (no build, no framework, no backend), for a
**Copilot budget owner** (EM / org admin / FinOps), not an analyst or an individual dev.

## Architecture

- **`index.html`** is the entire app (~1100 lines): markup, CSS, and JS in one file.
- **No build step, no framework.** Chart.js 4.4.1 is loaded from a CDN.
- Everything runs client-side. `?csv=<url>` can load a CSV by URL (HTTP(S), ≤10 MB).

Key JS structures inside `index.html`:

- **`I18N`** — `{ en, ja }` translation tables. The app is bilingual; **every
  user-facing string must have both an `en` and a `ja` entry**, referenced via
  `t('key')` or a `data-i18n` attribute.
- **`aggregate(rows)`** — the core reducer. Returns `user_total`, `user_net`,
  `model_total`, `date_total`, `date_net`, quotas, grand totals, etc. Single basis:
  uses the standard `gross_amount` / `quantity` columns. `buildDataSets` is a thin
  wrapper around it.
- **`validate(rows)`** — returns structured `{ issues, level }` rendered by
  the validation banner; messages live in `I18N[...].vm`.
- **`build*()` chart functions** — `buildOrg` (Overview), `buildTotal` (Members
  bar), `buildModel` (By Model), `buildDaily` (Daily Trend). Charts are stored in
  the `charts` map and destroyed/rebuilt on rerender. Lazily built via
  `buildActiveTab()`.

The deprecated `aic_*` preview columns are ignored (GitHub zeroed them from
2026-06-01). An earlier dual-mode switch ("Actual" vs "GitHub UI compatible") and a
Compare view were removed when that happened. See
[docs/csv-interpretation-policy.md](docs/csv-interpretation-policy.md).

## Conventions

- **Inline literals for chart layout.** Sizes, paddings, radii, font sizes, and hex
  colors are written directly in each chart config (there is no constants/theme
  module). Match this style; do not introduce a constants layer for one value.
  `PALETTE` is the one shared array (series colors).
- **Net / metered coloring.** Amber `#d29922` denotes metered (overage) usage;
  threshold for "has metered" is `net > 0.001`. Blue `#58a6ff` is gross/covered.
- **Escape user content** with `escapeHTML()` when injecting into innerHTML
  (usernames, model names come from the CSV).
- **Dark theme** GitHub-like palette (`#0d1117` bg, `#e6edf3` text).
- **English-only in git-tracked files.** Unless the user explicitly says otherwise,
  all contents of git-tracked files — code, comments, docs, README, workflows,
  commit messages — are written in English. (Exceptions: user-facing UI strings stay
  bilingual via the `I18N` `ja` entries; chat replies follow the user's language.)
- **IMPORTANT — write for a reader with no project context.** Git-tracked files (code,
  comments, docs, commit messages) must read naturally to someone who never saw our chat.
  Never leave development-process residue: PoC/"gate"/step numbers, milestone or session
  names, "as we discussed", or a parenthetical that only answers a question raised in this
  conversation. Describe what the thing does and how to use it — not how or why we built it.
  Verify product/API names against vendor docs; do not invent terminology.
- **Match existing conventions; keep structure minimal.** Before adding a file, directory,
  script, variable, or path, check how the repo already names and structures similar things
  and follow it (grep first; e.g. `tests/`, not `test/`). Do not add a directory level,
  parameter, or indirection that a single case does not need.

## Testing

Two suites, kept separate by layer (`npm test` runs both):

- **Viewer e2e** (`npm run test:e2e`) — Playwright opens `index.html` via `file://`
  and loads CSV fixtures. The Chart.js CDN is aborted and replaced with a `ChartStub`
  that records configs, so tests assert on **chart config** (datasets, scales,
  plugins), not pixels. The viewer only ever consumes CSV, so its tests load CSV
  fixtures directly — never API JSON.
- **Automation unit** (`npm run test:unit`) — `node --test` runs the companion
  scripts' tests next to the code they cover (`automation/tests/`), with their own
  fixtures (`automation/tests/fixtures/`). The transform's input is raw API JSON, so
  that JSON lives here, not under the viewer's fixtures.

```bash
npm install
node_modules/.bin/playwright install chromium   # first run only
npm test
```

- Viewer tests: `tests/e2e/viewer.spec.js`. Fixtures: `tests/e2e/fixtures/`
  (sample CSV: `assets/sample-ai-usage-report.csv`). To assert on a chart, read its
  stub config via the canvas id (see the `getChartConfig` helper in the spec).
- After changing behavior, run the relevant suite (or `npm test`) and keep it green.

## Privacy — important

- **Never commit real usage exports** or any file containing real usernames/orgs.
  Local files like `AIUsageReport_*.csv` are personal data — do not add them to
  commits, tests, or fixtures.
- When you need test data, **synthesize anonymized fixtures** (see
  `tests/e2e/fixtures/metered-usage.csv` for the pattern).

## Git

- Recent history commits directly to `main` (this is a personal GitHub Pages
  project). Commit only when asked.
- Commit message style: short sentence-case imperative title (e.g. "Add metered
  usage visibility to Overview charts").
