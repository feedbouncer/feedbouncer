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
| `routes:update`   | Rewrites `routes.lock.json` after a deliberate page rename or removal.                 |
| `test:site`       | Route lock, then the browser checks (links, accessibility, mobile, keyboard, search).  |

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

## Develop

```bash
pnpm install
pnpm --filter @feedbouncer/docs start     # development server
pnpm --filter @feedbouncer/docs build     # production build (also builds the search index)
pnpm --filter @feedbouncer/docs test      # unit tests
pnpm --filter @feedbouncer/docs exec playwright install chromium
pnpm --filter @feedbouncer/docs test:site # route lock and browser checks, on a fresh build
```

A change to rules, the public API or the MCP tools updates these docs in the same pull request.

## Regenerate the contract files

When code changes make a drift test fail, regenerate the file it names and commit it:

```bash
pnpm --filter @feedbouncer/api openapi:write
pnpm --filter @feedbouncer/mcp tools:write
pnpm --filter @feedbouncer/docs reference:write
```

## Cut a version

Versions are product release tags (`vX.Y.Z`). Until the first one exists, every page carries the
"main (unreleased)" banner. In the release pull request:

1. `pnpm turbo run build --filter=@feedbouncer/docs`, which generates the current API pages and
   `docs/_generated`.
2. `pnpm --filter @feedbouncer/docs docusaurus docs:version X.Y.Z`
3. Commit `versions.json`, `versioned_docs/version-X.Y.Z/**` (including `api/reference/**` and
   `_generated/**`) and `versioned_sidebars/version-X.Y.Z-sidebars.json`.
4. `pnpm --filter @feedbouncer/docs routes:update`, then commit `routes.lock.json`.
5. Tag `vX.Y.Z` after the pull request merges.

A snapshot is frozen: the build never writes into `versioned_docs/`.

## Continuous integration and publishing

- The `Docs` job in `.github/workflows/ci.yml` builds the site, runs `test:site` and checks every
  link in the built HTML with lychee.
- `.github/workflows/docs-deploy.yml` builds the same way on every push to `main` and publishes to
  GitHub Pages.
- Repository owner setup: make `Docs` a required status check on `main`, enable GitHub Pages with
  the source set to "GitHub Actions", and create the `github-pages` environment limited to `main`.

## Release gate

Before the first tagged release, two readers complete the tasks in `READER-TEST.md`.
