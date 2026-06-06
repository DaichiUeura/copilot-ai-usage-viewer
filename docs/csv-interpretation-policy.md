# CSV Interpretation Policy

This document summarizes how this viewer interprets a GitHub Copilot AI usage CSV.

It is intended as a simple reference for readers of reports or dashboards generated from this HTML.

## Scope

This viewer is designed for CSV files exported from GitHub billing views related to AI usage.

The interpretation follows the current usage-based billing format described in public GitHub documentation and the public `github/copilot-billing-preview` repository:

- GitHub Docs: billing reports, AI usage, and usage-based billing guidance
- `github/copilot-billing-preview/docs/report-format.md`

## Core idea

The CSV may contain two related measurement families:

1. Standard billing fields such as `quantity` and `gross_amount`
2. AI credit-specific fields such as `aic_quantity` and `aic_gross_amount`

This viewer treats them as different views of usage, not as interchangeable values.

## Interpretation modes

### Actual consumption

This mode is intended to represent AI credit consumption as directly as possible.

- Primary fields: `aic_quantity`, `aic_gross_amount`
- Fallback fields: `quantity`, `gross_amount` when the AI credit-specific fields are blank

Use this mode when the goal is to understand actual AI credit consumption, shared pool drawdown, or model consumption in AI credit terms.

### GitHub UI compatible

This mode is intended to stay close to the standard billing-style values that may appear in GitHub usage views.

- Primary fields: `quantity`, `gross_amount`

Use this mode when the goal is to compare this viewer with a GitHub usage graph or other billing-oriented UI that appears to rely on the standard billing columns.

### Compare

This mode is intended for inspection only.

It highlights the difference between the two interpretations above so that readers can see where standard billing fields and AI credit-specific fields diverge.

## Field summary

The viewer may use the following columns when they are present:

| Column | Meaning in this viewer |
| --- | --- |
| `date` | Usage date |
| `username` | User associated with the usage |
| `product` | Product that produced the usage |
| `sku` | SKU associated with the usage row |
| `model` | Model associated with the usage row |
| `quantity` | Standard billed quantity |
| `gross_amount` | Standard gross amount before discounts |
| `discount_amount` | Discount or included usage coverage |
| `net_amount` | Billable amount after discounts |
| `unit_type` | Unit basis for the row |
| `organization` | Organization associated with the row |
| `cost_center_name` | Optional cost center label |
| `total_monthly_quota` | Monthly quota value included in the export |
| `aic_quantity` | AI credit-specific quantity |
| `aic_gross_amount` | AI credit-specific gross cost |

## Preferred aggregation rule

When AI credit-specific fields are present, this viewer interprets them as the preferred source for actual AI credit consumption.

This means:

- `aic_quantity` is preferred over `quantity` for AI credit consumption views
- `aic_gross_amount` is preferred over `gross_amount` for AI credit cost views

The standard billing fields are still useful for compatibility and comparison.

## Why both interpretations may differ

Different GitHub billing exports and dashboards may expose:

- standard billed quantities and gross amounts
- AI credit-specific quantities and gross amounts

These values can match, but they do not always match.

As a result, a chart built from standard billing columns may differ from a chart built from AI credit-specific columns.

This viewer keeps those interpretations separate so the reader can understand which basis is being used.

## Validation philosophy

The viewer should validate whether the CSV contains the columns needed for the selected interpretation mode.

In general:

- Missing core identity fields such as `date`, `username`, or `model` are treated as data quality issues
- Missing AI credit-specific fields reduce confidence in `Actual consumption`
- Differences between standard billing fields and AI credit-specific fields are not automatically treated as errors

Those differences can be a normal property of the export format.

## Reporting guidance

When using charts or totals from this viewer in a report:

1. State whether the numbers are based on `Actual consumption` or `GitHub UI compatible`
2. Use `Actual consumption` when discussing AI credit consumption or shared pool usage
3. Use `GitHub UI compatible` when comparing against GitHub billing UI visuals
4. Use `Compare` when explaining why the two views differ