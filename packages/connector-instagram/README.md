# @feedbouncer/connector-instagram

Instagram connector that signs in with Facebook Login. It reads comments on an
Instagram Business or Creator account through the linked Facebook Page's token
and sends hide, unhide, delete, public reply and private reply back. It reuses
the Facebook connector's Graph client, OAuth flow and webhook signature, and
runs on the same Meta app.

- `config.ts`: `INSTAGRAM_CONNECTOR_ENABLED` and the scopes.
- `oauth.ts`: lists the Pages a person manages with their linked Instagram
  account; Pages without one are returned as ineligible.
- `comments.ts`: reads comments, replies and single comments.
- `actions.ts`: moderation, replies and the Page subscription lifecycle (the
  `comments` field, merged with whatever else the Page is subscribed to).
- `errors.ts`: refines Graph errors into not-eligible outcomes and reconnect
  reasons.
- `webhook.ts`: parses the `instagram` object's `comments` changes.

For setup, permissions and limits, see
[docs/connectors/instagram.md](../../docs/connectors/instagram.md). Platform
behaviour that has not been observed against a live app is listed below, and
the code paths named there are the ones to revisit when it is.

## Verified behaviour (Graph v26.0, checked 2026-10-13)

| #   | Question                                                                                        | Result       | Code path affected                                          |
| --- | ----------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------- |
| V1  | `POST /{page}/subscribed_apps subscribed_fields=comments` accepted; IG comments webhooks arrive | `unverified` | `INSTAGRAM_PAGE_FIELDS` in connector-instagram `actions.ts` |
| V2  | Private reply works without `instagram_manage_messages`                                         | `unverified` | `INSTAGRAM_SCOPES`                                          |
| V3  | Error codes: already replied / window closed / nested / hidden reply / restricted               | `unverified` | `mapInstagramError`, `IG_PRIVATE_REPLY_INELIGIBLE`          |
| V4  | `hide` accepted in form body                                                                    | `unverified` | `act`                                                       |
| V5  | `entry.time` unit                                                                               | `unverified` | `parseInstagramWebhook` (handles both anyway)               |
| V6  | `media{id,permalink}` expands on IG comment                                                     | `unverified` | `IG_COMMENT_FIELDS`                                         |
| V7  | Public reply / private reply max length                                                         | `unverified` | `IG_LIMITS`                                                 |
| V8  | Our own API reply triggers a comments webhook                                                   | `unverified` | docs only                                                   |
| V9  | Own comments carry `user.id` equal to the account id (own-account detection)                    | `unverified` | `toNormalizedIgComment`                                     |
