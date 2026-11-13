---
title: Self-hosting
description: FeedBouncer runs the same code self-hosted and in the cloud. What differs is who operates it.
status: stable
---

The same code runs self-hosted and in the cloud. A self-hosted instance has the same rules and API, and the MCP server connects to it the same way. You operate it, so you also set the things the cloud operator would set.

## What you operate

- The services and database, started with Docker Compose.
- Your own Meta app, for Facebook Pages and optional Instagram. Follow the <RepoLink path="docs/self-hosting/meta-app.md">Meta app guide</RepoLink>.
- Secrets and encryption keys.
- Your own Threads app, if you want Threads. It is separate from the Meta app. Follow the <RepoLink path="docs/connectors/threads.md">Threads connector guide</RepoLink>.
- The model provider for the <Term id="classifier">classifier</Term> and <Term id="policy">policies</Term>, if you want them.
- <RepoLink path="docs/operations/data-retention.md">Data retention</RepoLink> for your deployment.

## Who can create accounts

Public sign-up is on by default. To turn it off, set `SIGNUP_ENABLED` on the API service only. The web app asks the API, so there is nothing to set on the web service.

- Accepted values, in any case: `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`. Unset or empty means on.
- A value that is none of these keeps sign-up on and logs a warning at startup, so a typo never locks people out.
- With sign-up off, the API refuses new accounts with `403 signup_disabled`, the sign-up form and the "Create an account" links are hidden, and a direct visit to the sign-up page shows a short message.
- Everything else keeps working: sign-in, password reset, API keys, organization management and invitations. A new invitee can still create an account by following their invitation link, because the invitation token proves the address was invited.
- `SIGNUP_ALLOWED_EMAILS` is ignored while sign-up is off.
- There is no social or SSO sign-in today. Any account-creation path added later is refused while sign-up is off unless it is explicitly approved.
- Changing the value needs a restart of the API. It never changes existing accounts, sessions or data.

:::warning First account
With sign-up off and no accounts, nobody can get in. Either create the first account through your own provisioning system, or start with sign-up on, create the admin account, then set `SIGNUP_ENABLED=false` and restart.
:::

Accounts can also be created by another system you run, through the [provisioning API](./provisioning-api.md). It is off until you set a credential, and it works with `SIGNUP_ENABLED=false`.

## First-run setup wizard

The first time an owner or admin opens a new organization, the web app starts the [setup wizard](./setup-wizard.md): connect accounts, pick defaults, choose a review mode and see a first report. It runs on your server with no outbound access needed. If no platform is configured yet, the connect step says so and links to this page. Configure at least one platform, then run setup again from the organization overview.

## Your public address

Set `PUBLIC_WEB_URL` to the public origin of your instance. The API is reachable at that origin under `/v1`. In the API and MCP examples in these docs, `FEEDBOUNCER_URL` is your `PUBLIC_WEB_URL` origin, for example `https://feedbouncer.example.com`.

Review mode, the <Term id="rule">rule</Term> engine and the retention settings behave the same as in the cloud.
