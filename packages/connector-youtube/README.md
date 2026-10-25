# @feedbouncer/connector-youtube

YouTube Data API v3 connector, built on `SafeHttp` with no Google SDK. Every Data API call goes through `youtubeCall`, which reserves the call's unit cost on the `QuotaMeter` in `CallContext.quota` before sending and settles it afterwards, failed calls included. A context without a meter is refused with `quota_meter_required`.

- `config.ts`: scope names, hosts, `YouTubeConnectorConfig`. The connector's own scope name is `youtube.force-ssl`; the Google URL appears only in the consent URL.
- `costs.ts`: unit cost per method (`commentThreads.list`, `comments.list`, `channels.list` = 1, `comments.setModerationStatus` = 50), `MAX_BATCH = 50`, `BATCH_UNITS = 51`.
- `ids.ts`: strict id patterns. Every id is checked before it is stored or placed in a URL.
- `api.ts`: `youtubeCall` and `mapGoogleError` (keyed on `error.errors[0].reason`).
- `oauth.ts`: Google OAuth with PKCE (`access_type=offline`, `prompt=consent`), token refresh, revoke, and `listAccounts` (`channels.list?mine=true`, metered on `projectQuota` as `connect`).
- `@feedbouncer/connector-youtube/testing`: `FakeYouTube`, a `fetch` for `createSafeHttp({ fetch })`.

## Verified behaviour (not yet checked)

The fake implements the primary assumption for each row until it is checked against a real Google Cloud project.

| #   | Question                                                                                 | Result     | Code path affected                |
| --- | ---------------------------------------------------------------------------------------- | ---------- | --------------------------------- |
| Y1  | Holding (`heldForReview`) a naturally published comment is allowed                       | unverified | `FakeYouTube.setModerationStatus` |
| Y2  | One missing id in a `setModerationStatus` batch fails the whole call with 404            | unverified | `FakeYouTube.setModerationStatus` |
| Y3  | `comments.list?id=` omits rejected comments and returns `moderationStatus` for held ones | unverified | `FakeYouTube.listComments`        |
| Y4  | Exact `reason` strings (`commentsDisabled`, `quotaExceeded`, `operationNotSupported`, …) | unverified | `mapGoogleError`                  |
| Y5  | The thread resource carries at most 5 replies inline                                     | unverified | `FakeYouTube` (`INLINE_REPLIES`)  |
