# Verifying the Meta app guide

This page records what is still unchecked in [meta-app.md](meta-app.md). Each section there that depends on Meta starts with a dated "not yet verified" note. The checklists below list every screenshot and every noted section, so nothing is skipped.

## Scope

Nothing in the guide has been verified against a live Meta dashboard yet. Three pieces of follow-up work remain: real screenshots, a live check of permission names and dashboard wording against Meta's documentation, and a two-reader dry run. All three are manual and need a maintainer with a Meta developer account.

## Screenshots

Rules for every image:

- Use a throwaway app named `FeedBouncer Guide Demo` on a throwaway Page. Never use a real brand's app or Page.
- Use the English UI.
- Cover sensitive areas with opaque boxes, following the "What to redact" list in [Keep your app secret and tokens safe](meta-app.md#keep-your-app-secret-and-tokens-safe). Blur and semi-transparent masks are not enough.
- Strip PNG metadata chunks: `tEXt`, `iTXt`, `zTXt`, `eXIf` and `tIME`.
- Keep each image at most 1600 px wide and at most 500 KB.
- Write alt text of at least 30 characters that describes the screen and the highlighted control.
- Save each image as `docs/self-hosting/images/meta-app/<slot-name-kebab>.png`.
- A second maintainer reviews every image at full size before merge.

The pull request that adds images also replaces the no-images assertion in `scripts/ci/self-host-docs.test.mjs` with a check of PNG chunks, size and alt text.

Slots, one per marker in the guide:

- [ ] `developers home, get started`
- [ ] `create app, app type or use case`
- [ ] `app dashboard, add products`
- [ ] `app dashboard, webhooks product added`
- [ ] `app settings, basic, app id`
- [ ] `app settings, basic, app secret`
- [ ] `app settings, advanced, require app secret`
- [ ] `facebook login for business, redirect uris`
- [ ] `webhooks, page callback url and verify token`
- [ ] `webhooks, page feed field subscribed`
- [ ] `feedbouncer connections, connect facebook`
- [ ] `feedbouncer page picker, connected`
- [ ] `app dashboard, instagram api setup`
- [ ] `facebook login for business, instagram redirect uri`
- [ ] `webhooks, instagram callback and comments field`
- [ ] `feedbouncer connections, connect instagram`
- [ ] `feedbouncer suggestion for test comment`
- [ ] `feedbouncer hidden today with rule reason`

## Permissions and policy check

For each row in the guide's permissions table, confirm the permission name, the reason and the access level against Meta's [Permissions Reference](https://developers.facebook.com/docs/permissions) and [Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels) pages.

Also resolve the two open questions: whether Standard Access is enough when you moderate only assets you own, and whether live Instagram comment webhooks require Advanced Access plus Business Verification. Then update Part 7 and the App Review section of the guide to match.

## Two-reader dry run

Two readers who have not seen the guide and have never created a Meta app follow it unaided, each on their own throwaway app and Page. An observer takes notes. Every sticking point is fixed in the guide, then re-checked. Record the results under Dry-run record.

## Removing a "not yet verified" note

A note is removed only when all of the following hold:

1. A maintainer followed that section on a live dashboard.
2. Every label, menu path and permission name matches or has been corrected.
3. The section's screenshots are merged and redaction-reviewed.
4. Both dry-run readers got through that section, or their sticking point was fixed and re-checked.
5. In the same commit, the section's Status row becomes `Verified YYYY-MM-DD` and its box below is ticked.

If a section turns out to be wrong, correct the text and re-date the note instead of removing it.

Noted sections:

- [ ] Meta terms used in this guide
- [ ] Before you start
- [ ] Part 1: Create your Meta developer account and app
- [ ] Part 2: Add the products FeedBouncer needs
- [ ] Part 3: Collect your app credentials
- [ ] Part 5: Configure the webhook
- [ ] Part 6: Connect your Facebook Page
- [ ] Part 7: Connect Instagram (optional)
- [ ] Configuration map
- [ ] Permissions and why
- [ ] Development mode and Live mode
- [ ] Tokens: how long they last
- [ ] Test it end to end
- [ ] Troubleshooting
- [ ] Keep your app secret and tokens safe
- [ ] Rotate secrets and tokens
- [ ] When you need App Review or Business Verification
- [ ] More Pages and accounts

## Dry-run record

Keep readers anonymous (Reader A, Reader B). Do not record names, IDs or screenshots.

| Reader | Date | Finished? | Where they got stuck | Fix (commit) |
| ------ | ---- | --------- | -------------------- | ------------ |
