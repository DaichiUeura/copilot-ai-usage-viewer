# 🤖 GitHub Copilot AI Usage Viewer

A browser-based visualizer for the GitHub Copilot AI Usage Report CSV.
Drop in your billing export to explore spending by org, member, model, and day.

## Usage

1. Go to **GitHub → Billing → AI usage → Get usage report** and download the CSV.
2. Open `index.html` in your browser.
3. Drop the CSV onto the page.

CSV data is processed in your browser and is not uploaded.

## Views

- **Overview** — cumulative spend, daily total, model share
- **Members** — per-member bar chart and sortable detail table
- **By Model** — stacked usage by member and model
- **Daily Trend** — day-by-day usage for top members

Supports EN / 日本語. Validates the CSV format on load.
