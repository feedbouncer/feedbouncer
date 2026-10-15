# Comment classifier

The classifier scores every newly ingested comment with a language model and
applies per-brand thresholds to the scores. It runs only when no moderation
rule decided the comment, and it never blocks ingestion.

It is optional. Without `CLASSIFIER_PROVIDER` every comment shows
"Not classified: no classifier is configured" and nothing else changes.

## Categories

Each category gets an independent score from 0.0 to 1.0.

| Key                | Label               | Definition                                                                                                                                                |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spam`             | Spam                | Repetitive, bulk, bot-like or irrelevant promotional content.                                                                                             |
| `scam_phishing`    | Scam or phishing    | Fraud, fake giveaways, impersonation, requests to DM another account, credential or payment harvesting, suspicious links.                                 |
| `harassment_abuse` | Harassment or abuse | Insults, threats, bullying or targeted abuse of a person or group.                                                                                        |
| `hate_speech`      | Hate speech         | Attacks on people based on protected characteristics (race, ethnicity, religion, nationality, sex, gender identity, sexual orientation, disability, age). |
| `sexual_content`   | Sexual content      | Sexually explicit or solicitous content.                                                                                                                  |
| `profanity`        | Profanity           | Swearing or vulgar language, even when not aimed at anyone.                                                                                               |
| `self_promotion`   | Self-promotion      | Promoting the commenter's own account, product, channel or service.                                                                                       |

A genuine complaint about the brand, product or service is not harassment and
not spam. The model also reports the main language of the comment.

## Default thresholds

| Category                      | Threshold | Action |
| ----------------------------- | --------- | ------ |
| Hate speech, Scam or phishing | 0.80      | Hide   |
| All other categories          | 0.80      | Flag   |

A brand with no settings uses these defaults, so it is never unmoderated.
Admins can set a threshold (0 to 1) and an action (Allow, Flag, Hide or Delete)
per category under the brand's classifier settings, or restore a category's
default. Out-of-range values are rejected with the offending field named.

## Evaluation order

1. Rules run first (see [rules.md](rules.md)). If an enforcing rule decided
   the comment, the classifier records its scores but takes no action of its
   own. A rule in dry run does not decide, so the classifier still applies.
2. Only when no rule decided are the thresholds applied.
3. A category triggers when its score is **greater than or equal to** its
   threshold.
4. When several categories trigger, the most severe action wins
   (Delete > Hide > Flag > Allow). Ties go to the larger margin over the
   threshold, then to a fixed category order. Every triggering category is
   recorded with its score, threshold and action.
5. Hide and Delete go through the normal moderation request, so they are
   deduplicated and rate limited like a manual action. If the platform cannot
   perform it, the comment is flagged for review and the decision says why.

Comments that were deleted, posted by the brand's own account, or never
evaluated by rules (such as backfilled history) are skipped. Hidden comments
are still classified.

## Low-confidence input

- **Low signal:** empty text, or text with fewer than three letters or digits
  once whitespace and invisible characters are removed (emoji-only comments).
  Empty text is not sent to the provider and scores zero.
- **Unsupported language:** the model reports a language that is not in
  `CLASSIFIER_LANGUAGES`, or it cannot determine one.

In both cases a Hide or Delete action is downgraded to **Flag for review**, and
the decision says so. Such comments are never silently treated as safe and
never destructively actioned on low confidence.

## Failures

A provider timeout, rate limit, outage or invalid answer is retried up to three
attempts with backoff. After that the comment is marked **Not classified** with
a reason (timed out, rate limited, unavailable, authentication failed, invalid
output, rejected request, no classifier configured, or waited too long) and no
action is taken. The comment itself has already been ingested and rules have
already run.

## Edits and duplicates

A comment is classified once per distinct text. Redelivered webhooks and polls
that do not change the text do nothing, and identical text scored earlier with
the same provider, model and prompt version reuses the stored scores.

An edited comment is classified again. If the classifier had hidden it and the
new text no longer reaches the threshold, it is unhidden, but only if no person
or rule acted on it afterwards.

## Changing thresholds

- Changes apply to **new comments only**. Existing decisions do not change.
- Each change records who made it and when.
- **Preview:** shows how many recent comments would change outcome under
  proposed settings, using stored scores and modifying nothing. It looks back
  at most 30 days (default 7) and examines at most 20,000 comments.
- **Re-run:** explicitly re-applies the current settings to recent comments.
  It covers at most 30 days (default 7) and 5,000 comments per connection, may
  be requested once per 15 minutes per brand, and reuses stored scores where
  possible. A re-run unhides a comment the classifier hid when the current
  settings no longer hide it, provided nobody acted on it afterwards. A re-run
  never hides or deletes a comment again after a moderator acted on it: the
  comment is flagged for review and the decision says so. A re-run with no
  active connection records nothing and does not start the 15-minute window.

## Fairness and limits

- Classification runs on its own queue lane, so it cannot delay ingestion,
  polling or moderation actions.
- Within the lane, one brand holds at most `CLASSIFIER_BRAND_MAX_IN_FLIGHT`
  (default 2) of the provider calls at a time. Further work for that brand is
  deferred and retried.
- Total concurrency per platform is `JOB_CONCURRENCY_LANE_CLASSIFY`
  (default 4, `0` disables the lane in that process). Keep it **above**
  `CLASSIFIER_BRAND_MAX_IN_FLIGHT`: when the two are equal, one brand's backlog
  can hold every slot and other brands wait until they time out. The worker
  logs a warning at startup when the lane is not wider than the per-brand cap.
- Lane consumers start only for platforms whose own concurrency
  (`JOB_CONCURRENCY`, `JOB_CONCURRENCY_<PLATFORM>`) is above 0.
- A classification that waits longer than `CLASSIFIER_MAX_WAIT_MINUTES`
  (default 30) is recorded as Not classified. After a model or prompt change a
  large re-run can exceed this wait and record Not classified for part of the
  comments, because stored scores can no longer be reused for the new model. A
  re-run may be requested again once 15 minutes have passed; comments that
  already have scores for the current model are reused.

## Configuration

The classifier is configured on the worker. The API reads only the provider
and model for display.

| Variable                         | Default                | Meaning                                                                                               |
| -------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `CLASSIFIER_PROVIDER`            | `none`                 | `openai`, `google`, `openai_compatible` or `none`.                                                    |
| `CLASSIFIER_MODEL`               | none                   | Model id. Required unless the provider is `none`.                                                     |
| `CLASSIFIER_API_KEY`             | none                   | Secret. Prefer `CLASSIFIER_API_KEY_FILE`. Required except for a keyless `openai_compatible` endpoint. |
| `CLASSIFIER_BASE_URL`            | provider default       | Required for `openai_compatible`. No credentials, query or fragment.                                  |
| `CLASSIFIER_ALLOW_HTTP`          | `false`                | Permit a plain `http` base URL on a non-loopback host.                                                |
| `CLASSIFIER_TIMEOUT_MS`          | `10000`                | 1000 to 25000, per provider call.                                                                     |
| `CLASSIFIER_LANGUAGES`           | `en,es,pt,fr,de,it,nl` | Lower-case ISO 639 codes the model is trusted for.                                                    |
| `CLASSIFIER_BRAND_MAX_IN_FLIGHT` | `2`                    | 1 to 16 concurrent provider calls per brand.                                                          |
| `CLASSIFIER_MAX_WAIT_MINUTES`    | `30`                   | 1 to 90.                                                                                              |
| `JOB_CONCURRENCY_LANE_CLASSIFY`  | `4`                    | Classification workers per platform.                                                                  |

Base URLs must use `https`, except that `http` is accepted for loopback hosts
(`localhost`, `127.0.0.1`, `[::1]`) or when `CLASSIFIER_ALLOW_HTTP=true`.

Examples:

```
CLASSIFIER_PROVIDER=openai     CLASSIFIER_MODEL=gpt-5-mini        CLASSIFIER_API_KEY_FILE=/run/secrets/classifier_key
CLASSIFIER_PROVIDER=google     CLASSIFIER_MODEL=gemini-2.5-flash  CLASSIFIER_API_KEY_FILE=/run/secrets/classifier_key
CLASSIFIER_PROVIDER=openai_compatible  CLASSIFIER_MODEL=llama3.1
CLASSIFIER_BASE_URL=http://ollama:11434/v1  CLASSIFIER_ALLOW_HTTP=true
```

## Data and privacy

- Only the comment text, truncated to 4,000 characters, is sent to the
  configured provider, together with a fixed instruction. Author names, ids,
  handles, URLs of the comment, and brand details are not sent.
- Comment text is untrusted input: the provider is told to treat it as data,
  and its answer is validated against a fixed schema.
- The model's free text is never stored. A decision stores the seven scores,
  the language, the provider and model, the prompt version and a generated
  readable reason built from category names and numbers.
- Logs carry identifiers only. API keys are read from the environment or a
  mounted secret file and are never logged or returned by the API.
- Use a self-hosted `openai_compatible` endpoint if comment text must not leave
  your infrastructure.

## Open questions

- A review queue for comments that could not be classified.
- Tuning the default thresholds against a labelled sample of real comments.
