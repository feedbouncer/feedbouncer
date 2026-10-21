# @feedbouncer/docs

The public documentation site, built with Docusaurus and published to GitHub Pages.

## Commands

Run from the repository root with `pnpm --filter @feedbouncer/docs <script>`.

| Script            | What it does                                                                           |
| ----------------- | -------------------------------------------------------------------------------------- |
| `build`           | Copies the contract files, generates the API reference, builds the static site.        |
| `start`           | Same preparation, then the development server.                                         |
| `serve`           | Serves the last build.                                                                 |
| `reference:write` | Regenerates `docs/reference/product-reference.json` from the code.                     |
| `test`            | Unit tests, including the check that the committed product reference matches the code. |

## Content pipeline

Three committed JSON files are the contract between the code and these docs:

- `docs/api/openapi.json` (written by `pnpm --filter @feedbouncer/api openapi:write`)
- `docs/mcp/tools.json` (written by `pnpm --filter @feedbouncer/mcp tools:write`)
- `docs/reference/product-reference.json` (written by `pnpm --filter @feedbouncer/docs reference:write`)

`scripts/prepare-content.mjs` copies them into `docs/_generated/`, and `docusaurus gen-api-docs` writes
the API reference pages to `docs/api/reference/`. Both directories are generated and never committed.
`scripts/stamp-generated.mjs` sets each generated page's last-updated date from the git history of
`docs/api/openapi.json`, so the build needs the full history (`fetch-depth: 0` in CI).

Site constants (URL, base path, repository, allowed link hosts) live in `site.config.ts`.
