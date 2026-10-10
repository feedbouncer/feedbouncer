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

Turborepo caches `build`, `lint`, `format:check` and `typecheck` — an unchanged package's task is skipped on a re-run. `pnpm format` always runs because it writes files.
