# Backfill: recent comments on connect

## What it does

When a Page or Instagram account is connected (or reconnected), a background job
`connection_backfill` imports the connection's recent comments through the
normal ingest path. Connecting returns at once; the import runs afterwards.

- Defaults: the last 30 days and at most 2,000 comments. Both are constants in
  `packages/comments/src/backfill/settings.ts` (`windowDays`, `maxComments`).
- Order: posts/media are walked newest first, and comments within a post
  newest first, until the window or the cap is reached.
- Imported comments keep their original platform timestamps, and hidden or
  removed comments are imported in that state. The job only reads; it never
  hides, replies or otherwise acts.

## Window rules

- The window applies to posts and to comments. Only posts created inside the
  window are walked, and only comments posted inside it are imported, so
  comments on posts older than the window are not imported.
- A post's listing stops at the first top-level comment older than the window.
  On Instagram a recent reply under an old top-level comment is therefore not
  imported; on Facebook replies appear in the time stream and are.
- The cap counts in-window comments passed to ingest. When it is reached the
  run completes marked as limited, and the UI says it is limited to the most
  recent N.
- Reconnecting fetches only the outage gap: from one hour before the earliest
  disconnect or reconnect-required event after the last completed run, but
  never older than the window. If nothing happened since the last completed run
  there is nothing to fetch and no job is queued.
- Re-runs and live webhooks never create duplicates, and a newer platform
  timestamp is never overwritten by backfilled data.

## States

`pending`, `running`, `completed` and `failed`. A failed run has one reason:

| Reason                     | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `reconnect_required`       | Authorization was revoked or expired mid-run. Reconnecting starts a new run. |
| `disconnected`             | The connection was removed.                                                  |
| `cancelled`                | The run was cancelled by a disconnect.                                       |
| `stalled`                  | A pending or running run had no progress checkpoint for over 26 hours.       |
| `source_listing_forbidden` | The platform refused to list posts/media (permission).                       |
| `platform_error`           | The platform failed in a way retries did not resolve.                        |

Throttling is not a failure: the job defers and resumes. A missing permission or
a deleted post skips that source, records it, and the run still completes.

## Rate budget

All backfill reads use `background` priority, the lowest. They share the
per-connection budget but are admitted only after urgent actions and webhook
fetches, so a long import never starves moderation actions or live comment
fetches.

## Contract for future features

Every comment row has `ingest_origin`, set on insert and never changed. Backfilled
comments have `ingest_origin = 'backfill'`. Features that react to new comments
must read it:

- "New comment" notifications and outbound webhooks must skip `backfill`.
- Rules may act on `backfill` comments only where the rule's own setting allows
  historical items.
- The backfill job itself never acts.

No notifier, outbound webhook or rules engine exists yet; this is the contract
they must follow.

## Operations

- The run is a row in `connection_backfill` (status, counts, checkpoint, failure
  reason, skipped sources) and is exposed per connection on the connections
  list. Jobs of type `connection_backfill` appear in the job queue like any other.
- A long run continues itself in a new segment (`backfill:<runId>:<n>`) before
  the job timeout.
- To re-run a backfill, reconnect the account. There is no admin endpoint in v1.

## Listing recent sources

`listRecentSources` is an optional connector read gated by the `recentSources`
capability. It lists the connection's own posts/media, newest first, and stops
once a page's last item is older than `since`.

- Facebook: `GET /{page-id}/feed?fields=id,created_time,permalink_url&limit=<n>&since=<unix>`
  with `after` or `until` for paging.
- Instagram: `GET /{ig-user-id}/media?fields=id,timestamp,permalink&limit=<n>`
  with `after` for paging. `since` is not sent.

Constraints that hold for both:

- The token travels in the Authorization header only, never in the URL.
- `paging.next` is never requested. Only `paging.cursors.after` is used; for
  Facebook a time-paged response may yield an `until` value from `paging.next`
  (Graph host only, digits only).
- Ids are checked against `GRAPH_ID` and times are parsed defensively; bad items
  are dropped without failing the page.
- Posts older than `since` are skipped client-side, so a pinned or backdated old
  post at the top does not end the listing.

## Verified behaviour

Status: **pending manual verification against the Meta test app.** Nothing below
has been observed yet; B1-B4 are implemented as assumptions with fallbacks.

Requests to run in the Graph API Explorer (v26.0) with the test Page token:

```
GET /{page-id}/feed?fields=id,created_time,permalink_url&limit=5&since=<now-30d unix>
GET the same request with after=<paging.cursors.after of the first response>
GET /{ig-user-id}/media?fields=id,timestamp,permalink&limit=5
```

Record under "Verified behaviour (Graph v26.0, checked YYYY-MM-DD)", without
tokens, cursors, ids or comment text:

| #   | Question                                                                       | Implemented assumption | Fallback if it fails                                                                                                                | Result  |
| --- | ------------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------- |
| B1  | Feed returns posts newest first by `created_time` (pinned post may come first) | yes                    | Client-side filter; stop when the last post of a page is older than `since`                                                         | pending |
| B2  | Feed paging with `since` uses `paging.cursors.after`                           | yes                    | If only `paging.next` with `until=<digits>` is returned, the cursor carries `u:<digits>` and re-requests with `until`               | pending |
| B3  | IG `/media` returns newest first                                               | yes                    | Same client-side stop as B1                                                                                                         | pending |
| B4  | A Page token can read `/{page-id}/feed` with the scopes already requested      | yes                    | No scope is added; on Facebook error 283/200 the run fails with `source_listing_forbidden`; on Instagram it is `reconnect_required` | pending |

Also record: whether a pinned post comes first, and the error code if the token
is refused.
