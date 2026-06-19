# Scope

What belongs in this tool — and what does not. Read this before proposing or
building a feature. (For what the tool *is*, see [README.md](../README.md).)

## Who it's for

The CSV is an org-level billing export (every member, the org, `cost_center_name`,
`total_monthly_quota`) that only someone with billing access can produce. So the
user is a **Copilot budget owner** — EM, team lead, org admin, or FinOps — asking
"how much are we spending, is it covered by the credit pool, and what's driving
it?" They are not a data analyst wanting a BI tool, nor an individual dev tracking
their own usage. That distinction is what most scope calls come down to.

## Principles

1. **Stay a viewer.** Describe what's in the loaded CSV — aggregation, sums,
   shares, visualization. **No prediction**: no month-end forecast or run-rate
   extrapolation. Those assume facts the CSV doesn't contain (which day is "today",
   whether the rate holds) and make the tool own a future number it can't stand
   behind. The Net line's slope and the daily Metered bars already convey the rate
   descriptively.
2. **Simple over capable.** No build step, no framework, no backend — one HTML file
   plus Chart.js from a CDN. A feature that needs a pipeline doesn't belong in the
   viewer. Companion tooling that merely *produces* a loadable CSV may live isolated
   in `automation/`; the browser never runs it and it must not pull a build/backend
   into the viewer.
3. **Privacy by default.** The CSV stays in the browser. Never bundle real exports
   into the repo, tests, or fixtures — synthesize anonymized data instead.

Two working rules that follow from these:

- **Single basis.** All numbers come from the standard billing columns
  (`gross_amount` / `net_amount`); don't present a value on a basis it isn't
  computed from. The deprecated `aic_*` preview columns are ignored — see
  [csv-interpretation-policy.md](csv-interpretation-policy.md).
- **Asymmetry is fine.** Some charts are gross-only while Overview is
  metered-aware. Don't add a chart, or push metered everywhere, just for symmetry.
  Equally, removing a stable feature has churn risk — prefer leaving it over a
  marginal cleanup.

## Out of scope

- **Forecasting / run-rate projection** — crosses the viewer boundary (principle 1).
- **Server, accounts, persistence, upload** — breaks the in-browser privacy model.
- **Per-member prediction or anomaly detection** — analyst tooling, not a
  budget-owner viewer.
