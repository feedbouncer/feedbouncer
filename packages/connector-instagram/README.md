# @feedbouncer/connector-instagram

Instagram (Facebook Login) connector. This file currently holds only the
verification log; the package itself is scaffolded later.

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
