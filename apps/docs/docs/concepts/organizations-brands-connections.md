---
title: Organizations, brands and connections
description: How FeedBouncer groups people, brands and social accounts, and what an API key can reach.
status: stable
---

## Organization

An <Term id="organization">organization</Term> is the top level. It holds your team, your API keys and your brands. Each member has one role: `owner`, `admin` or `member`. Owners and admins create and manage API keys.

## Brand

A <Term id="brand">brand</Term> belongs to one organization. Rules, classifier settings, policies and review mode apply per brand. A brand has a time zone, which sets where "today" starts for the Hidden today page.

## Connection

A <Term id="connection">connection</Term> links a brand to one account on a <Term id="platform">platform</Term>: a Facebook Page, an Instagram account, a Meta ad account, a TikTok Business account, a TikTok ad account or a YouTube channel. A brand can have several connections. Comments arrive per connection. Reconnecting the same account does not restart review mode.

A TikTok account and a TikTok ad account are separate connections. Either works without the other, and a problem with one does not stop the other. See [TikTok and TikTok ads](./tiktok.md).

<FeatureStatus status="planned">
  Connections to Threads, LinkedIn, X and Bluesky are planned.
</FeatureStatus>

## API keys

An <Term id="api-key">API key</Term> belongs to an organization and carries one <Term id="scope">scope</Term>: `moderate`, `read` or `write`. Each scope includes the ones before it in that order. A key reaches every brand in its organization, and nothing in any other organization.
