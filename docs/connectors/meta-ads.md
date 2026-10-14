# Meta Ads connector

Moderate comments on your Meta ads, including dark posts that never appear on
the Page or the Instagram profile. Ads are listed through an ad account
connection; their comments are read, and moderated, through the Facebook Page
or Instagram account connection that runs the ad.

## What it does

- Lists the active ads of each connected ad account on a schedule.
- Resolves every ad to its Facebook post and, when it runs on Instagram, its
  Instagram media.
- Polls those posts for comments and stores them with an **Ad** label and the
  ad id.
- Hide, delete and reply work as they do for organic comments.

Comments on ads arrive by polling, because Meta sends no webhooks for them.

## Permissions

The ad account connection asks for `ads_read` only. App Review for `ads_read`
is a launch dependency. In development mode it works for app admins who are
also admins of the ad account.

The Page and Instagram connections keep their own permissions; this connector
does not widen them.

## Connecting

1. Connect the Facebook Page and the Instagram account that run your ads, in
   the same brand.
2. On the connections page, choose **Connect ad account** and pick the ad
   accounts to moderate. Each ad account is one connection.
3. To add an ad account created later, connect again and pick it. New ad
   accounts are not picked up automatically.

If ads access is lost, the ad account connection shows **Reconnect to enable ad
moderation**. Organic moderation is not affected.

## How ads map to Pages and Instagram accounts

An ad is matched only to Page and Instagram connections in the **same brand**.
An ad whose Page or Instagram account is not connected there is listed with a
reason and checked again every discovery cycle. Connect the account and the
ad's comments start arriving within one discovery interval.

Meta does not always say which Instagram account runs an ad. Such an ad is never
linked to a guessed account: it is listed as `instagram_account_not_connected`
until Meta reports the account.

## Cadence and settings

Set these on the worker. A value that is empty or unset uses the default.

| Variable                                | Range                              | Default  |
| --------------------------------------- | ---------------------------------- | -------- |
| `META_ADS_CONNECTOR_ENABLED`            | true/false                         | `false`  |
| `META_ADS_ACTIVE_STATUSES`              | up to 10 `effective_status` values | `ACTIVE` |
| `AD_POLL_INTERVAL_SEC`                  | 60..3600                           | 300      |
| `AD_DISCOVERY_INTERVAL_SEC`             | 300..86400                         | 900      |
| `AD_RETIREMENT_GRACE_DAYS`              | 0..30                              | 7        |
| `AD_POLL_MAX_SOURCES_PER_JOB`           | 1..1000                            | 100      |
| `AD_SOURCE_UNAVAILABLE_RETRY_SEC`       | 600..604800                        | 21600    |
| `AD_IG_DEEP_SCAN_INTERVAL_SEC`          | 3600..604800                       | 86400    |
| `AD_SCHEDULER_TICK_SEC`                 | 10..300                            | 30       |
| `AD_SCHEDULER_MAX_CONNECTIONS_PER_TICK` | 1..10000                           | 500      |

The API needs `META_ADS_CONNECTOR_ENABLED` and `META_ADS_ACTIVE_STATUSES` too,
so the connect flow is available. It requires the `FACEBOOK_*` variables.

## Latency

- A comment on a tracked ad appears within one `AD_POLL_INTERVAL_SEC`, plus
  the time a busy queue takes to run the job.
- A new ad is tracked within one `AD_DISCOVERY_INTERVAL_SEC`.
- Instagram's list endpoint returns top-level comments only on each poll, so a
  full scan runs every `AD_IG_DEEP_SCAN_INTERVAL_SEC` to catch late replies on
  older comments. Those replies can take up to that long to appear.

## Large ad accounts

Listing an ad account can take several jobs when it has many ads, because
discovery shares the background rate-limit budget. The listing resumes where it
stopped, and ads are retired only once a listing has completed.

## Retirement

When an ad stops being active, or disappears from the ad account, its posts keep
being polled for `AD_RETIREMENT_GRACE_DAYS` and then stop. Polling also stops
at once when the ad account, Page or Instagram connection is revoked or needs
reconnecting. Stored comments are kept.

## Rate limits

Ad polling runs at a lower priority than webhook ingest and moderation actions
and may use at most half of the read budget, so it cannot starve them. Meta's
ad account throttle (error 80004) is honoured like any other rate limit: the
poll is deferred and resumes where it left off. A very large comment list is
read across several jobs.

## Unresolved reasons

| Reason                            | Shown as                                        |
| --------------------------------- | ----------------------------------------------- |
| `page_not_connected`              | Connect the Facebook Page that runs this ad     |
| `instagram_account_not_connected` | Connect the Instagram account that runs this ad |
| `instagram_media_pending`         | Waiting for Instagram to publish this ad        |
| `no_post`                         | This ad type has no post to moderate            |
| `dynamic_creative_unsupported`    | Catalog ads are not supported yet               |
| `post_deleted`                    | The ad's post was deleted                       |
| `invalid_platform_id`             | Meta returned an unexpected id                  |
| `not_instagram`                   | Not running on Instagram                        |

A post that cannot be read (deleted, or the account lost access to it) is shown
as "Post unavailable" and retried every `AD_SOURCE_UNAVAILABLE_RETRY_SEC`.
If every Instagram media of a connection is refused in the same run, the
connection is marked as needing reconnect, because the account-level
permission was most likely revoked.

## Limitations

- Catalog and dynamic creative ads have no single post and are not moderated.
- Lead-form ads are not covered.
- There are no ad webhooks; everything is polled.
- A comment is stored once per connection, whichever ad or media it was found
  through.

Facts about Meta's API behaviour that have not been confirmed against a live
app are listed in the package README under "Verified behaviour"
(`packages/connector-meta-ads/README.md`).
