# FeedBouncer

## Local stack with Docker Compose

Runs everything locally: Postgres, Redis, the API, the background worker and the web app. **This stack is for development and evaluation only.** It is not a production deployment.

### Prerequisites

- Docker Engine 25+ with Docker Compose v2.20+ (Docker Desktop on macOS and Windows). Check with `docker compose version`.
- At least **4 GB of memory** allocated to Docker. The stack's limits add up to about 3.3 GB.
- **Windows:** use WSL2 and clone the repo **inside the WSL filesystem** (for example `~/src/feed-bouncer`), not under `/mnt/c/...`. File-change events don't cross from the Windows drive, so hot reload would silently stop. The repo forces LF line endings via `.gitattributes`.

### Start

```bash
cp .env.example .env
docker compose up
```

The first run builds the images, which takes a few minutes. Then:

| What                 | Where                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| Web app              | http://localhost:3000                                                   |
| API health           | http://localhost:3001/healthz (reports Postgres and Redis)              |
| Status of everything | `docker compose ps -a`: five services `healthy`, `migrate` `exited (0)` |

Database migrations run automatically in the one-shot `migrate` service before the API and worker start. Running it again is harmless.

Source files in `apps/*/src` and `packages/*/src` are mounted into the containers. Edits reload automatically, with no rebuild needed. The API and worker use file polling, so a change can take a second or two to show up.

### Stop, restart, reset

| Command                  | Effect                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| `docker compose down`    | Stops everything. **Database data is kept.**                                |
| `docker compose up`      | Starts again with your data.                                                |
| `docker compose down -v` | Stops everything and **deletes the database volume**, giving a clean slate. |

`down`, `ps` and `logs` read the same configuration as `up`, so they also need `.env` to exist (the credentials are required variables).

### Configuration

All settings live in `.env`, which is git-ignored and copied from `.env.example`. The values in `.env.example` are development-only. Never reuse them anywhere real.

- **Port already in use?** Change `WEB_HOST_PORT` or `API_HOST_PORT` in `.env`. You never need to edit `compose.yaml`.
- **Need psql or a GUI client?** Postgres and Redis are not published by default. To publish them on `127.0.0.1` only, run `docker compose -f compose.yaml -f compose.expose-db.yaml up`, or uncomment `COMPOSE_FILE` in `.env`. Use `POSTGRES_HOST_PORT`/`REDIS_HOST_PORT` if 5432 or 6379 are taken.
- **Personal tweaks:** copy `compose.override.example.yaml` to `compose.override.yaml`, which is git-ignored and loaded automatically (unless `COMPOSE_FILE` is set).
- `FB_BIND_ADDRESS` defaults to `127.0.0.1`, so nothing is reachable from other machines. Change it only if you mean to expose the stack to your network.

### More workers

```bash
docker compose up -d --scale worker=2
```

Each job is processed exactly once, whatever the number of replicas. A Postgres-backed idempotency ledger (`processed_job`) refuses duplicate deliveries.

### Troubleshooting

| Symptom                                                                                                    | Fix                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required variable POSTGRES_USER is missing a value: POSTGRES_USER is not set - copy .env.example to .env` | You have no `.env` (or it is missing a variable). Run `cp .env.example .env`, or add the missing line from `.env.example`.                                |
| `Bind for 127.0.0.1:3000 failed: port is already allocated`                                                | Set a free port in `.env` (`WEB_HOST_PORT=3100`) and run `docker compose up` again.                                                                       |
| Errors about a missing package after pulling changes (stale image)                                         | Dependencies are baked into the images. Rebuild with `docker compose up --build`. For a completely fresh build: `docker compose build --no-cache --pull`. |
| Hot reload doesn't pick up edits                                                                           | On Windows, move the clone into the WSL filesystem. For the web app, you can also set `WEB_WATCH_POLL_MS=1000` in `.env` (Next.js polls for changes).     |
| A service stays `unhealthy`                                                                                | `docker compose logs <service>`, then `docker compose restart <service>`. `docker compose down -v` then `up` gives a clean start.                         |
| Containers are killed / out of memory                                                                      | Give Docker more memory (4 GB minimum).                                                                                                                   |

Maintainers can run the full end-to-end check with `pnpm stack:smoke --yes-destroy-local-data`. It runs in its own Compose project (`feedbouncer-smoke`) on its own ports (23000 and 23001) and uses `compose.yaml` only, so it does not touch your dev stack. It still **deletes the smoke project's database volume**, and it reads the credentials from `.env`.

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

Two more jobs cover the dev stack: `Compose config` (static validation of the compose files, including the missing-`.env` error) and `Compose smoke` (the full lifecycle in `scripts/dev-stack/smoke.mjs`; run it locally with `pnpm stack:smoke --yes-destroy-local-data`). Mark `Compose config` **required** together with the three names above, and keep `Compose smoke` non-required until it has been stable for about 10 PRs. These names are stable, so don't rename them without updating branch protection. `Docker discover` and `Docker image (…)` are helper jobs; don't mark them required. Renaming a check is a breaking change: update branch protection in the same PR, and `scripts/ci/workflow.test.mjs` will remind you.

- **Adding a test:** give your package a `"test": "vitest run"` script (copy `packages/placeholder`) and put tests in `src/**/*.test.ts` (the package build excludes them via `tsconfig.build.json`). CI picks it up automatically.
- **Adding an image:** add `Dockerfile` to `apps/<name>/` or `packages/<name>/`, using `apps/placeholder-app/Dockerfile` as the template: build context is the repo root, `ARG NODE_VERSION`, and never read `.env` or prebuilt `dist/`. No workflow edit needed.
- **Adding a shared root config file** that packages extend: add it to `globalDependencies` in `turbo.json` _and_ to `SHARED_ROOT_CONFIG` in `scripts/ci/turbo-config.test.mjs`, or cached results can go stale.
- **Lockfile errors in CI** (`ERR_PNPM_OUTDATED_LOCKFILE`): run `pnpm install` locally and commit the updated `pnpm-lock.yaml`.
- A new push to a PR cancels that PR's in-progress run. Jobs time out after 5–25 minutes (`Compose smoke` has the longest limit).
