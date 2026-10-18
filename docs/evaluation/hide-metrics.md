# Measuring false hides, time to hide, missed comments and cost

This document defines four measures of FeedBouncer's moderation, explains how to produce them from your own data, and lists what they cannot tell you. It is meant to be enough for a third party to repeat the evaluation. Everything runs on your own machine; nothing is sent anywhere.

## What is measured

The four measures are the false-hide rate, the time to hide, the missed rate and the cost per 1,000 comments. A fifth, optional comparison puts FeedBouncer next to Meta's built-in moderation.

### Terms

- **Hidden (removal).** A comment counts as hidden when FeedBouncer's earliest hide or delete on it took effect, or found the comment already hidden. FeedBouncer's own hides come from automation (a rule, the classifier, the policy model or the system) or from a person approving a suggestion in review mode. A hide a person does by hand in the platform, or in FeedBouncer without a suggestion, is not a FeedBouncer hide. A FeedBouncer delete counts as a removal for the false-hide and missed measures and is reported separately as "removals by delete". A hide that was attempted and failed is "hide failed" and counts as not hidden.
- **Restored.** A hidden comment is restored when a person later made it visible again (an unhide by a user, or the comment is visible on the platform with no unhide by FeedBouncer in between). A hide that FeedBouncer itself reversed is reported as self-reversed and is not a restore.
- **Judged version.** Labellers judge the comment text as FeedBouncer saw it. If the comment was edited after the hide and the hidden text is no longer available, the exported text is not the judged version. Such comments are excluded from every label-based measure (false hides, missed, Meta comparison). They remain in the time and cost measures.
- **Author-deleted.** A comment the author deleted, with no FeedBouncer removal applied, is excluded everywhere.
- **Cohort.** Automatic: FeedBouncer hides on its own. Review: review mode is on and a person must approve each hide. The two cohorts are always measured separately, because review mode includes the wait for a human. The Meta comparison uses the automatic cohort only.
- **Channel.** How FeedBouncer received the comment: `webhook` (the platform pushed it), `poll` (found by a scheduled fetch) or `backfill` (loaded from history after connecting). Backfill comments are excluded from time to hide, because FeedBouncer saw them long after they were posted.
- **Ground truth.** The verdict `should_hide` or `should_stay` that human labellers settle on for each comment (see Labelling guide). Measures use it as the correct answer.
- **Decider.** What caused the hide: `rule:<kind>`, `classifier:<category>`, `policy`, `system`, or `suggestion:<rule|classifier|policy>` for a hide a person approved.

### False-hide rate

Of the judged comments FeedBouncer hid (hidden, judged version available, labelled), the share that is a false hide. A hidden comment is a false hide if the settled verdict is `should_stay`, or if a person restored it. The report shows the count and the sample size (`k of n`), a 95% interval, and splits by decider, by category and by language. When a restored comment was labelled `should_hide`, it still counts as a false hide (the moderator's restore is taken at its word); the report states how many such conflicts there are.

### Time to hide

The time from the comment being posted to the hide taking effect, for comments FeedBouncer hid in the automatic cohort. The report gives the median (p50), p95 and maximum, per channel (`webhook`, `poll`). Excluded and counted separately: backfill comments, removals that found the comment already hidden (no-ops) and rows with invalid timing. The number of hides that needed a retry, and of negative delivery times (clock differences between the platform and the server), are also reported.

Where the timing records exist, the total is split into segments, which sum to the total:

- `delivery`: from posting to FeedBouncer receiving the comment (for a webhook, the arrival of the delivery; for polling, the time it was fetched).
- `ingestQueue`: from receipt to a worker starting to process it (webhooks only).
- `processing`: from the start of processing to the hide being decided and recorded (rules, classifier, policy model).
- `hideQueue`: from the hide being recorded to a worker picking it up.
- `hideCall`: the call to the platform that hides the comment.
- `queueWait`: `ingestQueue` plus `hideQueue`, shown as one figure.

Segment figures use only the hides that have a complete breakdown (`breakdownN`). Review-mode time is reported three ways: including the human wait, the human wait alone, and excluding the human wait.

### Missed rate

Of the judged comments labelled `should_hide` (the judged version available, in one cohort), the share that was not hidden. It is reported as a count and as a share, split by category and language. Comments where a hide was attempted and failed are counted as missed and listed as "hide attempts that failed".

### Comparison with Meta's built-in moderation

On a dedicated test Page, for automatic-cohort comments labelled should hide, each comment falls into one of four groups: caught by both, by FeedBouncer only, by Meta only, or by neither. For comments labelled should stay, the report counts the false hides of each side. FeedBouncer "catches" a comment when an enforce-mode decision by a rule, classifier or policy chose to hide or remove it. Missed share is `(Meta only + neither) / n` for FeedBouncer and `(FeedBouncer only + neither) / n` for Meta. See "Comparing with Meta's built-in moderation" below for the procedure.

### Cost per 1,000 comments

The model, compute, storage and other costs of moderating 1,000 comments, by component, with the comment mix that produced it. See Cost assumptions.

## Running an evaluation

You need shell access to the FeedBouncer worker and read access to its database. All steps run on one machine.

1. **Export** with `pnpm ops eval-export`. For the organisations (and optionally brands) you want to evaluate and a window of UTC dates (`--to` is exclusive and must not be later than tomorrow):

   ```
   pnpm ops eval-export --org <uuid> [--org <uuid>]... [--brand <uuid>]... --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--label-sample <n>] [--seed <int>] [--out <dir>]
   ```

   The run directory defaults to `tmp/eval/<UTC yyyymmddThhmmssZ>` under the directory you ran `pnpm ops` from (relative `--out` and `--run` paths are resolved from there too) (git-ignored; the default parent is created if missing, an explicit `--out` parent must already exist). `--label-sample <n>` puts a random sample of `n` comments in the label sheet instead of all of them, and `--seed` makes the sample repeatable. The directory (mode 0700) gets `manifest.json`, `items.jsonl` (one pseudonymous record per comment, no text) and `label-sheet.csv` (comment text, blind to outcomes).

2. **Label.** Each labeller copies `label-sheet.csv` to `labels/<name>.csv` in the run directory and fills it in without seeing anyone else's labels. At least two labellers must label every comment; an adjudicator settles ties. See Labelling guide.

3. **Optional, the Meta comparison.** Follow "Comparing with Meta's built-in moderation", then add `meta.csv` and `meta-config.json` to the run directory.

4. **Write `pricing.json`** in the run directory (see Cost assumptions). Without it the report shows the comment mix but no cost.

5. **Report** with `pnpm ops eval-report --run <dir>`. This reads only the run directory, never the database or the network:

   ```
   pnpm ops eval-report --run <dir>
   ```

   It writes `report.json` and `report.md` into the directory and prints the path of `report.md`. Running it again on the same directory gives byte-identical output.

6. **Publish, then delete.** To publish, copy `report.md` only into `docs/evaluation/results/` as `YYYY-MM-DD-<label>.md` (see that folder's README). Then delete the whole run directory: it holds comment text and labels.

### Input file formats

`labels/<name>.csv` (UTF-8, header row required, any extra columns ignored; every `*.csv` in `labels/` is read):

| Column     | Required | Values                                                         |
| ---------- | -------- | -------------------------------------------------------------- |
| `item`     | yes      | The `i_` identifier from the label sheet                       |
| `labeller` | yes      | 1 to 32 characters from `A-Z a-z 0-9 _ -`; one name per person |
| `verdict`  | yes      | `should_hide` or `should_stay`                                 |
| `category` | no       | One of the label categories (see Labelling guide)              |
| `role`     | no       | `labeller` (default) or `adjudicator`                          |

The label sheet's own columns are `item`, `platform`, `text`, `labeller`, `verdict`, `category`, `role`, `note`; the report ignores `platform`, `text` and `note`. A labeller labelling the same comment twice, more than one adjudicator on one comment, an unknown `item`, or fewer than two labellers on a labelled comment is an error. The message names the input (`labels`) and, for an offending comment, its pseudonymous item id; for malformed rows it names the file and row. It never repeats comment text.

`meta.csv` (header required):

| Column         | Required | Values                                 |
| -------------- | -------- | -------------------------------------- |
| `item`         | yes      | The `i_` identifier                    |
| `meta_outcome` | yes      | `hidden`, `visible`, or `not_compared` |
| `note`         | no       | Up to 200 characters                   |

`meta-config.json` (required whenever `meta.csv` is present), describing Meta's setup so the result can be repeated:

```json
{
  "observedOn": "2026-11-02",
  "page": "Dedicated test Page, review mode opted out",
  "profanityFilter": "strong",
  "blockedKeywords": ["example-keyword"],
  "method": "Posted 200 synthetic comments from three test accounts; read Meta's outcome from the Page's moderation view the next day.",
  "notCompared": ["Comments on ads", "Replies to comments"]
}
```

`observedOn` is a `YYYY-MM-DD` date, `page` is a description and not a URL, `profanityFilter` is `off`, `medium` or `strong`, `blockedKeywords` lists the Page's blocked keywords (up to 500), `method` is free text (up to 2,000 characters), and `notCompared` lists what the comparison leaves out.

### Token columns

FeedBouncer records the input, output and cache-read token counts of each classifier and policy model call (`input_tokens`, `output_tokens`, `cache_read_tokens`) so cost can be computed from real usage. Calls from before this recording, and calls that timed out (providers do not report usage for them), have no counts; they are listed as "calls with unknown usage" and make the cost a lower bound. A call that succeeded or failed for good only after earlier attempts failed with a retryable error is also counted as unknown usage: only the final attempt is recorded (`retried`), so the tokens spent on the earlier attempts are missing. Its recorded counts are still priced, and the cost is marked partial.

## Labelling guide

Each labeller sees only the comment text and the platform. For each comment they give a verdict:

- `should_hide`: a comment a page owner would not want to be visible: it is harmful, deceptive or off-limits for the page.
- `should_stay`: a comment that should remain visible, including criticism, complaints and unwelcome but legitimate opinions.

Optionally they give a category for the reason: `scam`, `spam_bot`, `hate`, `competitor`, `profanity`, `question`, `complaint`, `lead`, `positive` or `neutral` (the `LABEL_CATEGORIES`). When the labellers behind the settled verdict disagree on the category, it is recorded as `unspecified`.

Label what the commenter wrote, not what you think the page's rules should be. Rule exemptions are labelled like any other comment: a comment that links to the brand's own domain, or mentions a competitor, is `should_hide` or `should_stay` on its merits. Do not treat an exemption as a reason to label it `should_stay`; the measures show whether the exemption helped or hurt.

Settling rule:

Each comment is labelled by at least two people independently. The majority verdict wins; a tie is settled by one adjudicator label. A tie with no adjudicator is excluded as unresolved.

Every labelled comment needs at least `MIN_LABELS_PER_ITEM` = 2 labellers. The report states the number of labellers, labels per comment, the unresolved count, and the agreement between the first two labellers on each comment as a percentage (with its interval) and as Cohen's kappa. Kappa is not available when it is undefined (no data, or both labellers gave one verdict throughout).

## Comparing with Meta's built-in moderation

Meta's own filters (a profanity filter and blocked keywords) are the baseline. Use a setup that cannot touch real people.

1. Use a dedicated test Page connected to FeedBouncer with review mode **opted out**, so FeedBouncer enforces its decisions.
2. Set Meta's profanity filter and blocked keywords on that Page to the configuration you record in `meta-config.json`.
3. Post a synthetic or anonymised comment set from test accounts, covering the categories you care about. **Never repost real users' comments.**
4. Wait for FeedBouncer to process them, then run the export for the test organisation and label as usual.
5. Record Meta's outcome for every comment in `meta.csv` from the Page's moderation view: `hidden` if Meta hid it, `visible` if not, `not_compared` for anything you cannot read reliably.

Limits of this comparison:

- Meta does not always expose its filter outcome programmatically, so the outcome is read by hand from the moderation view.
- A comment Meta hid from the public may still be visible to the commenter, so what you see depends on the account you look from.
- Meta changes its filters over time; the result holds for the date in `observedOn`.
- Ads and other content managed outside the Page are not covered.

## Cost assumptions

Cost per 1,000 comments is the sum of these components, over all comments in the run, including comments decided by a rule. Rule-decided comments are in the 1,000 because they arrive and are stored like any other. The classifier currently runs even when a rule decided, so rule-decided comments still incur classifier cost; the report shows what share of comments reached the classifier and the policy model, and the calls per comment.

- **Classifier model** and **Policy model**: tokens recorded per call times the price per million tokens for that model. Cache-read tokens use `cacheReadPerMTok` when given, otherwise the input price.
- **Compute**: `usdPerMonth` divided by `commentsPerMonth`, times 1,000.
- **Storage**: the measured bytes per comment times `usdPerGbMonth` times `retentionMonths`. If bytes per comment could not be measured, storage is shown as not measured and the total is "partial".
- **Other**: each line in `other`, as given.

`pricing.json` is yours to write, using your own prices; the figures below are placeholders. Model keys are the identifiers in the export, written `<provider>:<model>`. Every model used in the run needs an entry; a missing one is an error.

```json
{
  "pricedAt": "2026-11-02",
  "currency": "USD",
  "models": {
    "provider:model-name": {
      "inputPerMTok": 1.0,
      "outputPerMTok": 5.0,
      "cacheReadPerMTok": 0.1,
      "note": "list price on the pricedAt date"
    }
  },
  "compute": { "usdPerMonth": 40, "commentsPerMonth": 200000, "note": "one small VM" },
  "storage": { "usdPerGbMonth": 0.02, "retentionMonths": 12 },
  "other": [{ "name": "Graph API", "usdPer1000": 0, "note": "no metered charge" }]
}
```

The Graph API is listed as an `other` line at 0 because Meta does not meter it. Prices change, so each report states the `pricedAt` date and the comment mix it was computed on. Cost varies with the share of comments that reach the models; compare reports with a similar mix.

## Privacy

- `items.jsonl` holds one record per comment: a pseudonymous identifier (`i_` plus 16 hex characters, derived with a per-run secret salt that is not stored), cohort, channel, platform, language, outcomes, timings and model token counts. It has no comment text, author, account or post identifiers.
- `label-sheet.csv` holds the comment text and the platform, nothing about outcomes. It is created with mode 0600. Treat it as private.
- `labels/*.csv`, `meta.csv`, `meta-config.json` and `pricing.json` are yours. `meta.csv` should refer only to synthetic or anonymised test comments.
- `report.json` and `report.md` are aggregate-only: counts, rates, distributions and the settings used. They contain no identifiers, text or links, and the published-report test in this repository enforces that for files in `docs/evaluation/results/`.
- The export reads only the organisations and brands you name. Everything stays in the run directory on your machine; delete the directory when you are done. A self-hosted installation runs the whole procedure locally, with no outside service involved.

## Reading the report

- **Confidence.** Every rate and distribution carries a status. With no data it reads `not enough data (n=0)`, never 0. Below `LOW_CONFIDENCE_N` = 30 comments it is marked low confidence (n<30) and should be read as an indication, not a result.
- **Language splits.** Languages with fewer than `LANGUAGE_MIN_N` = 30 judged comments are merged into `other`.
- **Percentiles** are nearest-rank: the p-th percentile of `n` sorted values is the value at position `ceil(p/100 * n)`. No interpolation.
- **Intervals.** Rates show a 95% Wilson score interval (z = 1.96), which behaves sensibly for small samples and for rates near 0% or 100%.
- **Sections.** The report has these sections: Summary, Dataset and labelling, False-hide rate, Time to hide, Comments missed, the Meta comparison, Cost per 1,000 comments, and Method and limits. Review-mode results are shown separately under their own subheading.
- **Input digests.** The report ends with a SHA-256 digest of each input file, so a reader can check which inputs produced it. Label files are listed by position (`labels/labeller-1.csv`, …), not by name, so labeller names stay out of the report; use neutral file names anyway if the run directory is shared.

## Known limits

- Time to hide excludes comments FeedBouncer saw only through backfill.
- Platform posting times have 1-second resolution, so very short times are approximate.
- Token usage for timed-out model calls is not reported by providers, so model cost is then a lower bound.
- Only the last attempt of a retried model call is recorded, so calls per comment and model cost are lower bounds when retries happened; the report counts those calls as unknown usage.
- Job records are purged after the retention window (`JOB_DEDUP_WINDOW_DAYS`, default 30). Export within that window; hides older than it have a total time but no segment breakdown, and the report says how many.
- Timing and token records exist only from the version that added them onward. Earlier comments have a total time at best, and calls without token counts.
- Edited comments whose hidden version is lost are excluded from the label-based measures (see Judged version).
- A restore in Meta's own interface has no actor in FeedBouncer's records, so it can only be seen when the platform state shows the comment visible.
- A manual hide by a person that did not come from an approved suggestion is not counted as a FeedBouncer hide.
- Restores are counted as false hides even when reviewers labelled the comment `should_hide`; the number of such conflicts is reported.
- Ground truth is only as good as the labellers. Small label pools, shared context between labellers and ambiguous comments all lower agreement; check kappa.
- The Meta comparison covers only the comments on the test Page, is read by hand, and is valid for the date it was observed (see its limits above).
- Results describe the window and the brands exported. Different languages, platforms and comment mixes give different numbers.
