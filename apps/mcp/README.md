# MCP server

Setup, tools and troubleshooting are on the documentation site: https://feedbouncer.github.io/feedbouncer/docs/mcp/overview/. The source is `apps/docs/docs/mcp/`.

## Development

```bash
pnpm --filter @feedbouncer/mcp test               # unit tests, against an in-memory fake API
pnpm --filter @feedbouncer/mcp test:integration   # builds dist, then runs against a real API
```

The integration tests start the real API on a loopback port, with a scratch database and FakeGraph in place of Meta, and drive the tools through an MCP client: in memory, and by spawning `dist/main.js` over stdio. They need `DATABASE_URL` and `REDIS_URL` (see [CONTRIBUTING.md](../../CONTRIBUTING.md#services-for-integration-tests)) and built workspace packages (`pnpm build`).
