---
title: Pagination
description: How list routes page with limit and cursor, and a loop that reads every page.
status: stable
---

List routes, such as `GET /v1/comments`, `GET /v1/flagged-items` and `GET /v1/webhook-endpoints`, return one page at a time:

```json
{
  "data": [],
  "nextCursor": "<CURSOR>"
}
```

`nextCursor` is `null` on the last page.

## Parameters

| Parameter | Meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `limit`   | Items per page. The default is 50 and the most is 100.                                          |
| `cursor`  | The `nextCursor` of the previous page. Leave it out for the first page. At most 512 characters. |

Lists are ordered newest first.

## Cursors are opaque

Treat a cursor as a string you pass back unchanged. Its contents can change between releases, so do not parse or build one.

A cursor is bound to the filters of the request that made it. Send it with the same filters (`brandId`, `status`, `q` and so on), or you get `400 invalid_cursor`. A malformed or tampered cursor gets the same error. To change a filter, start again without a cursor.

A cursor also keeps the result set it started with, so a long read neither repeats nor skips comments when new ones arrive.

## Reading every page

```bash
cursor=""
while :; do
  page=$(curl -sS -G "$FEEDBOUNCER_URL/v1/comments" \
    -H "Authorization: Bearer $FEEDBOUNCER_API_KEY" \
    --data-urlencode "status=flagged" \
    --data-urlencode "limit=100" \
    ${cursor:+--data-urlencode "cursor=$cursor"})
  echo "$page" | jq -c '.data[]'
  cursor=$(echo "$page" | jq -r '.nextCursor // empty')
  [ -n "$cursor" ] || break
done
```

Mind the [rate limit](./rate-limits.mdx) in long loops, and stop on any error: see [Errors](./errors.mdx).
