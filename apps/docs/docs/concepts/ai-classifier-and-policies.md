---
title: AI classifier and policies
description: The two optional model-based checks that run when no rule decided a comment, the providers they use and what text they send.
status: stable
---

Two optional checks run only when no rule decided the comment. They are independent of each other, and neither can override a rule, including an allow.

## Classifier

The <Term id="classifier">classifier</Term> scores each new comment with a language model. It gives every <Term id="category">category</Term> an independent score from 0.0 to 1.0, and applies per-brand <Term id="threshold">thresholds</Term>. The categories are spam, scam or phishing, harassment or abuse, hate speech, sexual content, profanity and self-promotion.

By default a category triggers at 0.80. Hate speech and scam or phishing hide the comment, and the other categories flag it for review. An admin can set a threshold and an action (allow, flag, hide or delete) per category. A brand with no settings uses these defaults. When several categories trigger, the most severe action wins.

Comments with too little text to judge, or in a language the model is not trusted for, are never hidden or deleted on a low-confidence score. They are flagged for review instead. A provider failure leaves the comment unchanged and marks it "Not classified".

## Policies

A <Term id="policy">policy</Term> is one sentence that says what you do not want to see, with an action: flag for review, hide or delete. For each comment, the model answers `clear_match`, `possible_match` or `no_match` for every enabled policy. A clear match applies the action. A possible match only flags the comment for review.

Editing a policy creates a revision, and every decision names the revision that made it. Policies start disabled. You can preview one against recent comments before enabling it.

## Providers

The model provider is configurable. No single vendor is required: the classifier supports `openai`, `google` and `openai_compatible` endpoints, including one you host yourself. Without a provider, nothing is classified and nothing else changes. Policies use their own provider setting, or reuse the classifier's. The operator sets the provider for the deployment, and brands cannot choose another.

## What is sent to the provider

For the classifier, the provider receives the comment text, truncated to 4,000 characters, with a fixed instruction. For policies, it also receives the text of the brand's enabled policies. Author names and ids, handles, links to the comment and post, and brand details are never sent. Comment text is treated as data, never as an instruction, and the model's answer is validated against a fixed schema. Use a self-hosted `openai_compatible` endpoint if comment text must not leave your infrastructure.

The model's free text and the prompt are not stored. A decision stores the scores, the language, the provider and model, the prompt version and a readable reason.

## During review mode

In <Term id="review-mode">review mode</Term>, a hide or remove verdict from either check becomes a suggestion until a person approves it.

For limits, environment variables and the evaluation script, see the operator documents in the repository: <RepoLink path="docs/moderation/classifier.md">classifier</RepoLink> and <RepoLink path="docs/moderation/policies.md">policies</RepoLink>.
