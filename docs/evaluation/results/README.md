# Published evaluation results

Published reports go here as `YYYY-MM-DD-<label>.md`, for example `2026-11-02-pilot-brands.md`.

Each file is a copy of `report.md` from `pnpm ops eval-report`, and nothing else. Never publish `items.jsonl`, `label-sheet.csv`, the `labels/` files, `meta.csv` or `report.json`; they stay on the machine that produced them and are deleted with the run directory.

A test in the repository (`pnpm test:scripts`) scans every file in this directory. It fails if a report is missing one of the eight report sections, or if it contains a UUID, an `i_` item identifier, an email address or a Facebook or Instagram link.

The method behind the numbers, and its limits, are in [../hide-metrics.md](../hide-metrics.md).
