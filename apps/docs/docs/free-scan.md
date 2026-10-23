---
title: Free scan of your ad comments
description: What the free scan reads, what it keeps, how long it keeps it and how to delete it.
status: stable
---

The free scan checks the comments on your recent Facebook and Instagram ads and shows how many look like scams (including phishing) or spam. It runs once, on request. It does not moderate anything.

## What it reads

You connect with Facebook and choose one Page. The scan reads the comments on that Page's ads. It asks for these permissions:

| Permission                  | Required | Why                                              |
| --------------------------- | -------- | ------------------------------------------------ |
| `pages_show_list`           | Yes      | To list your Pages so you can pick one           |
| `pages_read_engagement`     | Yes      | To read the ad posts and their comments          |
| `pages_read_user_content`   | Yes      | To read comments written by users                |
| `ads_read`                  | Yes      | To find the Page's recent ads                    |
| `instagram_basic`           | No       | To find the Instagram account linked to the Page |
| `instagram_manage_comments` | No       | To read comments on Instagram ads (see below)    |

If you do not grant the optional permissions, the scan covers Facebook ads only. If you do not grant a required one, the scan does not start.

Meta requires `instagram_manage_comments` to read comments on Instagram. The scan asks for it only for that reason and never uses it to hide, delete or reply to a comment.

## What it never does

The scan is read-only. It never hides, deletes or replies to a comment, and it never posts anything to your Page or changes your ads. While it reads your ads and comments it sends only read (GET) requests to Meta. The one exception is signing in: exchanging the Facebook sign-in code for an access token sends POST requests to Meta's token endpoint. Those requests change nothing on your Page or ads.

## How much it reads

- The 25 most recent ad posts. An ad post counts if one of its ads is active, however old, or is inactive and was updated in the last 30 days.
- Only comments from the last 30 days.
- Up to 2,000 comments in total, and up to 400 per ad. Reading stops at whichever limit comes first.
- A result is marked as unreliable when fewer than 20 comments could be classified, because a percentage from a small sample means little. Comments the classifier could not assess, such as emoji-only ones, do not count toward the 20.
- A scan has a time limit. If it runs out of time, the result is based on the comments assessed so far and says so. If too few were assessed, the scan fails and you can try again.

## How comments are judged

Each comment is classified into the categories shown on the result page. A comment the classifier cannot decide on is reported as uncertain, not counted as harmful. The classifier makes mistakes in both directions, so treat the numbers as an estimate. Read the examples before you act on them.

## What is stored

- The result: counts per category and per ad.
- Up to 9 example comments, stored as written but cut to 280 characters. Only the commenter's name is abbreviated, to initials.
- Individual comments are not stored. Only the counts and those examples are kept.
- Your Facebook access token is deleted when the scan finishes or fails.

## Deleting your data

Everything from a scan is deleted after at most 30 days. You can delete it sooner. **Delete this result** on the result page removes that scan immediately. **Delete my data** on the free scan landing page (`/scan`) removes everything we hold about you immediately.

## Sharing

A result is private to you until you choose to share it. Sharing is opt-in and creates a link that you can revoke at any time. A shared result hides the names of your ads. It still includes the example comments, with commenters' names cut to initials. Revoking the link stops it working at once.

## Limits per day

To keep the tool available for everyone, each day allows:

- 3 scans per visitor
- 5 scans per IP address
- 5 scans per Facebook user
- 3 scans per Page

Starting the Facebook connection is limited to 10 times per hour per IP address. If you reach a limit, try again the next day.

## Self-hosting

The tool is off by default on self-hosted instances. To turn it on, see the <RepoLink path="docs/self-hosting/meta-app.md">Meta app guide</RepoLink>.
