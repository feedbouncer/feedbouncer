---
title: Free scan of your ad comments
description: What the free scan reads, what it keeps, how long it keeps it and how to delete it.
status: stable
---

The free scan checks the comments on your recent Facebook and Instagram ads and shows how many look harmful, such as spam, scams or abuse. It runs once, on request. It does not moderate anything.

## What it reads

You connect with Facebook and choose one Page. The scan reads the comments on that Page's ads. It asks for these permissions:

| Permission                  | Required | Why                                              |
| --------------------------- | -------- | ------------------------------------------------ |
| `pages_show_list`           | Yes      | To list your Pages so you can pick one           |
| `pages_read_engagement`     | Yes      | To read the ad posts and their comments          |
| `pages_read_user_content`   | Yes      | To read comments written by users                |
| `ads_read`                  | Yes      | To find the Page's recent ads                    |
| `instagram_basic`           | No       | To find the Instagram account linked to the Page |
| `instagram_manage_comments` | No       | To read comments on Instagram ads                |

If you do not grant the optional permissions, the scan covers Facebook ads only. If you do not grant a required one, the scan does not start.

## What it never does

The scan is read-only. It never hides, deletes or replies to a comment, and it never posts anything. It sends only read requests to Meta.

## How much it reads

- The last 25 ads that ran in the last 30 days.
- Up to 2,000 comments in total, and up to 400 per ad. Reading stops at whichever limit comes first.
- A result is marked as unreliable when fewer than 20 comments were read, because a percentage from a small sample means little.

## How comments are judged

Each comment is classified into the categories shown on the result page. A comment the classifier cannot decide on is reported as uncertain, not counted as harmful. The classifier makes mistakes in both directions, so treat the numbers as an estimate. Read the examples before you act on them.

## What is stored

- The result: counts per category and per ad.
- Up to 9 example comments, shown masked, with the commenter's name abbreviated.
- Individual comments are not stored. Only the counts and those examples are kept.
- Your Facebook access token is deleted when the scan finishes or fails.

## Deleting your data

Everything from a scan is deleted after at most 30 days. You can delete it sooner with **Delete my data** on the result page, which removes it immediately.

## Sharing

A result is private to you until you choose to share it. Sharing is opt-in and creates a link that you can revoke at any time. A shared result hides the names of your ads. Revoking the link stops it working at once.

## Limits per day

To keep the tool available for everyone, each day allows:

- 3 scans per visitor
- 5 scans per IP address
- 5 scans per Facebook user
- 3 scans per Page

Starting the Facebook connection is limited to 10 times per hour per IP address. If you reach a limit, try again the next day.

## Self-hosting

The tool is off by default on self-hosted instances. To turn it on, see the <RepoLink path="docs/self-hosting/meta-app.md">Meta app guide</RepoLink>.
