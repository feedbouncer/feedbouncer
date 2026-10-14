# @feedbouncer/connector-meta-ads

Meta Ads connector: lists a user's ad accounts and their active ads so that ad-post comments can be polled.

## Verified behaviour (Graph v26.0, not yet checked)

Each row is checked against the Meta development app and an ad account the tester administers. Until then the primary assumption is implemented and the row stays `unverified`.

| #   | Question                                                                                                   | Result     | Code path affected                      |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------- |
| A1  | `GET /me/adaccounts?fields=id,account_id,name,account_status`                                              | unverified | `listAdAccounts`                        |
| A2  | `effective_status=["ACTIVE"]` filters `/act_<id>/ads`                                                      | unverified | `listActiveAds` query                   |
| A3  | `creative{id,effective_object_story_id,effective_instagram_media_id,instagram_user_id,object_type}` inline | unverified | `AD_FIELDS`                             |
| A4  | IG webhook `media.id` for an ad comment equals `effective_instagram_media_id`                              | unverified | docs only                               |
| A5  | Page token reads `/<PAGEID_POSTID>/comments?filter=stream` on a dark post                                  | unverified | launch blocker if no                    |
| A6  | IG `replies.limit(50){…}` expands inline on `/<media>/comments`                                            | unverified | `includeReplies` in connector-instagram |
| A7  | Long-lived token lifetime; `ads_read` kept after exchange                                                  | unverified | docs only                               |
| A8  | Error code/subcode without ad-account access; dev-tier (270)                                               | unverified | `AD_ACCOUNT_PERMISSION_CODES`           |
