# Backfill: recent comments on connect

Right after a Page or Instagram account is connected, a background job imports
that connection's comments from the last 30 days. This document records how the
connectors list a connection's recent posts/media and what has been verified
against Meta.

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

| # | Question | Implemented assumption | Fallback if it fails | Result |
|---|---|---|---|---|
| B1 | Feed returns posts newest first by `created_time` (pinned post may come first) | yes | Client-side filter; stop when the last post of a page is older than `since` | pending |
| B2 | Feed paging with `since` uses `paging.cursors.after` | yes | If only `paging.next` with `until=<digits>` is returned, the cursor carries `u:<digits>` and re-requests with `until` | pending |
| B3 | IG `/media` returns newest first | yes | Same client-side stop as B1 | pending |
| B4 | A Page token can read `/{page-id}/feed` with the scopes already requested | yes | No scope is added; on error 283/200 the run fails with `source_listing_forbidden` | pending |

Also record: whether a pinned post comes first, and the error code if the token
is refused.
