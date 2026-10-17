# Slack and email alerts

A workspace admin connects Slack incoming webhooks and confirmed email recipients, then routes two alert types to them per brand. Alerts run in the worker, on their own Postgres tables, and never share a queue with ingestion or moderation, so a broken channel cannot delay comment processing.

## Alert types

- **Negative-comment spike.** Sent when a brand's negative comments in the last 60 minutes are well above its own usual level. One alert opens an episode. During the cooldown, at most one "Still escalating" update follows, when the count has doubled since the alert started.
- **Flagged-item digest.** Sent when comments land in the review queue. Flags are batched: a digest is sent once the oldest pending flag is 2 minutes old, with up to 100 items. Flags resolved in the meantime are dropped, and no message is sent if none remain.

Backfilled (historical) comments never trigger alerts. A flag only counts if it was created after the route was enabled.

## What counts as negative

A comment is negative when it is live (not backfilled), not posted by the brand's own account, and has at least one decision that **was enforced** with outcome `hide`, `remove` or `flag`. That covers rule, classifier, policy and moderator decisions.

These do not count:

- suggestions and review-mode decisions (`mode = 'suggest'`), because nothing was done to the comment;
- decisions from rules that are not enforced;
- `approve` decisions.

The same definition drives the "View comments" link in a spike alert, so the count in the message and the linked list agree.

## Spike formula

For each brand, every 5 minutes:

1. Window: comments posted in `[now - 60 min, now)`. `N` is the number of negative comments, `T` the total.
2. Baseline: the hourly rollup over the last 14 days (or since the brand's first live comment, if later), excluding the current window. `expected = max(2, baselineNegatives / baselineHours)` per hour; `2` is used when there is no baseline yet.
3. `k` depends on sensitivity: high 2, medium 3, low 5.
4. No alert while the brand has had live comments for less than 7 days (learning), or while `N < min_negative_count`.
5. The alert fires when either condition holds:
   - volume: `N >= k * expected`;
   - share: `N / T >= clamp(k * baselineShare, 25%, 90%)`, where `baselineShare = baselineNegatives / baselineTotal`.

Worked example (medium, minimum 10): over 14 days a brand had 1,008 negative of 10,080 comments in 336 hours. `expected = 3` per hour, so the volume threshold is `3 * 3 = 9`. The share threshold is `3 * 10% = 30%`. In the last hour 12 of 60 comments were negative. `N = 12` clears the minimum (10) and the volume threshold (9), so the alert fires on volume; the share (20%) alone would not have. With 9 negatives it would stay quiet, because it is below the minimum.

The alert shows how it was triggered and the usual level, so it is explainable from the message and the brand's alert page.

## Defaults and ranges

| Setting                        | Default    | Range                                          |
| ------------------------------ | ---------- | ---------------------------------------------- |
| Sensitivity                    | `medium`   | `low`, `medium`, `high`                        |
| Minimum negative comments      | 10         | 3 to 1000                                      |
| Cooldown                       | 360 min    | 30 to 1440 min                                 |
| Content mode                   | `excerpts` | `excerpts`, `counts_only`                      |
| Alerts per workspace per hour  | 30         | 1 to 1000 (`ALERT_MAX_PER_WORKSPACE_PER_HOUR`) |
| Emails per minute (deployment) | 60         | 1 to 6000 (`ALERT_EMAIL_MAX_PER_MINUTE`)       |

In `excerpts` mode an alert carries up to 3 sanitized excerpts of 140 characters (links replaced by `[link]`, mentions defused). `counts_only` loads no comment text at all. When a workspace exceeds its hourly cap, one "Alert limit reached" message is sent and further alerts are paused until the next hour.

## Configuration

Alerts are off until `ALERT_CHANNELS` is set. Set it on **both** the API and the worker.

| Variable                           | Used by     | Description                                                                                                          |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `ALERT_CHANNELS`                   | api, worker | Comma list of `slack`, `email`. Unset or empty disables alerts. An unknown value stops startup.                      |
| `ALERT_MAX_PER_WORKSPACE_PER_HOUR` | api, worker | Integer 1 to 1000, default 30.                                                                                       |
| `ALERT_EMAIL_MAX_PER_MINUTE`       | worker      | Integer 1 to 6000, default 60. Applies to the whole deployment.                                                      |
| `SMTP_URL`, `MAIL_FROM`            | api, worker | Required for `email`. The worker refuses to start with `email` enabled and no `SMTP_URL`.                            |
| `PUBLIC_WEB_URL`                   | api, worker | Origin used in every link (view comments, review queue, confirm, unsubscribe). Required whenever alerts are enabled. |

With alerts disabled the worker starts no alert loops and logs one `alerts.disabled` line. The API answers alert writes with `409 alerts_unavailable`, and the web app's Alerts pages say that alerts aren't set up on this server and show no forms.

## Creating a Slack incoming webhook

1. In Slack, open [api.slack.com/apps](https://api.slack.com/apps), create an app for your workspace and enable **Incoming Webhooks**.
2. Choose **Add New Webhook to Workspace** and pick the channel.
3. Copy the URL (`https://hooks.slack.com/services/T.../B.../...`) into **Alerts > Slack channels** (button **Connect Slack**) in FeedBouncer. The Alerts link is on the workspace page and is shown to owners and admins.

The URL is a credential. FeedBouncer stores it encrypted and shows only a short hint such as `T...ABCD/B...WXYZ`. Only `hooks.slack.com` URLs of this exact form are accepted. Slack revokes URLs that leak publicly; if that happens, create a new webhook and reconnect.

## Network egress

The worker and the API (for test sends) need outbound HTTPS to `hooks.slack.com:443`. Redirects are never followed. Email needs your SMTP server.

## Delivery problems and disconnected channels

- **Delivery problem.** A send failed. Transient failures (Slack 429 and 5xx, network errors, SMTP 4xx) are retried with backoff at 30 s, 2 min, 10 min, 30 min and 2 h, honoring Slack's `Retry-After` (up to 1 h). Permanent failures (rejected payload, SMTP 5xx) are not retried and the channel shows a delivery problem.
- **Disconnected.** Slack answered that the webhook no longer exists or is not allowed (for example `no_service`, `invalid_token`, `channel_not_found`, `channel_is_archived`). The channel is switched off, owners and admins are emailed (when email is enabled), and no further messages are sent until it is reconnected.

To reconnect, open the workspace **Alerts** page, choose **Reconnect** on the channel and paste a new webhook URL. Failure state is cleared and delivery resumes. Use **Send test** to check a channel at any time.

## Email recipients and unsubscribe

Adding an address sends a confirmation email; the address receives nothing else until the link (valid 7 days) is opened. The confirmation and unsubscribe links open pages at `/alerts/confirm?token=...` and `/alerts/unsubscribe?token=...` that ask for one button press before anything changes. Every alert email carries an unsubscribe link and `List-Unsubscribe` headers, including RFC 8058 one-click (`List-Unsubscribe-Post`), so mail clients can unsubscribe in one step without signing in. An unsubscribed address stays listed; an admin can choose **Resend** to send it a new confirmation, and it receives alerts again once confirmed.

## Known limits

- Spikes are evaluated per brand, not per connection or per account (the alert lists the accounts involved).
- There are no quiet hours, SMS or push.
- Timestamps use the brand's timezone; workspaces have none.
- A worker crash right after Slack accepted a message but before it was recorded marks that delivery failed (`outcome_unknown`) and it is not re-sent, so at most one in-flight message can be dropped.
- Sent messages are not retracted when the underlying comments change.
