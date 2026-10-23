# Contributing to FeedBouncer

Thanks for helping. FeedBouncer is early (see [Project status](README.md#project-status)), so issues and small, focused pull requests are the most useful contributions right now.

## Development environment

You need:

- Node.js 24.x (the exact version is in `.nvmrc`)
- pnpm 12.3.x. The version is pinned by `packageManager` in `package.json`; `corepack enable` picks it up. `npm install` and `yarn` are blocked on purpose.
- Docker Engine 25+ with Compose v2.20+, for the local stack and for integration tests

```bash
pnpm install
```

To run the whole app locally, follow [Local stack with Docker Compose](README.md#local-stack-with-docker-compose).

### Services for integration tests

Integration tests need a real Postgres and Redis. Start just those two from the dev stack, published on `127.0.0.1` only:

```bash
cp .env.example .env
docker compose -f compose.yaml -f compose.expose-db.yaml up -d --wait postgres redis
export DATABASE_URL=postgresql://feedbouncer:dev-only-postgres-password@127.0.0.1:5432/feedbouncer
export REDIS_URL=redis://:dev-only-redis-password@127.0.0.1:6379/0
pnpm db:migrate
```

The credentials are the development-only values from `.env.example`. If you changed them in `.env`, use yours.

Then run the suite of the package you changed:

| Package                 | Integration tests                                           |
| ----------------------- | ----------------------------------------------------------- |
| API                     | `pnpm --filter @feedbouncer/api test:integration`           |
| Database and migrations | `pnpm --filter @feedbouncer/db test:integration`            |
| Connector framework     | `pnpm --filter @feedbouncer/connectors test:integration`    |
| Job queue               | `pnpm --filter @feedbouncer/jobs test:integration`          |
| Observability           | `pnpm --filter @feedbouncer/observability test:integration` |
| Secrets                 | `pnpm --filter @feedbouncer/secrets test:integration`       |

Stop the services with `docker compose down`; add `-v` to delete the database volume.

## Branches and commits

- Branch from `main` and name it `<type>/<short-description>`, for example `fix/webhook-signature-timing`.
- Write commit subjects as [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, with an optional scope such as `fix(connectors):`.
- Keep one logical change per pull request. Pull requests are squash-merged, so the PR title becomes the commit on `main` and should follow the same format.

## Before you ask for review

Every pull request must pass the same checks CI runs. Locally:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

`pnpm format` fixes formatting. If you touched `packages/db`, `apps/api`, `packages/connectors`, `packages/jobs`, `packages/observability` or `packages/secrets`, also run that package's [integration tests](#services-for-integration-tests). What each CI check runs is in [Continuous integration](README.md#continuous-integration).

Some docs are guarded by tests in `scripts/ci/`. If one fails after your change, update the doc in the same pull request.

- Changes to rules or actions (`packages/rules`, `packages/actions`), the public API (`packages/public-api`, `apps/api/src/public-api`) or MCP tools (`apps/mcp`) must update the docs site (`apps/docs`) in the same pull request. CI fails when `docs/api/openapi.json`, `docs/mcp/tools.json` or `docs/reference/product-reference.json` is stale, or when a condition, step, tool or endpoint has no docs.

## Proposing larger changes

Open an issue (choose **Feature request**) and agree on the approach **before** writing a large pull request. This applies to:

- a new platform connector or AI model provider
- a database schema change or migration
- a new runtime dependency
- a change to the public API or configuration variables
- anything touching authentication, authorization, tenancy, secrets or token handling

## Updating the roadmap

- The roadmap's source is [apps/docs/src/pages/roadmap.md](apps/docs/src/pages/roadmap.md), and it is published at <https://github.com/feedbouncer/feedbouncer/blob/main/apps/docs/src/pages/roadmap.md>.
- Each item sits in exactly one of Now, Next, Later or Shipped. It is a bold title and one sentence about what users get, with no dates or delivery promises. An empty group says `Nothing here yet.`
- **When you change the roadmap, update its "Last updated" date (`YYYY-MM-DD`) in the same pull request.**

## What reviewers look for

- **Tenant isolation.** Every read and write is scoped to its organization and brand, and authorized on every request path. A cross-tenant leak is a security bug, and it needs a test proving isolation.
- **Idempotency.** The same comment can arrive by webhook, by poll and by retry. Handlers must be safe to run twice.
- **Secrets stay secret.** Tokens are encrypted at rest and never logged, committed or put in error messages.
- **Untrusted input is validated at the boundary.** That covers webhook payloads, platform API responses and user text: guard against injection, SSRF and path traversal.
- **Tests and docs.** Tests cover the behavior you changed, and docs are updated in the same pull request.

Prefer well-maintained libraries over hand-rolled crypto, auth or parsing.

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
