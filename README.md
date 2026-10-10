# FeedBouncer

## Development

This is a pnpm workspace orchestrated by [Turborepo](https://turborepo.com).

### Prerequisites

- Node.js 24.x (see `.nvmrc`)
- pnpm 12.3.x — installs are pinned via the `packageManager` field in `package.json`; running `npm install` or `yarn` is blocked on purpose

### Setup

```bash
pnpm install
```

### Common commands

| Command             | What it does                                                                          |
| ------------------- | ------------------------------------------------------------------------------------- |
| `pnpm build`        | Builds every package/app via Turborepo (`turbo run build`)                            |
| `pnpm lint`         | Lints every package/app via Turborepo (`turbo run lint`)                              |
| `pnpm format`       | Formats every package/app with Prettier via Turborepo (`turbo run format`)            |
| `pnpm format:check` | Checks formatting without writing changes (`turbo run format:check`) — use this in CI |
| `pnpm typecheck`    | Type-checks every package/app via Turborepo (`turbo run typecheck`)                   |
| `pnpm test`         | Runs every package's `test` script via Turborepo, then the `scripts/ci` guard tests   |
| `pnpm test:scripts` | Runs only the `scripts/ci/*.test.mjs` guard tests (`node --test`)                     |

Turborepo caches the per-package `build`, `lint`, `format:check`, `typecheck` and `test` tasks — an unchanged package's task is skipped on a re-run. The root-level `eslint .` and `prettier --check` steps (root config files only) run every time, as does `pnpm format`, which writes files.

## Continuous integration

Every pull request and every push to `main` runs `.github/workflows/ci.yml` on a clean GitHub-hosted runner. It uses Node from `.nvmrc`, pnpm from `packageManager`, and a frozen lockfile. The workflow uses no secrets and a read-only token, so fork PRs get the same checks.

| Check (status name) | What it runs                                                                                                                                         | Run it locally                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Typecheck`         | `pnpm typecheck` (Turborepo; builds workspace dependencies first)                                                                                    | `pnpm install --frozen-lockfile && pnpm typecheck`                                                                             |
| `Test`              | `pnpm test` = every package's `test` script via Turborepo, then `scripts/ci/*.test.mjs`                                                              | `pnpm test`                                                                                                                    |
| `Docker build`      | Builds (never pushes) each `apps/*/Dockerfile` and `packages/*/Dockerfile` from the repo root. Green with a "nothing to build" note when none exist. | `node scripts/ci/docker-targets.mjs`, then for each: `docker build -f <dockerfile> --build-arg NODE_VERSION="$(cat .nvmrc)" .` |

These three names are stable and are the ones to mark **required** in branch protection. `Docker discover` and `Docker image (…)` are helper jobs; don't mark them required. Renaming a check is a breaking change: update branch protection in the same PR, and `scripts/ci/workflow.test.mjs` will remind you.

- **Adding a test:** give your package a `"test": "vitest run"` script (copy `packages/placeholder`) and put tests in `src/**/*.test.ts` (the package build excludes them via `tsconfig.build.json`). CI picks it up automatically.
- **Adding an image:** add `Dockerfile` to `apps/<name>/` or `packages/<name>/`, using `apps/placeholder-app/Dockerfile` as the template: build context is the repo root, `ARG NODE_VERSION`, and never read `.env` or prebuilt `dist/`. No workflow edit needed.
- **Adding a shared root config file** that packages extend: add it to `globalDependencies` in `turbo.json` _and_ to `SHARED_ROOT_CONFIG` in `scripts/ci/turbo-config.test.mjs`, or cached results can go stale.
- **Lockfile errors in CI** (`ERR_PNPM_OUTDATED_LOCKFILE`): run `pnpm install` locally and commit the updated `pnpm-lock.yaml`.
- A new push to a PR cancels that PR's in-progress run. Jobs time out after 5–20 minutes.
