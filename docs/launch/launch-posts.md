# Launch posts

Drafts, owners, schedule and publishing gates for the first public launch of FeedBouncer.

## Status and approval

**Status:** draft
**Approved by:** not yet

## Owners and schedule

| Order | Channel               | Post                                 | Owner      | Planned (UTC) | Status | Published URL |
| ----- | --------------------- | ------------------------------------ | ---------- | ------------- | ------ | ------------- |
| 1     | GitHub                | Release notes                        | unassigned | unscheduled   | draft  | -             |
| 2     | GitHub                | Repository description               | unassigned | unscheduled   | draft  | -             |
| 3     | Product Hunt          | Name and tagline                     | unassigned | unscheduled   | draft  | -             |
| 4     | Product Hunt          | Description                          | unassigned | unscheduled   | draft  | -             |
| 5     | Product Hunt          | Maker's first comment                | unassigned | unscheduled   | draft  | -             |
| 6     | Hacker News (Show HN) | Title                                | unassigned | unscheduled   | draft  | -             |
| 7     | Hacker News (Show HN) | URL                                  | unassigned | unscheduled   | draft  | -             |
| 8     | Hacker News (Show HN) | First comment                        | unassigned | unscheduled   | draft  | -             |
| 9     | r/FacebookAds         | Primary post                         | unassigned | unscheduled   | draft  | -             |
| 10    | r/FacebookAds         | Fallback post (discussion, no links) | unassigned | unscheduled   | draft  | -             |
| 11    | X and LinkedIn        | X thread                             | unassigned | unscheduled   | draft  | -             |
| 12    | X and LinkedIn        | LinkedIn post                        | unassigned | unscheduled   | draft  | -             |

Each owner signs their post and replies to comments and issues on that channel for the first 48 hours after it goes live.

Only one of the two r/FacebookAds posts goes out: the primary post if the rules allow it, otherwise the fallback.

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

Every factual sentence in the copy below traces to one of these rows.

| Claim                                                                                                                                                                       | Source                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| FeedBouncer is licensed under AGPL-3.0-only                                                                                                                                 | LICENSE                                                          |
| FeedBouncer is not affiliated with or endorsed by Meta, TikTok, Google/YouTube or any other platform                                                                        | README.md                                                        |
| The maturity label is Alpha (decision D4; README status line rewritten in Task 3)                                                                                           | README.md                                                        |
| Scams, spam and abuse in the comments on social ads are the problem FeedBouncer is for; it checks new comments, hides or removes them and routes real questions to a person | README.md                                                        |
| The classifier's categories include spam, scam or phishing, and harassment or abuse                                                                                         | apps/docs/docs/concepts/ai-classifier-and-policies.md            |
| Facebook Pages and Instagram are supported                                                                                                                                  | apps/docs/docs/concepts/overview.md                              |
| TikTok, YouTube, Threads, LinkedIn, X and Bluesky are planned and not available yet                                                                                         | apps/docs/docs/concepts/overview.md                              |
| Instagram means Business or Creator accounts linked to a Facebook Page                                                                                                      | docs/connectors/instagram.md                                     |
| Comments on Meta ads, including dark posts, are read by polling through the Page or Instagram connection; the ad account connection asks for ads_read only                  | docs/connectors/meta-ads.md                                      |
| Meta sends no webhooks for ad comments                                                                                                                                      | docs/connectors/meta-ads.md                                      |
| A comment arrives by webhook, poll or backfill and is stored once however often it arrives                                                                                  | apps/docs/docs/concepts/comment-lifecycle.md                     |
| A retried job reuses its idempotency key, so a retry does not repeat database work                                                                                          | docs/operations/job-queue.md                                     |
| Rules run first, in precedence order; the first enforcing rule that matches decides                                                                                         | apps/docs/docs/concepts/comment-lifecycle.md                     |
| Rule conditions: keyword, regex, link domain, emoji, author or competitor                                                                                                   | apps/docs/docs/rules/overview.md                                 |
| The classifier and policies are optional and run only when no rule decided                                                                                                  | apps/docs/docs/concepts/ai-classifier-and-policies.md            |
| Policies are plain-language sentences with an action                                                                                                                        | apps/docs/docs/concepts/ai-classifier-and-policies.md            |
| AI providers: OpenAI, Google and any OpenAI-compatible endpoint, including a self-hosted one; with no provider nothing is classified                                        | packages/ai/src/config.ts                                        |
| The provider gets the comment text but never author names; a self-hosted endpoint keeps text on your infrastructure                                                         | apps/docs/docs/concepts/ai-classifier-and-policies.md            |
| By default, scam or phishing and hate speech are hidden and other categories are flagged for review                                                                         | apps/docs/docs/concepts/ai-classifier-and-policies.md            |
| New accounts start in review mode: for 7 days hide, delete, ban and replies are suggestions a person approves                                                               | apps/docs/docs/concepts/review-mode.md                           |
| Every decision is recorded, append-only, with its actor and a readable reason                                                                                               | apps/docs/docs/concepts/decisions-and-audit.mdx                  |
| The Hidden today page lists hides with their reason and a one-click Unhide                                                                                                  | apps/docs/docs/concepts/decisions-and-audit.mdx                  |
| Hide, ban and flag can be undone; delete and private replies cannot                                                                                                         | apps/docs/docs/concepts/comment-lifecycle.md                     |
| Meta App Review is not complete; until an app is approved only people with a role on it can connect Pages                                                                   | docs/connectors/facebook.md#app-review-and-business-verification |
| Self-hosters create and use their own Meta app                                                                                                                              | apps/docs/docs/concepts/self-hosting.md                          |
| The Meta app guide has not been checked against a live Meta dashboard                                                                                                       | docs/self-hosting/meta-app.md                                    |
| The Instagram connector's platform behaviour has not been observed against a Meta app                                                                                       | docs/connectors/instagram.md                                     |
| Meta needs a public HTTPS URL for the webhook, so a purely local stack needs a tunnel                                                                                       | README.md                                                        |
| Quick start is `cp .env.example .env` and `docker compose up`; the Compose stack is for development and evaluation                                                          | README.md                                                        |
| No accuracy results are published; an evaluation method exists                                                                                                              | docs/evaluation/results/README.md                                |
| Platform tokens and webhook secrets are stored as encrypted envelopes                                                                                                       | docs/operations/secrets.md                                       |
| CONTRIBUTING.md covers setup, conventions and the checks a pull request must pass                                                                                           | CONTRIBUTING.md                                                  |
| The demo clip shows a hide with its reason and its undo (clip: docs/assets/demo.gif from Task 3)                                                                            | apps/docs/docs/concepts/decisions-and-audit.mdx                  |

## GitHub

### Release notes

Short summary for the release announcement. The full notes are `docs/launch/release-notes-v0.1.0.md` (Task 4), published as the body of the v0.1.0 release, which is what the last link points to.

```text
Scam links, spam and abuse in the comments under ads have to be found and hidden by someone, while the ad keeps running and people keep reading the thread.

This release is alpha. It runs, but interfaces and the database schema can still change.

What works today:
- Facebook Pages and Instagram business or creator accounts. Comments on Meta ads, dark posts included, are polled.
- Rules run first: keyword, regex, link domain, emoji, author or competitor.
- An optional AI classifier and plain-language policies look at what no rule decided. The provider is your choice: OpenAI, Google or any OpenAI-compatible endpoint. With no provider, nothing is classified.
- Review mode: for the first 7 days after an account is connected, hides, deletes, bans and replies are suggestions that a person approves.
- An undo log: every decision keeps its reason, and the Hidden today page undoes a hide in one click.

TikTok and YouTube are planned, not available yet.

Install: Meta App Review is not complete, so you self-host and bring your own Meta app. Start with the quick start in the README, then follow https://github.com/feedbouncer/feedbouncer/blob/main/docs/self-hosting/meta-app.md

Contribute: issues and small pull requests are welcome. Setup and checks are in https://github.com/feedbouncer/feedbouncer/blob/main/CONTRIBUTING.md

Full notes: https://github.com/feedbouncer/feedbouncer/releases/tag/v0.1.0

The project is not affiliated with or endorsed by Meta, Google or any other platform it connects to.

[[MAINTAINER]]
```

### Repository description

```text
Self-hosted moderation for comments on social ads: your rules first, an optional AI classifier, a 7-day review mode and an undo log. Alpha. AGPL-3.0.
```

## Product Hunt

### Name and tagline

First line is the name, second line the tagline.

```text
FeedBouncer
Hide scam and spam comments on your ads, self-hosted
```

### Description

```text
Ad comment threads collect scam replies, spam and abuse, and keeping up with them by hand is slow work.

FeedBouncer reads the comments on a brand's Facebook Pages and Instagram accounts, ad comments included. Your rules decide first, and an optional AI classifier looks at whatever no rule decided. A newly connected account gets a week of suggestions only, and any hide can be undone.

Open source under AGPL-3.0. Today you try it by self-hosting. Not affiliated with or endorsed by Meta.

[[MAINTAINER]]
```

### Maker's first comment

Before posting, the maker adds one or two sentences in their own words on why they started the project. This draft does not invent that story.

```text
Hi Product Hunt. A phishing link left under a paid post stays there for everyone who opens the comments until somebody removes it, and scams and spam do turn up under ads. That is the job FeedBouncer is built for: check every new comment on the accounts a brand advertises from, hide or remove the scams, spam and abuse, and hand real questions and complaints to a person.

Where it stands: alpha. Connectors for Facebook Pages and Instagram exist, but Meta App Review is still pending, so the way to try it today is to self-host with your own Meta app. The guide for that app has not been checked against a live Meta dashboard yet, and corrections are welcome.

The clip in the gallery shows a comment hidden by a rule, the reason it records, and the one-click undo.

AI is optional. Rules run first; if you add a model, it can be OpenAI, Google or an OpenAI-compatible endpoint you run yourself.

Repository and setup: https://github.com/feedbouncer/feedbouncer

FeedBouncer is not affiliated with or endorsed by Meta or Google. I will be in the comments today for questions and criticism.

[[MAINTAINER]]
```

## Hacker News (Show HN)

### Title

```text
Show HN: FeedBouncer – self-hosted filter for scam and spam comments on ads
```

### URL

```text
https://github.com/feedbouncer/feedbouncer
```

### First comment

```text
If you run ads on Facebook or Instagram, scam and spam replies show up under them, and removing them means reading each thread by hand. Anything missed sits under a post you are paying to show.

FeedBouncer is an open-source (AGPL-3.0) service that moderates those comments. It is alpha. How it works:

- A comment can reach it by webhook, by poll (Meta sends no webhooks for ad comments), or a second time when a job is retried. It is stored once either way.
- Your rules run first, in precedence order, and the first enforcing match decides. Only when no rule decides do the optional classifier and plain-language policies run. The model provider is yours to pick: OpenAI, Google or an OpenAI-compatible endpoint, self-hosted if you like. With none configured, nothing is classified.
- Every decision is stored append-only with its actor and a readable reason. Hide, ban and flag can be undone; delete and private replies cannot.
- New connections start in review mode: for 7 days, hides, deletes, bans and replies wait for a person to approve them.

What it does not do:

- No TikTok or YouTube; both are planned, not available.
- Meta App Review is not complete. To try it you self-host and create your own Meta app. Meta also needs a public HTTPS URL for the webhook, so a laptop-only setup needs a tunnel.
- The Meta app guide and the Instagram connector have not been checked against a live Meta app yet.
- No accuracy numbers are published yet. The evaluation method is in the repo; results are not.

Tradeoffs: rules are predictable but only catch what you describe. The classifier sends comment text, never author names, to the provider you configure, so point it at your own endpoint if text must stay on your machines. Platform tokens are stored as encrypted envelopes.

Not affiliated with or endorsed by Meta or Google. Happy to go into the design.

[[MAINTAINER]]
```

## r/FacebookAds

### Rules check

Checked on: not yet
Rules: https://www.reddit.com/r/FacebookAds/about/rules/
Summary: not recorded. The rules page could not be loaded when this draft was written. Before posting, the owner reads the rules, writes a short summary here in their own words, sets the date and picks the primary or the fallback post.
Moderator contact: not yet

### Primary post

```text
Scam and spam comments on Meta ads: a walkthrough for filtering them with a self-hosted tool

Anyone running ads for a brand sees it in the comments: phishing links, spam, now and then a pile-on of abuse. Hiding them one at a time from each ad gets old once several ads are live.

This walkthrough uses FeedBouncer, an open-source project I maintain. It is alpha and you run it on your own server with Docker, so it suits people who are comfortable with that.

1. Connect the Facebook Page and the Instagram account that run the ads, then the ad account. The ad account connection asks for ads_read only. Ad comments, dark posts included, are polled through the Page and Instagram connections.
2. Write rules first. Conditions can be a keyword, a regex, a link domain, an emoji, an author or a competitor, so you can hide known scam domains and mark trusted authors whose comments are left alone.
3. If rules are not enough, turn on the optional classifier. You pick the provider: OpenAI, Google or an OpenAI-compatible endpoint. By default, scam or phishing and hate speech get hidden, and the other categories are only flagged for review.
4. Keep review mode on. For the first 7 days nothing gets hidden, deleted or banned without someone approving it, so you see what it would do on your own comments first.
5. Check the Hidden today page. Each hide shows why it happened and has a one-click Unhide. Deletes cannot be undone, and the classifier's defaults never delete.

Caveat: Meta App Review is not done, so you create your own Meta app. In development mode the ad comments work for app admins who are also admins of the ad account.

Rules reference: https://feedbouncer.github.io/feedbouncer/docs/rules/overview/
Code: https://github.com/feedbouncer/feedbouncer

FeedBouncer is not affiliated with or endorsed by Meta. Questions welcome in the comments.

[[MAINTAINER]]
```

### Fallback post (discussion, no links)

```text
How do you handle scam and spam comments on your ads?

Curious how people here deal with scam replies, phishing links and spam under paid posts on Meta ads:

- Do you hide them by hand, rely on a keyword list, or something else?
- Hide or delete? And who on the team owns it?
- How often do you check, and has a bad comment ever stayed under an ad long enough to matter?

Disclosure: I maintain an open-source comment moderation project in this area. It is not affiliated with or endorsed by Meta, and I am not linking it here; I want to hear how you handle this today.

[[MAINTAINER]]
```

## X and LinkedIn

### X thread

Attach the demo clip to the second post. Posts are separated by `---`.

```text
Someone has to clean up the scam links and spam in the comments under ads, while the ad keeps running.

FeedBouncer is an open-source, self-hosted filter for that. Alpha, AGPL-3.0.
---
How it decides:
• your rules first
• then an optional AI classifier, with the provider you choose (OpenAI, Google or any OpenAI-compatible endpoint)
• every decision keeps its reason, and a hide can be undone

Clip: a scam comment hidden, its reason, then the undo.
---
New accounts start in review mode: for 7 days it only suggests and a person approves.

It works with Facebook Pages and Instagram. Meta App Review is pending, so for now you self-host with your own Meta app.
---
Code and setup: https://github.com/feedbouncer/feedbouncer

Not affiliated with or endorsed by Meta or Google. [[MAINTAINER]]
```

### LinkedIn post

```text
If you manage paid social for a brand, you know what gathers under the ads: scam replies, phishing links, spam, and sometimes abuse aimed at the brand or at other commenters. Someone has to clear it, ad after ad.

FeedBouncer is an open-source (AGPL-3.0) tool for exactly this.

What it does, in plain terms:
→ It reads new comments on your Facebook Pages and Instagram accounts, including the ones on Meta ads.
→ Your own rules act first: keywords, link domains, trusted authors.
→ An AI check is optional. If you turn it on, you choose who runs the model: OpenAI, Google, or an OpenAI-compatible endpoint you host.
→ For the first week after you connect an account it only suggests, so your team sees what it would hide before anything is hidden.
→ Every automated hide records why it happened, and a hide can be undone.

Status: alpha. Meta App Review is pending, which means today you run it on your own server with your own Meta app. TikTok and YouTube are planned but not available yet.

The demo clip is attached. Code and docs: https://github.com/feedbouncer/feedbouncer

FeedBouncer is not affiliated with or endorsed by Meta or Google.

[[MAINTAINER]]
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
