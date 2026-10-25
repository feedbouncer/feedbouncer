---
title: YouTube
description: Connecting a YouTube channel, how FeedBouncer holds, rejects and bans within YouTube's daily quota, and the current limitations.
status: partial
---

FeedBouncer moderates comments and replies on your own YouTube channel's videos through one <Term id="connection">connection</Term> per channel.

<FeatureStatus status="partial">
  The YouTube connection has not yet been checked against the live YouTube API. It follows Google's documentation, and some of it may turn out to differ. The list of what is unverified is in the <RepoLink path="docs/connectors/youtube.md">YouTube connector guide</RepoLink>.
</FeatureStatus>

## Connecting

An owner or admin connects a channel from the brand's **Connections** page with **Connect YouTube**. You sign in to Google and approve one permission, which lets FeedBouncer read comments and moderate them. If you decline it, nothing is connected.

Like every new connection, a YouTube connection starts in [review mode](./review-mode.md) for 7 days.

## What FeedBouncer can do

YouTube does not let an app delete other people's comments. It offers moderation states instead, so the steps map like this.

| Step            | On YouTube                | Undo from the action log            |
| --------------- | ------------------------- | ----------------------------------- |
| Hide            | **Hold for review**       | Yes: the comment is published again |
| Delete          | **Reject**                | No                                  |
| Ban author      | **Reject and ban author** | No: unban in YouTube Studio         |
| Auto-reply      | Not available             |                                     |
| Private reply   | Not available             |                                     |
| Flag for review | Yes                       | Yes                                 |

A held comment waits in YouTube Studio for you to approve or reject it. A rejected comment is hidden for good, and its replies with it. YouTube does not let a rejected or published comment go back to held. A rule step that YouTube does not support flags the comment for review instead. See [Actions](../rules/actions.mdx#when-hide-or-delete-fails).

FeedBouncer never bans your own channel, a channel on your **protected channel ids** list, or an author whose channel id YouTube did not return. Add your moderators' channel ids to that list, because YouTube does not let an app read it.

## The daily quota

Google gives each project a daily quota of units, which resets at midnight Pacific Time. Reading comments is cheap. Moderating costs 50 units per call, and one call can moderate up to 50 comments, so FeedBouncer sends comments in batches.

You set a **daily budget** for each connection on its YouTube panel. The default is 2000 units. FeedBouncer never spends more than the budget, reads included, and keeps part of it for reading new comments so that moderation cannot starve polling. The panel shows what was spent, what is left, and when the budget resets.

- **Active:** comments are read and actions are applied.
- **Read only:** the budget is too low for a moderation batch. New comments are still checked and actions wait.
- **Budget spent:** actions wait until the reset.
- **Paused:** YouTube's quota for the whole FeedBouncer installation is used up, shared by everyone on it. Moderation resumes at the next reset, and the organization's owners get an email.
- **Off:** the budget is 0, and FeedBouncer makes no calls to YouTube for this channel.

Actions that wait are kept in a queue, which survives restarts, and are sent in this order: reject and ban, reject, hold, and publish (undoing a hold). Within each group the oldest goes first. A ban also carries the same author's waiting rejects at no extra cost, and a reject of a reply is skipped when the comment it answers is rejected.

If the queue passes 5,000 actions (the default limit), the newest actions in the lowest group are dropped. They are flagged for review, and the owners get one email a day.

### Dry run

Turn on **Dry run** to see the plan without touching YouTube. Each action is logged with the quota it would cost and is not applied.

## How quickly comments arrive

YouTube comments are fetched on a schedule. A new comment usually shows up within 5 minutes. When the budget is nearly spent the interval grows, up to an hour. Replies to a video's older comments are checked for up to 7 days after their last activity.

## Reconnecting

If Google stops accepting the connection, the Connections page says so and the organization's owners get an email. Reconnect to fix it. Queued actions are kept meanwhile.

If you run your own Google project and leave its consent screen in **Testing**, Google ends the connection every 7 days. Publish the app to avoid this.

## Disconnecting

Disconnecting stops fetching at once and deletes the stored tokens. Actions still waiting are failed and the comments are flagged for review. Comments, decisions and the action log already stored are kept.

## Limitations

- No live chat comments, and only channels you own and connect.
- Reject is not reversible from FeedBouncer, and there is no unban. Use YouTube Studio.
- No replies from FeedBouncer.
- Moderators must be listed by hand as protected channel ids.
- Comments arrive every few minutes, not instantly, and a small budget slows moderation down.

Self-hosters set up their own Google Cloud project, and can ask Google for a higher quota. Setup, settings and the quota rules are in the <RepoLink path="docs/connectors/youtube.md">YouTube connector guide</RepoLink>.
