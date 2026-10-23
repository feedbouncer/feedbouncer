# Launch posts

Drafts, owners, schedule and publishing gates for the first public launch of FeedBouncer.

## Status and approval

**Status:** draft
**Approved by:** not yet

## Owners and schedule

| Order | Channel               | Post                 | Owner      | Planned (UTC) | Status | Published URL |
| ----- | --------------------- | -------------------- | ---------- | ------------- | ------ | ------------- |
| 1     | GitHub                | Release notes        | unassigned | unscheduled   | draft  | -             |
| 2     | Product Hunt          | Product Hunt listing | unassigned | unscheduled   | draft  | -             |
| 3     | Hacker News (Show HN) | Show HN post         | unassigned | unscheduled   | draft  | -             |
| 4     | r/FacebookAds         | Fallback post        | unassigned | unscheduled   | draft  | -             |
| 5     | X and LinkedIn        | X post               | unassigned | unscheduled   | draft  | -             |
| 6     | X and LinkedIn        | LinkedIn post        | unassigned | unscheduled   | draft  | -             |

Each owner signs their post and replies to comments and issues on that channel for the first 48 hours after it goes live.

## Readiness checklist

- [ ] README explains the problem, shows the demo, has a quick start and the license
- [ ] Contributing guide, issue templates and code of conduct are in place
- [ ] Release v0.1.0 is tagged and has release notes
- [ ] CI is green on main
- [ ] Docs site builds and the link check passes
- [ ] The published docs site returns 200
- [ ] Quick start works from a fresh clone
- [ ] Demo is under 60 seconds and reviewed for private data
- [ ] r/FacebookAds rules checked
- [ ] Launch date checked against holidays and known outages
- [ ] Prepared answers reviewed

## Claims ledger

| Claim                                                                             | Source                                 |
| --------------------------------------------------------------------------------- | -------------------------------------- |
| FeedBouncer is licensed under AGPL-3.0-only                                       | LICENSE                                |
| FeedBouncer is not affiliated with or endorsed by Meta, TikTok or other platforms | README.md                              |
| New accounts start in review mode: suggestions only for the first 7 days          | apps/docs/docs/concepts/review-mode.md |

## GitHub

### Release notes

```text
FeedBouncer v0.1.0: open-source moderation for the comments on your ads.
```

## Product Hunt

### Product Hunt listing

```text
FeedBouncer: open-source comment moderation for advertisers, with every action explained and undoable.
```

## Hacker News (Show HN)

### Show HN post

```text
Show HN: FeedBouncer, open-source moderation for ad comments (AGPL-3.0, self-hostable)
```

## r/FacebookAds

### Fallback post

```text
Used only if the rules allow it: a short question to advertisers about scam and spam comments on their ads.
```

## X and LinkedIn

### X post

```text
We open-sourced FeedBouncer: hide scam and spam comments on your ads, with a reason and an undo for every action.
```

### LinkedIn post

```text
We open-sourced FeedBouncer, a tool that moderates the comments on your ads and explains every action it takes.
```

## Prepared answers

### Privacy

Platform OAuth tokens and webhook secrets are stored only encrypted, wrapped by the deployment's own encryption key. An organization's data, including stored comments and tokens, can be deleted on request, and retention can be set per kind of data. You can also run FeedBouncer yourself, so the data stays on your infrastructure.

Source: docs/operations/secrets.md, docs/operations/data-deletion.md, docs/operations/data-retention.md, docs/self-hosting/README.md

### False positives

For the first 7 days after an account is connected, FeedBouncer only suggests actions and a person approves them. Afterwards, each classifier category has its own threshold (0.80 by default) and action, which an admin can change. Every decision records its reason, and the Hidden today page lists each hidden comment with a one-click Unhide. Delete and private replies cannot be undone.

Source: apps/docs/docs/concepts/review-mode.md, apps/docs/docs/concepts/ai-classifier-and-policies.md, apps/docs/docs/concepts/decisions-and-audit.mdx

### Why open source

FeedBouncer is licensed under the GNU Affero General Public License v3.0, so you can read the code that touches your comments and host it yourself.

Source: LICENSE, README.md

### How is this different from built-in platform moderation

Rules, the classifier and custom policies decide what happens to each comment, and every decision is recorded with its actor and a readable reason. Hides are listed in an undo log. A decision is never rewritten by a later one.

Source: apps/docs/docs/concepts/decisions-and-audit.mdx

### Is FeedBouncer affiliated with Meta or TikTok

No. FeedBouncer is not affiliated with or endorsed by Meta, TikTok, Google/YouTube or any other platform it integrates with. Platform names are trademarks of their owners.

Source: README.md

## Corrections

| Date (UTC) | Channel | What was wrong | Correction | Shown as | URL |
| ---------- | ------- | -------------- | ---------- | -------- | --- |
