---
title: Setup wizard
description: Connect your accounts, pick how comments are handled and see a first report, in four steps.
status: stable
---

The first time an owner or admin opens a new organization, FeedBouncer starts a short setup wizard. It takes you from nothing connected to a working setup in four steps. Only owners and admins can use it.

Each step is saved when you continue, so you can close the browser and come back to the same place. You can go back to an earlier step and change it.

## The four steps

### 1. Connect accounts

Pick a brand, or create one if you have none, then connect one or more accounts. Each account shows whether it is connected, paused, couldn't connect, or whether its authorization expired or was revoked. If something went wrong, use **Try again**.

You need at least one working account to continue. You can add more later under **Connections**.

### 2. Pick defaults

For each kind of comment, choose what FeedBouncer does when it spots one:

- **Hide it automatically** hides the comment on the platform. You can unhide it later.
- **Flag it for a person to review** keeps the comment visible and puts it in front of your team.
- **Leave it visible** does nothing to the comment.

The kinds are spam, scam or phishing, harassment or abuse, hate speech, sexual content, profanity and self-promotion. Safe choices are preselected. Delete is not offered here because it can't be undone. If your classifier settings already remove a kind of comment, the wizard says so and links to those settings instead of asking again.

These choices use the <Term id="classifier">classifier</Term>. If the classifier is not switched on for your server, you can still set them, and they start working once it is.

### 3. Review mode

Decide how cautious FeedBouncer should be when it first starts acting on comments.

- **Review first (recommended).** For the first 7 days after each account connects, FeedBouncer only suggests actions. Flagged comments stay visible until someone approves the suggestion in the review queue, and after that it acts on the choices from the previous step.
- **Act automatically.** FeedBouncer hides comments right away using the choices from the previous step. Every action is logged with its reason and can be undone from Hidden today.

Choosing **Act automatically** asks you to confirm that you understand a mistake can affect real people before you notice. If review has already ended on your connected accounts, **Review first** is not available. See [Review mode](../concepts/review-mode.md) for how suggestions work.

### 4. First report

The report shows your chosen defaults and review mode, and for each connected account the number of comments, how many were imported and checked, how many were hidden, how many are awaiting review, and the top categories. With several accounts you get one card per account and totals across them.

A large backlog does not hold you up. Imported comments are counted as they arrive and the numbers refresh on their own. Imported history is shown for context, but it is not checked. New comments are checked within about a minute, and results appear in the report and in the weekly report on Monday. Until then you may see "No comments yet".

Select **Finish** to close the wizard.

## Skip setup for now

**Skip setup for now** dismisses the whole wizard. Nothing is changed by skipping. You can configure everything yourself:

- Accounts: **Connections**
- Category actions: **Classifier settings**
- Review mode: **Review mode**, on the brand
- Reports: **Reports**

## Run setup again

From the organization overview, **Run setup again** takes you through the steps from the start, with your current values filled in. It changes nothing until you save a step. Your accounts and settings stay as they are until you change them.

## Organizations that are already set up

An organization that already has working connections and settings is not sent through the wizard. The organization overview offers **Start setup** or **Continue setup** if you want it.

## Self-hosted

The wizard is the same code in self-hosted and cloud deployments, and it needs no outbound access to run. If your server has no platform configured, for example because it cannot reach the platforms or you have not set up an app yet, the connect step shows that there are no platforms configured and links to the [self-hosting guide](../concepts/self-hosting.md). You can skip setup and come back after you have configured a platform.
