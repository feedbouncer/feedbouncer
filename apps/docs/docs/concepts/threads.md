---
title: Threads
description: Connecting a Threads account, what FeedBouncer can do with replies, and the current limitations.
status: partial
---

FeedBouncer moderates replies to your own Threads posts through one <Term id="connection">connection</Term> per Threads account.

<FeatureStatus status="partial">
  The Threads connection has not yet been checked against the live Threads API. It follows Meta's documentation, and some of it may turn out to differ. The list of what is unverified is in the <RepoLink path="docs/connectors/threads.md">Threads connector guide</RepoLink>.
</FeatureStatus>

## Connecting

An owner or admin connects the account from the brand's **Connections** page with **Connect Threads account**. The page lists the permissions FeedBouncer asks for and what each is for, and you approve them on Threads.

| Permission                | Required | What it is for                                    |
| ------------------------- | -------- | ------------------------------------------------- |
| `threads_basic`           | Yes      | Seeing your profile and listing your posts.       |
| `threads_read_replies`    | Yes      | Reading replies to your posts.                    |
| `threads_manage_replies`  | No       | Hiding and unhiding replies, and posting replies. |
| `threads_content_publish` | No       | Publishing the replies your rules send.           |

If you decline a required permission, nothing is connected and the page says which one was missing. If you decline an optional one, the account connects, and rule steps that need it are flagged for review instead of running. The connection's health shows which permission was not granted. Reconnect and approve it to turn those steps on.

Like every new connection, a Threads connection starts in [review mode](./review-mode.md) for 7 days.

## What FeedBouncer can do

| Step            | Threads |
| --------------- | ------- |
| Hide and unhide | Yes\*   |
| Auto-reply      | Yes\*   |
| Delete          | No      |
| Private reply   | No      |
| Ban author      | No      |
| Flag for review | Yes     |

\* Unverified against live Threads.

- **Hide and unhide work on top-level replies only**, which are direct replies to your post. Hiding one also hides all the replies under it on Threads. A hide step on a reply nested under another reply is not supported: it is flagged for review, and FeedBouncer never hides the parent instead.
- **Replies are plain text, up to 500 characters.** A rule whose reply template can exceed that is rejected when you save it.
- Your own replies, including the ones FeedBouncer posts, are never evaluated by rules.
- The author of a reply is its @handle, because Threads does not give an account id. Author rules match on the handle, and a person who changes their handle looks like a new author. `{{author_name}}` in a template renders the handle.

A rule step that cannot run is never replaced by another action. See [Actions](../rules/actions.mdx#when-hide-or-delete-fails).

## How quickly replies arrive

- With webhooks set up (self-hosters do this, see below), a new reply is usually read within seconds.
- Without them, replies are fetched on a schedule: usually within 10 minutes on a recent post, up to 6 hours on an older one with no recent replies.
- When you connect, the last 30 days of replies are imported, up to 2,000. Rules do not act on imported replies.
- Once a day each recent post is read again in full. Threads sends no notice when someone edits or deletes a reply, so an edit can take up to 24 hours to show.

## Limits

- Threads allows 1,000 replies a day per account from the API. When the limit is reached, further replies are shown as **Delayed until** a time in the comment's history, and sent when the limit allows. A reply still waiting after 24 hours fails with a reason.
- Hides and unhides are not held up by a backlog of replies.
- The Threads access token lasts 60 days. FeedBouncer refreshes it automatically about a week before it expires.

## Reconnecting

When Threads stops accepting the authorization, the connection is marked **Reconnect** on the Connections page, actions are paused and the organization's owners get an email. Reconnect to resume. Replies already stored are kept, and actions that were waiting run after you reconnect.

## Disconnecting

Disconnecting stops fetching at once and deletes the stored Threads token. Threads has no way for FeedBouncer to revoke it, so remove the app in your Threads settings if you also want it gone there. Replies, decisions and the action log already stored are kept and follow your data retention settings.

## Limitations

- Hide and unhide on top-level replies only.
- 500 characters per reply and 1,000 replies a day.
- No private replies, no deleting other people's replies, no banning and no direct messages.
- A reply deleted by its author is noticed late.

Self-hosters create their own Threads app, which is separate from the Facebook app. The steps, webhook setup, settings and the full list of unverified behaviour are in the <RepoLink path="docs/connectors/threads.md">Threads connector guide</RepoLink>.
