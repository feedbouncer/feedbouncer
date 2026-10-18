# FeedBouncer private beta: partner guide

This guide is for design partners using FeedBouncer during the private beta.
FeedBouncer watches comments on your Facebook Page and Instagram account, applies the rules
you set, and records everything it does so you can check it and undo it.

The beta runs on a Meta app that has not passed App Review yet (see
[Moving to production](#moving-to-production)). That is why a few extra steps
and limits apply to you.

## Before you start: accept the tester invitation

While the Meta app is in development mode, only people with a role on the app
can connect a Page. Your operator adds you as a **Tester**. You must accept that
invitation before you connect.

1. Tell your operator the email of the Facebook account that manages your Page.
2. The operator adds that account as a Tester in the Meta dashboard. Facebook
   sends you a notification.
3. Open [developers.facebook.com/requests](https://developers.facebook.com/requests)
   while signed in to that Facebook account and accept the FeedBouncer invitation.
4. Ask your operator to confirm that the app's Roles page now shows you as
   accepted. A pending invitation is not enough.
5. Sign up to FeedBouncer with the email your operator invited, then connect.

If you skip the acceptance, Facebook shows this on its own screen:

> TBD (Task 9 Step 2)

and FeedBouncer shows this when you land back on it:

> Facebook didn't finish connecting. During the private beta, your Facebook
> account must have accepted the FeedBouncer tester invitation
> (developers.facebook.com/requests) before you connect. Accept it, then
> connect again.

The error code behind that message is `provider_error`. It is also what you see
for any Facebook failure that is not you cancelling. If you cancel the
permission screen instead, FeedBouncer says nothing was connected and you can
start again. See [Troubleshooting in the Facebook connector doc](../connectors/facebook.md#troubleshooting).

## Connect your Page or Instagram account

Only an organization owner or admin can connect, reconnect or disconnect. Start
from the brand's Connections page.

- You need **full control** of the Facebook Page, or Facebook access with the
  **Moderate** task ("full control or Moderate access"). The Page picker shows
  other Pages greyed out.
- If you lack it, FeedBouncer says (`insufficient_page_role`): You need full control of this Page, or Facebook access with the Moderate task. Ask a Page admin to grant it in Meta Business Suite → Settings → Page access, then connect again.
- Instagram must be a Business or Creator account linked to a Facebook Page.
  Pages with no linked account are greyed out.
- FeedBouncer asks for every permission it lists on the Facebook screen. If you
  turn any off, nothing is connected. Choose Edit access and turn them all on.
- Private replies need the Messaging task as well. Without it, everything else
  works and private replies are marked unavailable.

Details: [Facebook connector](../connectors/facebook.md#permissions-requested-and-why) and
[Instagram connector](../connectors/instagram.md#prerequisites).

## What FeedBouncer can do

| Action          | Facebook | Instagram     | Undo                                                     |
| --------------- | -------- | ------------- | -------------------------------------------------------- |
| Hide            | Yes      | Yes           | Unhide, from the Action log or Hidden today              |
| Unhide          | Yes      | Yes           | Hide it again                                            |
| Delete          | Yes      | Yes           | None. Deleted comments cannot be restored                |
| Ban author      | Yes      | Not supported | Unban author, from the Action log                        |
| Unban author    | Yes      | Not supported | None                                                     |
| Public reply    | Yes      | Yes           | None. You can delete the reply on the platform           |
| Private reply   | Yes      | Yes           | None. A sent message cannot be taken back                |
| Flag for review | Yes      | Yes           | Dismiss the review item. Nothing changes on the platform |

Instagram has no ban API, so ban and unban are not offered there. A private
reply is allowed once per comment, within 7 days of the comment, and Instagram
does not allow replies to hidden comments. See
[moderation actions](../moderation/actions.md).

## See what FeedBouncer did and why

- The brand's **Action log** lists every step, with the rule or classifier that
  caused it, the outcome, and an undo for hides, bans and flags. You can filter
  it by rule, outcome and step. See [actions.md](../moderation/actions.md#undo).
- **Hidden today** lists everything hidden since midnight in the brand's time
  zone, with who or what hid it and why, and an **Unhide** button. See
  [undo-log.md](../moderation/undo-log.md).
- An undone step is an override: automation will not apply it to that comment
  again. If an undo fails, the log shows "Undo failed. Try again." with a
  **Retry undo** button.
- Rule activity and the review queue are described in
  [rules.md](../moderation/rules.md) and [review-mode.md](../moderation/review-mode.md).

## When FeedBouncer needs you to reconnect

A connection shows **Needs reconnect** when its status is `reconnect_required`.
This happens when Facebook rejects the Page token (expired, revoked, you changed
your password), you lost your role on the Page, or you removed the app.

- Moderation is paused for that connection. New comments are still accepted,
  and the waiting work is replayed after you reconnect, so nothing is lost.
- Organization owners get one email when it happens.
- An owner or admin reconnects from the Connections page, using a person who
  still manages the Page, and grants all the permissions again.
- Tokens are not deleted until you disconnect. Disconnecting removes the stored
  token and unsubscribes the Page; stored comments and the action history stay.

See [Troubleshooting](../connectors/facebook.md#troubleshooting).

## Delays and limits

- **Rate limiting.** Meta throttles per app and per Page. When it does, the
  connection shows "Processing delayed" and new comments are queued and checked
  later. None are dropped. A lag of several minutes shows as "Processing delayed
  by about N minutes".
- **Development mode.** Until the app is approved, comments from people with no
  role on the app may not be delivered as webhooks at all, and private replies
  only reach people with a role on the app. Test with comments written by the
  app's admins, developers or testers. A comment that does not arrive in this
  situation is not a FeedBouncer fault. See
  [Instagram: development mode](../connectors/instagram.md#app-review-business-verification-and-development-mode).
- **Classifier languages.** The classifier is trusted for these languages:
  `en,es,pt,fr,de,it,nl`. For a comment in another language, or one whose
  language it cannot determine, a Hide or Delete is downgraded to flagged for
  review instead of acting. The same goes for comments with too little text,
  such as emoji only. See [classifier.md](../moderation/classifier.md#low-confidence-input).

## Known limitations

- Comments imported when you connect (the last 30 days) are history. They are
  not auto-actioned unless a rule is set to include historical items, and
  nothing older than that window is imported. See [backfill.md](../connectors/backfill.md).
- There is no scheduled purge of stored comments. They are kept after you
  disconnect until a deletion request is carried out.
- There is no report action: FeedBouncer cannot report a comment to Meta.
- Comments on ads are handled by the Meta Ads connector and may appear later.
- Hiding or deleting a comment in the Facebook or Instagram app is not
  reported to FeedBouncer. It catches up the next time someone acts on that
  comment.
- Instagram live comments are ignored, and the account's own comments cannot be
  hidden.
- Meta's deauthorize and data-deletion callbacks are not implemented. Deletion
  goes through the operator.
- Several Meta behaviours have not been verified against a live app. The
  [Facebook](../connectors/facebook.md#known-limitations) and
  [Instagram](../connectors/instagram.md#known-instagram-limits) docs list them.

## Moving to production

Once Meta approves the app through App Review, the tester restriction goes
away. You may need to reconnect once so that your connection is authorized under
the approved app. Your operator will tell you when that happens.

## Leaving the beta and deleting your data

Ask your operator, from the email of an organization owner, to delete your
organization. The operator follows [the data deletion procedure](../operations/data-deletion.md):
target 5 business days, 30 days at most. You will also be asked to remove
FeedBouncer under Facebook Business Integrations.

## Contact

- Support: the support address your operator gave you. It is also shown in the
  beta notice inside the app.
- Feedback: send the weekly answers from [the feedback form](feedback-form.md).
  The link to the form your operator set up is also in the beta notice inside the
  app.
