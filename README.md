# FeedBouncer

FeedBouncer is an open-source comment firewall and inbox for brands that run social ads. It is meant to check every new comment on connected social accounts, hide or remove scams, spam and abuse, and route real questions and complaints to a person. It can be self-hosted.

## Project status

**Pre-alpha. Not for production use.** The foundations are in place: workspace and CI, data model and migrations, sign-up and organizations, encrypted token storage, the connector framework, the job queue and observability. **No social platform connector exists yet, so FeedBouncer cannot moderate real comments today.** Interfaces and the database schema will change without notice.

FeedBouncer is not affiliated with or endorsed by Meta, TikTok, Google/YouTube or any other platform it integrates with. Platform names are trademarks of their owners.

## Quick start

```bash
cp .env.example .env
docker compose up
```

Then open http://localhost:3000. Details, ports and troubleshooting are under [Local stack with Docker Compose](#local-stack-with-docker-compose).

## Running the tests

```bash
pnpm install
pnpm test
```

`pnpm test` runs every package's unit tests and the `scripts/ci` guard tests, with no services needed. Integration tests need Postgres and Redis; see [CONTRIBUTING.md](CONTRIBUTING.md#services-for-integration-tests).

## Repository layout

| Path                                 | What it is                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `apps/api`                           | HTTP API (NestJS on Fastify): accounts, organizations, brands, health                                        |
| `apps/web`                           | Web app (Next.js)                                                                                            |
| `apps/worker`                        | Background worker that runs queued jobs                                                                      |
| `apps/mcp`                           | MCP server over stdio, a client of the public API                                                            |
| `apps/docs`                          | Public documentation site (Docusaurus); see apps/docs/README.md                                              |
| `apps/placeholder-app`               | Minimal app used as the template for new apps and Docker images                                              |
| `packages/authz`                     | Roles and authorization checks                                                                               |
| `packages/comments`                  | Comments: storage, moderation, lifecycle, webhooks, reconnect emails                                         |
| `packages/ai`                        | Multi-provider language model configuration and factory                                                      |
| `packages/classifier`                | AI comment classification: categories, per-brand thresholds and settings schemas                             |
| `packages/connector-facebook`        | Facebook Pages connector: OAuth, comments, moderation actions                                                |
| `packages/connector-instagram`       | Instagram connector (Facebook Login): comments, moderation actions, replies                                  |
| `packages/connector-meta-ads`        | Meta Ads connector: ad accounts and active ads; comments are read through the Page and Instagram connections |
| `packages/connectors`                | Contract and shared services for platform connectors                                                         |
| `packages/db`                        | Postgres schema, migrations and the migration CLI                                                            |
| `packages/jobs`                      | Job queue: per-platform queues, retries, dead-letter queue, idempotency                                      |
| `packages/mailer`                    | Transactional email                                                                                          |
| `packages/observability`             | Structured logs, traces, metrics and connector health                                                        |
| `packages/rules`                     | Moderation rules: matchers, evaluation order, rule store and evaluation job                                  |
| `packages/actions`                   | Moderation actions: step model, execution and review queue                                                   |
| `packages/alerts`                    | Alerts: negative-comment spike detection and delivery to Slack and email                                     |
| `packages/reports`                   | Weekly email report: metrics, scheduling, rendering, delivery and unsubscribe links                          |
| `packages/evaluation`                | Evaluation runs: false-hide rate, time to hide and cost per 1,000 comments from exported items and labels    |
| `packages/policies`                  | Plain-language custom policies: validation, decisions, model evaluation, previews and runs                   |
| `packages/moderation-check`          | Stateless text check: rules, classifier and policies combined into one verdict, plus the queue consumer      |
| `packages/moderation-contract`       | Constants of the text check shared with the public API contract: size limit and reason codes                 |
| `packages/privacy`                   | Data retention settings and status; subject export and erasure                                               |
| `packages/public-api`                | Public REST API: API key generation, hashed storage and authentication                                       |
| `packages/webhooks`                  | Outgoing webhooks: Standard Webhooks signing, destination policy and SSRF-guarded transport                  |
| `packages/placeholder`               | Minimal package used as the template for new packages                                                        |
| `packages/secrets`                   | Envelope encryption for stored credentials and key management                                                |
| `packages/service-runtime`           | Shared service startup, configuration, health and error handling                                             |
| `docs/`                              | Operations and developer guides                                                                              |
| `scripts/`                           | CI guard tests and dev-stack smoke scripts                                                                   |
| `integrations/n8n-nodes-feedbouncer` | n8n community nodes (MIT): a webhook trigger and moderation actions, a client of the public API              |

The n8n nodes are documented in [their README](integrations/n8n-nodes-feedbouncer/README.md).

## Local stack with Docker Compose

Runs everything locally: Postgres, Redis, the API, the background worker, the web app and Mailpit (a dev mail inbox). **This stack is for development and evaluation only.** It is not a production deployment.

### Prerequisites

- Docker Engine 25+ with Docker Compose v2.20+ (Docker Desktop on macOS and Windows). Check with `docker compose version`.
- At least **4 GB of memory** allocated to Docker. The stack's limits add up to about 3.3 GB.
- **Windows:** use WSL2 and clone the repo **inside the WSL filesystem** (for example `~/src/feed-bouncer`), not under `/mnt/c/...`. File-change events don't cross from the Windows drive, so hot reload would silently stop. The repo forces LF line endings via `.gitattributes`.

### Start

```bash
cp .env.example .env
docker compose up
```

`.env` sets `FB_ENV=development`, which is what lets the API and worker start with the documented example credentials. Compose defaults to `production` when `FB_ENV` is unset, and production refuses example values, so keep that line when you edit `.env`.

The first run builds the images, which takes a few minutes. Then:

| What                 | Where                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| Web app              | http://localhost:3000                                                  |
| API health           | http://localhost:3001/healthz (reports Postgres and Redis)             |
| Dev mail inbox       | http://127.0.0.1:8025 (Mailpit; confirmation and reset emails)         |
| Status of everything | `docker compose ps -a`: six services `healthy`, `migrate` `exited (0)` |

Database migrations run automatically in the one-shot `migrate` service before the API and worker start. Running it again is harmless. To roll back, create, or test migrations, see [packages/db/README.md](packages/db/README.md).

Source files in `apps/*/src` and `packages/*/src` are mounted into the containers. Edits reload automatically, with no rebuild needed. The API and worker use file polling, so a change can take a second or two to show up.

### Accounts and email

Sign-up, email confirmation, password reset and invitations send real emails. In the dev stack they all go to **Mailpit**, so open http://127.0.0.1:8025 to find the confirmation link after signing up. Nothing leaves your machine. Mailpit's web UI has no authentication and is for development only: it is bound to `127.0.0.1` by default (`FB_BIND_ADDRESS`), so do not expose it to a network. Its port is `MAILPIT_UI_HOST_PORT`.

- **`AUTH_SECRET`** signs session cookies and is required (at least 32 characters). `.env.example` has a development-only value; for anything else generate one with `openssl rand -base64 48`.
- **`PUBLIC_WEB_URL`** is set by compose to `http://localhost:<WEB_HOST_PORT>`. It must be the exact origin users type: cookies, the origin check on state-changing requests and the links in emails all depend on it. Browse the app as `localhost`, not `127.0.0.1`.
- The public REST API and outgoing webhooks are documented on the [Documentation site](https://feedbouncer.github.io/feedbouncer/docs/api/overview/).
- The MCP server, which lets desktop and IDE MCP clients work with a workspace through the API, is documented on the [Documentation site](https://feedbouncer.github.io/feedbouncer/docs/mcp/overview/).
- API settings such as `TRUST_PROXY_HOPS` (reverse proxies trusted for the client IP) and `MAIL_FROM`, plus the roles, routes and rate limits, are described in [apps/api/README.md](apps/api/README.md).

### Facebook Pages (optional)

The connector is off until `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` and `FACEBOOK_WEBHOOK_VERIFY_TOKEN` are set in `.env` (commented examples are in `.env.example`). Meta needs a public HTTPS URL for the webhook and the OAuth redirect, so a purely local stack cannot complete a real connection without a tunnel. The worker also needs `SMTP_URL` and `PUBLIC_WEB_URL` (compose sets both). Step-by-step Meta app setup: [docs/self-hosting/meta-app.md](docs/self-hosting/meta-app.md). Permissions, App Review and known limitations: [docs/connectors/facebook.md](docs/connectors/facebook.md).

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
- Self-hosting guides, including creating your own Meta app: [docs/self-hosting/README.md](docs/self-hosting/README.md).
- Job queue (queues, retries, dead-letter commands): see [docs/operations/job-queue.md](docs/operations/job-queue.md). To define a job, see [docs/jobs/defining-a-job.md](docs/jobs/defining-a-job.md).
- Slack and email alerts (spike and flagged-item alerts, `ALERT_CHANNELS`, Slack webhook setup): see [docs/operations/alerts.md](docs/operations/alerts.md).
- Weekly email report (`WEEKLY_REPORTS`, when reports are sent, inspecting deliveries): see [docs/operations/weekly-report.md](docs/operations/weekly-report.md).
- Measuring false hides, time to hide, missed comments and cost (method, procedure, limits): see [docs/evaluation/hide-metrics.md](docs/evaluation/hide-metrics.md).
- Encryption keys and secret files: see [docs/operations/secrets.md](docs/operations/secrets.md). Back up `FB_ENCRYPTION_KEYS` separately from your database.
- `FB_BIND_ADDRESS` defaults to `127.0.0.1`, so nothing is reachable from other machines. Change it only if you mean to expose the stack to your network.

### More workers

```bash
docker compose up -d --scale worker=2
```

A Postgres-backed idempotency ledger (`processed_job`) refuses duplicate deliveries, so database work done inside the job transaction runs once however many replicas there are. Work with outside side effects, such as calls to external APIs, can still repeat and needs its own idempotency handling.

### Troubleshooting

| Symptom                                                                                                    | Fix                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required variable POSTGRES_USER is missing a value: POSTGRES_USER is not set - copy .env.example to .env` | You have no `.env` (or it is missing a variable). Run `cp .env.example .env`, or add the missing line from `.env.example`.                                                                                                                |
| `Bind for 127.0.0.1:3000 failed: port is already allocated`                                                | Set a free port in `.env` (`WEB_HOST_PORT=3100`) and run `docker compose up` again.                                                                                                                                                       |
| Errors about a missing package after pulling changes (stale image)                                         | Dependencies are baked into the images. Rebuild with `docker compose up --build`. For a completely fresh build: `docker compose build --no-cache --pull`.                                                                                 |
| Hot reload doesn't pick up edits                                                                           | On Windows, move the clone into the WSL filesystem. For the web app, you can also set `WEB_WATCH_POLL_MS=1000` in `.env` (Next.js polls for changes).                                                                                     |
| A service stays `unhealthy`                                                                                | `docker compose logs <service>`, then `docker compose restart <service>`. `docker compose down -v` then `up` gives a clean start.                                                                                                         |
| API or worker exits with `... is set to a documented example value from .env.example`                      | Your `.env` has no `FB_ENV`, so compose runs in `production`. Add `FB_ENV=development` (it is in the current `.env.example`) or replace the example values. See [docs/operations/secrets.md](docs/operations/secrets.md#troubleshooting). |
| Containers are killed / out of memory                                                                      | Give Docker more memory (4 GB minimum).                                                                                                                                                                                                   |

Maintainers can run the full end-to-end check with `pnpm stack:smoke --yes-destroy-local-data`. It runs in its own Compose project (`feedbouncer-smoke`) on its own ports (23000 and 23001) and uses `compose.yaml` only, so it does not touch your dev stack. It still **deletes the smoke project's database volume**, and it reads the credentials from `.env`.

With a stack running, `pnpm stack:auth-smoke` exercises sign-up, email confirmation (read from Mailpit), login, organization creation and the cross-site and forged-cookie refusals through the web origin. It targets `http://127.0.0.1:3000` and Mailpit on `8025`; if you changed `WEB_HOST_PORT` or `MAILPIT_UI_HOST_PORT`, export the same values first. It creates a throwaway account, so run it against development stacks only.

## Development

This is a pnpm workspace orchestrated by [Turborepo](https://turborepo.com).

### Prerequisites

- Node.js 24.x (see `.nvmrc`)
- pnpm 12.3.x — installs are pinned via the `packageManager` field in `package.json`; running `npm install` or `yarn` is blocked on purpose

### Setup

```bash
pnpm install
```

### Writing a connector

Platform integrations implement the contract in `@feedbouncer/connectors`. See [docs/connectors/writing-a-connector.md](docs/connectors/writing-a-connector.md).

### Common commands

| Command                                           | What it does                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                      | Builds every package/app via Turborepo (`turbo run build`)                                              |
| `pnpm lint`                                       | Lints every package/app via Turborepo (`turbo run lint`)                                                |
| `pnpm format`                                     | Formats every package/app with Prettier via Turborepo (`turbo run format`)                              |
| `pnpm format:check`                               | Checks formatting without writing changes (`turbo run format:check`) — use this in CI                   |
| `pnpm typecheck`                                  | Type-checks every package/app via Turborepo (`turbo run typecheck`)                                     |
| `pnpm test`                                       | Runs every package's `test` script via Turborepo, then the `scripts/ci` guard tests                     |
| `pnpm test:scripts`                               | Runs only the `scripts/ci/*.test.mjs` guard tests (`node --test`)                                       |
| `pnpm db:migrate`                                 | Applies pending database migrations (needs `DATABASE_URL`)                                              |
| `pnpm db:rollback --yes-destroy-data`             | Rolls back the newest migration                                                                         |
| `pnpm db:migration:new <name>`                    | Scaffolds a migration directory with `migration.sql` and `down.sql`                                     |
| `pnpm db:status`                                  | Shows which migrations are applied                                                                      |
| `pnpm --filter @feedbouncer/api test:integration` | API tests against real services (needs `DATABASE_URL` with rights to create databases, and `REDIS_URL`) |
| `pnpm stack:auth-smoke`                           | End-to-end auth smoke against a running Compose stack (see above)                                       |

Turborepo caches the per-package `build`, `lint`, `format:check`, `typecheck` and `test` tasks — an unchanged package's task is skipped on a re-run. The root-level `eslint .` and `prettier --check` steps (root config files only) run every time, as does `pnpm format`, which writes files.

## Continuous integration

Every pull request and every push to `main` runs `.github/workflows/ci.yml` on a clean GitHub-hosted runner. It uses Node from `.nvmrc`, pnpm from `packageManager`, and a frozen lockfile. The workflow uses no secrets and a read-only token, so fork PRs get the same checks.

| Check (status name)   | What it runs                                                                                                                                         | Run it locally                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Typecheck`           | `pnpm typecheck` (Turborepo; builds workspace dependencies first)                                                                                    | `pnpm install --frozen-lockfile && pnpm typecheck`                                                                             |
| `Test`                | `pnpm test` = every package's `test` script via Turborepo, then `scripts/ci/*.test.mjs`                                                              | `pnpm test`                                                                                                                    |
| `Database migrations` | `prisma migrate deploy` twice, `migrate:down` + re-deploy, then `test:integration`, on a fresh `postgres:17-alpine` service                          | see packages/db/README.md                                                                                                      |
| `Docker build`        | Builds (never pushes) each `apps/*/Dockerfile` and `packages/*/Dockerfile` from the repo root. Green with a "nothing to build" note when none exist. | `node scripts/ci/docker-targets.mjs`, then for each: `docker build -f <dockerfile> --build-arg NODE_VERSION="$(cat .nvmrc)" .` |

Three more jobs: `Compose config` (static validation of the compose files, including the missing-`.env` error), `API integration` (the API's, connector framework's and job queue's integration tests, including tenant isolation, retries, the dead-letter queue and idempotency, against Postgres and Redis service containers) and `Compose smoke` (the full lifecycle in `scripts/dev-stack/smoke.mjs`, then the auth smoke; run them locally with `pnpm stack:smoke --yes-destroy-local-data` and `pnpm stack:auth-smoke`). Mark `Compose config` **required** together with the four names above, and keep `API integration` and `Compose smoke` non-required until each has been stable for about 10 PRs. These names are stable, so don't rename them without updating branch protection. `Docs` builds the documentation site (`apps/docs`), runs its browser and link checks, and should also be required once it has run green; `.github/workflows/docs-deploy.yml` publishes it to GitHub Pages on `main`. `Docker discover` and `Docker image (…)` are helper jobs; don't mark them required. Renaming a check is a breaking change: update branch protection in the same PR, and `scripts/ci/workflow.test.mjs` will remind you.

- **Adding a test:** give your package a `"test": "vitest run"` script (copy `packages/placeholder`) and put tests in `src/**/*.test.ts` (the package build excludes them via `tsconfig.build.json`). CI picks it up automatically.
- **Adding an image:** add `Dockerfile` to `apps/<name>/` or `packages/<name>/`, using `apps/placeholder-app/Dockerfile` as the template: build context is the repo root, `ARG NODE_VERSION`, and never read `.env` or prebuilt `dist/`. No workflow edit needed.
- **Adding a shared root config file** that packages extend: add it to `globalDependencies` in `turbo.json` _and_ to `SHARED_ROOT_CONFIG` in `scripts/ci/turbo-config.test.mjs`, or cached results can go stale.
- **Lockfile errors in CI** (`ERR_PNPM_OUTDATED_LOCKFILE`): run `pnpm install` locally and commit the updated `pnpm-lock.yaml`.
- A new push to a PR cancels that PR's in-progress run. Jobs time out after 5–25 minutes (`Compose smoke` has the longest limit).

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers setup, conventions and the checks a pull request must pass. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

See what we're working on in the [public roadmap](https://feedbouncer.github.io/feedbouncer/roadmap/), and suggest an item with a [roadmap suggestion](https://github.com/feedbouncer/feedbouncer/issues/new?template=roadmap_suggestion.yml).

Found a bug or have an idea? [Open an issue](https://github.com/feedbouncer/feedbouncer/issues/new/choose).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md). Do not open a public issue.

## License

FeedBouncer is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Copyright (C) 2026 FeedBouncer
