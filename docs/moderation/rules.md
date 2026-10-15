# Moderation rules

Rules decide what happens to a comment when it arrives or is edited. They are
managed per brand under **Rules** in the web app and evaluated by the
`rule_evaluate` job, so evaluation never slows down ingestion.

## Evaluation order

1. Trusted-author rules are checked first, whatever their position. An allow
   from a trusted author skips every rule below it.
2. The remaining enabled rules run in the order shown in the list.
3. The first **enforcing** match decides the outcome and stops evaluation.
4. A rule in **dry run** records what it would have done and evaluation
   continues.

A rule that can never fire (an earlier rule always matches first, or its list
is empty) is flagged in the list.

## Rule kinds

- **Keywords:** case-insensitive. Text is normalised first: case, Latin, Greek
  and Cyrillic accents, zero-width characters and full-width forms. Leetspeak
  is not normalised. Matching is whole-word by default or "contains"; scripts
  written without spaces always use substring matching.
- **Regular expressions:** RE2 syntax, so no backreferences or look-around.
  Patterns run on normalised text and each rule has a 50 ms budget. A rule
  that exceeds it is skipped for that comment, logged, and evaluation goes on.
  Invalid patterns are rejected on save with the offending pattern's position.
- **Links:** matches the domains of links in the comment, including
  subdomains and links written without a scheme (a known public suffix is
  required). E-mail addresses are ignored, credentials in the URL are handled,
  and international domains are converted to punycode. Lookalikes are detected
  heuristically: hosts mixing scripts and a small table of look-alike letters.
  A domain written entirely in a lookalike script is **not** detected.
  Shortened links are matched by their domain and never followed.
- **Emoji:** a list of emoji and/or a maximum count. Multi-codepoint emoji
  count once.
- **Authors:** block, allow or trusted lists. An author ID is matched before a
  handle, so renames do not bypass the list.
- **Competitors:** names, @handles and domains, matched by one rule with a
  single action. The evidence of a decision records which of the three matched.

## Own domains

Links to a brand's own domains (and their subdomains) are never treated as
spam by link rules unless the rule turns that exemption off. They are managed
under **Own domains**.

## Actions and fallback

Actions are Allow, Flag for review, Hide and Delete. Allow and Flag record the
decision only. Hide and Delete ask the platform to act through the normal
moderation request, so they are deduplicated and rate limited like a manual
action.

If the platform cannot perform the action (unsupported, not eligible, the
connection needs reconnecting, permission revoked, or rate limiting that is
still retrying), the comment is **flagged for review** instead and the
decision shows why. If a deferred action later succeeds, a further decision
records that.

## Idempotency and scope

- There is one evaluation per comment, per version of its text. Redelivered
  webhooks and ad polls that do not change the text evaluate nothing.
- Edited comments are re-evaluated; the earlier evaluation stays in history.
- Backfilled historical comments are not evaluated.
- Comments posted by the brand's own account are never evaluated.

## Limits

200 rules per brand, 5,000 terms or author entries per rule, 20 patterns per
rule, 1,000 domains per rule, 50 own domains per brand.

## Data and privacy

Decisions store the rule, the terms or hosts that matched and a readable
reason, never the comment text. Logs carry identifiers only.

## Deleting a rule

A rule cited by a past decision cannot be removed without losing the audit
trail, so deleting a rule archives it: it disappears from the list while
earlier decisions still show its name.
