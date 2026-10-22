---
title: Moderation check
description: Judge text against a brand's rules, classifier and policies before you publish it.
status: stable
---

`POST /v1/moderation/check` judges any text the way FeedBouncer would judge a comment, and answers `allow`, `review` or `block`. Use it to screen text you are about to publish, such as a reply or a post. It needs a `moderate`, `read` or `write` key.

Nothing is stored in the database. The text waits in Redis only until the check finishes or times out, then it is deleted, and it is never logged. Retention settings do not apply, because there is nothing to retain.

## Request

```bash
curl -sS -X POST "$FEEDBOUNCER_URL/v1/moderation/check" \
  -H "Authorization: Bearer $FEEDBOUNCER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "<TEXT_TO_CHECK>", "brandId": "<BRAND_ID>", "ref": "post-1234"}'
```

- `text` is required. It is at most 4,000 UTF-16 code units, which is what the classifier reads, so nothing is silently cut. It must be valid UTF-8, contain no U+0000 and have a visible character.
- `brandId` picks the brand whose rules apply. It is optional when the workspace has exactly one active brand.
- `ref` is optional, 1 to 128 printable ASCII characters. It is echoed back so you can match answers to requests.
- Unknown fields are rejected.

## Response

```json
{
  "verdict": "block",
  "reasonCode": "rule_matched",
  "reason": "Rule \"Spam links\" (link): spam.example.",
  "decidedBy": "rule",
  "degraded": false,
  "evidence": {
    "ruleId": "<RULE_ID>",
    "ruleName": "Spam links",
    "category": null,
    "score": null,
    "threshold": null,
    "policyId": null,
    "policyRevision": null,
    "language": null
  },
  "models": { "classifier": null, "policy": null },
  "brandId": "<BRAND_ID>",
  "ref": "post-1234",
  "checkedAt": "2026-10-22T15:00:00.000Z"
}
```

## Verdicts

A matching rule decides first, and that includes a rule that approves. If no rule matches, the more severe of the classifier and custom policy outcomes wins. With no match at all, the verdict is `allow`. The order is the one used for [rules](../rules/precedence.md) and [policies](../concepts/ai-classifier-and-policies.md).

`decidedBy` says what decided: `rule`, `classifier`, `policy`, `none` or `degraded`. `evidence` holds the details: the rule, the category and score against its threshold, or the policy and its revision.

## Reason codes

Match on `reasonCode`, not on `reason`. Codes are only ever added, never renamed.

| Code                        | Meaning                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `rule_matched`              | A rule decided.                                                        |
| `classifier_threshold`      | The classifier scored a category over its threshold.                   |
| `policy_matched`            | A custom policy decided.                                               |
| `no_match`                  | Nothing matched, so the verdict is `allow`.                            |
| `classifier_unavailable`    | The classifier could not answer.                                       |
| `classifier_not_configured` | This instance has no classifier.                                       |
| `policy_unavailable`        | A policy could not be checked, or its budget or call limit is used up. |

## Degraded checks

A check that could not fully run is never `allow`. You get `review`, `degraded: true` and the matching `classifier_unavailable`, `classifier_not_configured` or `policy_unavailable` code. An instance without a classifier holds every text that no rule decided. Treat `review` as "have a person look", not as a pass.

Policy checks count against the brand's monthly policy-check budget and its limit on concurrent policy calls, as connected comments do. When either is used up, the answer is `review` with `policy_unavailable`.

## Errors

| Status                        | Cause                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `400 invalid_request`         | A bad body, text that is malformed or has no visible character, or a missing `brandId`. |
| `404 not_found`               | An unknown or archived brand, or one of another organization.                           |
| `413`                         | The body is over the size limit. See [Errors](./errors.mdx#request-size).               |
| `422 text_too_long`           | The text is over 4,000 code units. `maxLength` has the limit.                           |
| `429 rate_limited`            | The per-key [rate limit](./rate-limits.mdx) applies.                                    |
| `500 internal_error`          | The check itself failed.                                                                |
| `503 temporarily_unavailable` | The worker did not answer in time. `Retry-After: 5`.                                    |

A retry is always safe, because a check changes nothing. The worker has 20 seconds to answer by default. Self-hosters change that with `MODERATION_CHECK_TIMEOUT_MS`.
