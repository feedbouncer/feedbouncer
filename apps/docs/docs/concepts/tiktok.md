---
title: TikTok and TikTok ads
description: Connecting a TikTok Business account and TikTok ad accounts, what FeedBouncer can do on TikTok, and the current limitations.
status: partial
---

FeedBouncer moderates TikTok comments through two kinds of <Term id="connection">connection</Term>:

- A **TikTok account** connection: one TikTok Business account and the comments on its own videos. These comments are labelled **Organic**.
- A **TikTok ad account** connection: one advertiser and the comments on its ads. These comments are labelled **Ad**.

They are independent. You can connect either one, or both, in the same brand, and an outage or a missing permission on one does not stop the other.

<FeatureStatus status="partial">
  The TikTok connections have not yet been checked against the live TikTok API. They follow TikTok's documented or expected behaviour, and some of it may turn out to differ: in particular whether TikTok lets an app delete or reply to other people's comments. The tables below say which parts are unverified.
</FeatureStatus>

## Connecting

An owner or admin connects accounts from the brand's **Connections** page.

- **Connect TikTok account** sends you to TikTok to approve four permissions: your account's basic info, your video list, reading comments, and managing comments (hide, delete and reply). FeedBouncer needs all four. If you decline one, nothing is connected and the page says which one was missing.
- **Connect TikTok ads** sends you to TikTok to authorize FeedBouncer for one or more advertisers. Back in FeedBouncer you pick the ad accounts whose ads belong to this brand. Each one becomes its own connection.

Like every new connection, a TikTok connection starts in [review mode](./review-mode.md) for 7 days.

## What FeedBouncer can do

| Step            | TikTok account | TikTok ad account |
| --------------- | -------------- | ----------------- |
| Hide and unhide | Yes\*          | Yes\*             |
| Delete          | Yes\*          | Yes\*             |
| Auto-reply      | Yes\*          | Yes\*             |
| Private reply   | No             | No                |
| Ban author      | No             | No                |
| Flag for review | Yes            | Yes               |

\* Unverified against live TikTok. Delete and reply assume that TikTok allows them on other people's comments.

## When a step cannot run

A rule step that TikTok does not support, or that lacks a permission, is never replaced by another action. The comment is flagged for review instead, and the review queue says why, for example "TikTok doesn't support ban author; review manually." This works the same way on every platform. See [Actions](../rules/actions.mdx#when-hide-or-delete-fails).

Rules can be limited to organic or ad comments with **Applies to**. See [Organic and ad comments](../rules/overview.md#organic-and-ad-comments).

## How quickly comments arrive

TikTok comments are fetched on a schedule. There are no TikTok webhooks yet.

- A new comment usually appears within 5 minutes. On an older video without recent comments it can take up to 6 hours.
- A reply to an older comment can take up to 24 hours, when the video is next read in full.
- When you connect, the last 30 days of comments are imported, up to 2,000 per connection. Rules do not act on imported comments.
- Once a day, an ad account's last 30 days are read again, so comments on ads that have ended keep an up-to-date state. A comment TikTok no longer returns keeps its last known state.

## Spark Ads

A Spark Ad promotes one of your organic videos, so the same video can have comments in both connections. FeedBouncer keeps them as two separate threads, one per connection, and moderates each through its own connection.

## Reconnecting and missing permissions

When TikTok stops accepting a connection's authorization, or a permission is missing, the connection is marked as needing attention on the Connections page, for example "Missing permission: comment.list.manage. Reconnect and approve all requested permissions." The organization's owners get an email. Reconnect and approve everything to fix it. Comments already stored are kept.

TikTok limits how fast an app may call it. Each connection has its own allowance, so a busy ad account cannot slow down your organic account or another platform. A throttled read is retried later from where it stopped; no comment is skipped.

## Disconnecting

Disconnecting stops fetching at once and deletes the stored TikTok tokens. The comments, decisions and action log already stored are kept, and follow your data retention settings.

## Limitations

- No direct messages, no LIVE comments, no ad creation or editing, and no analytics.
- Comments arrive every few minutes, not instantly.
- Hiding a comment does not hide its replies in FeedBouncer. Whether TikTok hides them is not known.
- Comments on ended ads show their last known state.

Self-hosters set up their own TikTok developer app. Permissions, settings and the full list of unverified behaviour are in the <RepoLink path="docs/connectors/tiktok.md">TikTok connector guide</RepoLink> and the <RepoLink path="docs/connectors/tiktok-ads.md">TikTok ads connector guide</RepoLink>.
