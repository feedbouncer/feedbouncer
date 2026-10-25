---
title: Glossary
description: Definitions of the terms used across the FeedBouncer documentation.
status: stable
---

## Tenancy and access

### Organization

The top level. It holds your team, API keys and brands.

### Brand

A business or account identity inside an organization. Rules, classifier settings and policies apply per brand.

### Connection

A link between a brand and one account on a platform, such as a Facebook Page.

### Platform

A social network that FeedBouncer connects to. Facebook, Instagram, Meta ads, TikTok, TikTok ads and YouTube can be connected. The others are planned.

### API key

A credential for the public API. It belongs to an organization and has one scope. It is shown once, when it is created.

### Scope

What an API key may do: `moderate`, `read` or `write`. Each scope includes the ones before it.

### Idempotency key

A client-chosen value sent in the `Idempotency-Key` header, so that a repeated request has the effect of one. It is kept for 24 hours.

## Content and decisions

### Comment

A comment posted on a connected account. It is stored once, however often it arrives.

### Author

The person who posted a comment. Rules can block, allow or trust an author.

### Decision

The recorded outcome for a comment: outcome, mode, actor and reason. Decisions are append-only.

### Action step

One thing a decision does: flag for review, private reply, auto-reply, hide, ban or delete. Steps run in that order.

### Action run

The execution of a decision's action steps for one comment, with an outcome for each step.

### Outcome

The result of a decision or a step. A decision's outcome is `approve`, `flag`, `hide` or `remove`. A step's outcome is, for example, succeeded, failed or skipped.

### Undo

Reversing a step on the platform, where it allows it. Hide, ban and flag can be undone. Delete and private replies cannot.

### Hidden today

The page that lists comments FeedBouncer hid since midnight in the brand's time zone, with an Unhide button.

## Rules

### Rule

A set of conditions with action steps and a mode. Rules are checked first, in precedence order.

### Condition

What a rule matches: a keyword, regular expression, link domain, emoji, author or competitor.

### Enforce mode

A rule in enforce mode acts. The first matching enforce rule decides the comment.

### Dry run

A rule mode, called `suggest` in the API. The rule records what it would have done and acts on nothing.

## Review mode and AI

### Review mode

The first 7 days after an account is connected, when actions that change the platform wait for approval.

### Suggestion

An action plan waiting for a person to approve or dismiss it.

### Classifier

An optional language-model check that scores a comment against fixed categories. It runs only when no rule decided.

### Category

One thing the classifier scores, such as spam or hate speech.

### Threshold

The score at which a category triggers its action. The default is 0.80.

### Policy

A sentence you write that says what you do not want to see, checked by a language model with an action attached.

## Integrations

### Flagged item

A comment waiting in the review queue because a step or check flagged it.

### Rule change proposal

A change to the rules proposed through the API or the MCP server. A person approves it. Nothing applies it automatically.

### Webhook endpoint

A URL you register to receive signed events, such as a received or hidden comment.

### Delivery

One attempt to send an event to a webhook endpoint.

### MCP

The Model Context Protocol, which lets an assistant use tools. FeedBouncer's server runs locally over stdio.

### MCP tool

One operation the FeedBouncer MCP server offers, such as listing the inbox or replying to a comment.
