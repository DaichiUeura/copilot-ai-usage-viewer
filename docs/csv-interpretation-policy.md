# CSV Interpretation Policy

This document summarizes how this viewer interprets a GitHub Copilot AI usage CSV.

It is intended as a simple reference for readers of reports or dashboards generated from this HTML.

## Note on the `aic_*` preview columns (2026-06-01)

Earlier exports carried preview columns `aic_quantity` and `aic_gross_amount`
alongside the standard billing columns. Per GitHub's changelog
([AI usage report updates, 2026-06-11](https://github.blog/changelog/2026-06-11-ai-usage-report-updates/)),
those preview fields are **deprecated and were retroactively zeroed for AI credit
usage from 2026-06-01 forward**. The standard columns `quantity` / `gross_amount`
are the canonical source for AI credit usage going forward; reports from before
2026-06-01 are unchanged.

Because the `aic_*` columns no longer describe anything distinct, this viewer
**ignores them entirely** and reports a single basis built from the standard
billing columns. (Earlier versions exposed an "Actual consumption" / "GitHub UI
compatible" mode switch and a Compare view to reconcile the two column families;
those have been removed.)

## Scope

This viewer is designed for CSV files exported from GitHub billing views related to AI usage.

The interpretation follows the current usage-based billing format described in public GitHub documentation and the public `github/copilot-billing-preview` repository:

- GitHub Docs: billing reports, AI usage, and usage-based billing guidance
- `github/copilot-billing-preview/docs/report-format.md`

## Core idea

The viewer aggregates usage from the standard billing columns:

- `gross_amount` — gross AI credit cost before discounts (the basis for every
  gross total, share, and chart in this viewer)
- `quantity` — billed AI credit quantity
- `net_amount` / `discount_amount` — used to derive the metered (overage) vs.
  covered split

## Field summary

The viewer may use the following columns when they are present:

| Column | Meaning in this viewer |
| --- | --- |
| `date` | Usage date (a UTC calendar day) |
| `username` | User associated with the usage |
| `product` | Product that produced the usage |
| `sku` | SKU associated with the usage row |
| `model` | Model associated with the usage row |
| `quantity` | Billed AI credit quantity |
| `gross_amount` | Gross amount before discounts |
| `discount_amount` | Discount or included usage coverage |
| `net_amount` | Billable amount after discounts (metered/overage) |
| `unit_type` | Unit basis for the row |
| `organization` | Organization associated with the row |
| `cost_center_name` | Optional cost center label |
| `total_monthly_quota` | Monthly quota value included in the export |

The preview columns `aic_quantity` and `aic_gross_amount`, if present, are ignored.

## Validation philosophy

The viewer validates whether the CSV contains the columns needed to aggregate
usage.

In general:

- Missing required fields such as `date`, `username`, `model`, or `gross_amount`
  are treated as data quality issues
- Unparseable, negative, or empty rows are surfaced as warnings
- A row-total vs. aggregated-total mismatch is surfaced as a warning

## Reporting guidance

When using charts or totals from this viewer in a report:

1. State that the numbers are based on the standard billing columns
   (`gross_amount` / `net_amount`) of the loaded CSV
2. Remember every view is an estimate of the loaded CSV; actual billed amounts
   may differ
