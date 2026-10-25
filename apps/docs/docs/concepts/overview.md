---
title: Concepts overview
description: What FeedBouncer does, the objects it works with, and where to read next.
status: stable
---

FeedBouncer moderates the comments on your brand's social accounts. It receives each comment, decides what to do with it, acts on the platform where it can, and keeps a record of why.

## How it fits together

- An <Term id="organization">organization</Term> holds your team. It owns one or more <Term id="brand">brands</Term>.
- Each brand has <Term id="connection">connections</Term> to its accounts on a <Term id="platform">platform</Term>.
- Every new <Term id="comment">comment</Term> on a connection is checked by your <Term id="rule">rules</Term> first. If no rule decides, the optional <Term id="classifier">classifier</Term> and your <Term id="policy">policies</Term> look at it.
- The result is a <Term id="decision">decision</Term>. Its <Term id="action-step">action steps</Term> run on the platform, or wait as <Term id="suggestion">suggestions</Term> during <Term id="review-mode">review mode</Term>.

The [comment lifecycle](./comment-lifecycle.md) walks through this in order.

## Supported platforms

You can connect:

- Facebook Pages and Instagram accounts.
- Meta ad accounts, for comments on your Facebook and Instagram ads.
- TikTok Business accounts, for comments on your own videos.
- TikTok ad accounts, for comments on your TikTok ads.
- YouTube channels, for comments on your own videos.

<FeatureStatus status="partial">
  The TikTok and YouTube connections have not yet been checked against the live platform APIs, and their comments arrive by polling only, every few minutes. See [TikTok and TikTok ads](./tiktok.md) and [YouTube](./youtube.md).
</FeatureStatus>

<FeatureStatus status="planned">
  Threads, LinkedIn, X and Bluesky are planned. They are not available yet.
</FeatureStatus>

## Where to go next

- [Comment lifecycle](./comment-lifecycle.md): what happens to a comment, step by step.
- [Organizations, brands and connections](./organizations-brands-connections.md): who can see and change what.
- [Decisions and audit](./decisions-and-audit.mdx): what FeedBouncer records about every action.
- [Review mode](./review-mode.md): the first 7 days, when FeedBouncer only suggests.
- [AI classifier and policies](./ai-classifier-and-policies.md): the optional model-based checks.
- [Self-hosting](./self-hosting.md): running your own instance.
- [Glossary](./glossary.md): every term in one place.
