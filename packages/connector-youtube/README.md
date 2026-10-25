# @feedbouncer/connector-youtube

YouTube Data API v3 connector, built on `SafeHttp` with no Google SDK. Every Data API call goes through `youtubeCall`, which reserves the call's unit cost on the `QuotaMeter` in `CallContext.quota` before sending and settles it afterwards, failed calls included. A context without a meter is refused with `quota_meter_required`.

- `config.ts`: scope names, hosts, `YouTubeConnectorConfig`. The connector's own scope name is `youtube.force-ssl`; the Google URL appears only in the consent URL.
- `costs.ts`: unit cost per method (`commentThreads.list`, `comments.list`, `channels.list` = 1, `comments.setModerationStatus` = 50), `MAX_BATCH = 50`, `BATCH_UNITS = 51`.
- `ids.ts`: strict id patterns. Every id is checked before it is stored or placed in a URL.
- `api.ts`: `youtubeCall` and `mapGoogleError` (keyed on `error.errors[0].reason`).
- `text.ts`: plain-text bodies (`textOriginal`, else `textDisplay` requested with `textFormat=plainText`; kept literal, never HTML-interpreted; NUL replaced; at most 10,000 code points) and cleaned author/channel names.
- `threads.ts`: `listChannelThreads` (`commentThreads.list?allThreadsRelatedToChannelId`, 100 threads per unit, threads with an invalid id or video id dropped and counted), `probeThreadReplyCounts` (≤ 50 threads for 1 unit), `listThreadReplies` (`comments.list?parentId=`) and `getComment` (`comments.list?id=`). Permalinks are built from validated ids (`https://www.youtube.com/watch?v=<video>&lc=<comment>`); author profile URLs and images are never kept; an author id that fails `CHANNEL_ID` makes `author: null`.
- `moderation.ts`: `actBatch` (one `setModerationStatus` call for ≤ 50 ids: hide → `heldForReview`, unhide → `published`, delete → `rejected`, ban_author → `rejected` + `banAuthor=true`; a 404 is `not_found`, a 400 on a hold is `permanent hold_not_allowed`), `act` (a one-target batch) and `probeComments` (`comments.list?id=`, an id missing from the response is `gone`).
- `connector.ts`: `createYouTubeConnector`. The generic `listComments` lists the replies of one thread (`sourceExternalId` is the thread id, which is the top-level comment id); in a `CommentRef`, `sourceExternalId` is the video id. `onDisconnected` revokes the grant and logs a failure by code only.
- `oauth.ts`: Google OAuth with PKCE (`access_type=offline`, `prompt=consent`), token refresh, revoke, and `listAccounts` (`channels.list?mine=true`, metered on `projectQuota` as `connect`).
- `@feedbouncer/connector-youtube/testing`: `FakeYouTube`, a `fetch` for `createSafeHttp({ fetch })`.

## Verified behaviour (not yet checked)

The fake implements the primary assumption for each row until it is checked against a real Google Cloud project.

| #   | Question                                                                                                                                                                   | Result     | Code path affected                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------- |
| Y1  | Holding (`heldForReview`) a naturally published comment is allowed                                                                                                         | unverified | `FakeYouTube.setModerationStatus`              |
| Y2  | One missing id in a `setModerationStatus` batch fails the whole call with 404                                                                                              | unverified | `FakeYouTube.setModerationStatus`              |
| Y3  | `comments.list?id=` omits rejected comments and returns `moderationStatus` for held ones (held detection by probe; an item without `moderationStatus` probes as `visible`) | unverified | `probeComments`, `FakeYouTube.listComments`    |
| Y4  | Exact `reason` strings (`commentsDisabled`, `quotaExceeded`, `operationNotSupported`, …)                                                                                   | unverified | `mapGoogleError`                               |
| Y5  | The thread resource carries at most 5 replies inline                                                                                                                       | unverified | `FakeYouTube` (`INLINE_REPLIES`)               |
| Y6  | A reply from `comments.list?parentId=` carries `snippet.videoId`                                                                                                           | unverified | `listThreadReplies` (drops a reply without it) |
| Y7  | `textOriginal` is returned to the channel owner for other users' comments (otherwise the plain-text `textDisplay` is stored)                                               | unverified | `threads.ts` normalisation                     |
| Y8  | `rejected` replies are omitted from `comments.list?parentId=` and the thread feed                                                                                          | unverified | `FakeYouTube.replies`                          |

Documentation conflicts to settle when checking (Context7, `/websites/developers_google_youtube_v3`, 2026-10-25):

- Y3: the `comments` resource page says `moderationStatus` "isn't set if the API request used the `id` filter parameter". An item without it probes as `visible` (the conservative default: a redundant hold write is idempotent and costs units, never a wrong skip). Held detection by probe is therefore unverified; the dispatcher relies mainly on the stored comment state for "already held".
- Y7: the same page says `textOriginal` "is only returned to the authenticated user if they are the comment's author". When it is absent the body is `textDisplay`, which every read requests with `textFormat=plainText`; any markup in it stays literal text.
- The comment snippet table does not list `videoId` (the update example does), which is Y6.
