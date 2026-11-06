---
title: Changelog
description: Changes to the public API, newest first.
status: stable
---

## 2026-11-06

- Requests with a key whose creator is deactivated get `403 key_owner_inactive`. See [Deactivated key creators](./authentication.md#deactivated-key-creators).

## 2026-11-05

- Organizations now have a status, `active` or `suspended`. Requests with a key of a suspended organization get `403 organization_suspended`, and creating a key is refused the same way. See [Suspended organizations](./authentication.md#suspended-organizations).
