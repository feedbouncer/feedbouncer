## Summary

<!-- What does this change do, and why? -->

## Linked issue

Closes #

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` pass locally.
- [ ] Tests added or updated for the change (integration tests too if it touches `db`, `api`, `connectors`, `jobs`, `observability` or `secrets`).
- [ ] Docs updated (README, CONTRIBUTING or `docs/`) if behavior, commands or configuration changed.
- [ ] New migrations include a `down.sql`.
- [ ] No secrets, real tokens, internal hostnames or personal paths in code, tests, fixtures or this description.
- [ ] Tenant-scoped reads and writes are authorized and have an isolation test.

See the [contributing guide](https://github.com/feed-bouncer-hq/feed-bouncer/blob/main/CONTRIBUTING.md#before-you-ask-for-review).
