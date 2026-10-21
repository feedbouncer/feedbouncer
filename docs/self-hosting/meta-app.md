# Bring your own Meta app

A step-by-step guide to creating a Meta app you own and connecting it to your FeedBouncer instance, so a comment on your Facebook Page is received and moderated.

## About this guide

Written against: Meta App Dashboard as of 2026-10-21, Graph API v26.0

This guide covers Facebook Pages, and Instagram professional accounts as an optional extra. It does not cover YouTube, X or TikTok. For Meta Ads, see [meta-ads.md](../connectors/meta-ads.md).

Labels and menu paths come from FeedBouncer's connector docs and Meta's documentation. Meta changes its dashboard often, so some labels may differ from what you see. Each step ends with a verification line that says when it was last checked on a live dashboard. If the dashboard uses another language, labels will differ from the English ones used here.

The guide is refreshed every 90 days and whenever the default Graph API version in FeedBouncer changes. Issues and corrections are welcome.

Placeholders: `<APP_ID>`, `<APP_SECRET>`, `<VERIFY_TOKEN>` and `https://feedbouncer.example.com` stand for your own values.

## Before you start

You need:

- A Facebook account and a Facebook Page that you administer.
- Optionally, an Instagram **professional** (Business or Creator) account linked to that Page. See the prerequisites at the top of [Part 7](#part-7-connect-instagram-optional).
- A running FeedBouncer instance. Installing it is covered in [Local stack with Docker Compose](../../README.md#local-stack-with-docker-compose).
- A **public HTTPS URL** for that instance, with a publicly trusted certificate. Meta will not deliver webhooks to `localhost` or to a self-signed certificate.

For testing you can put any HTTPS tunnel in front of your instance, for example Cloudflare Tunnel or ngrok (neither is endorsed). If the tunnel URL changes, update `PUBLIC_WEB_URL` and both URLs you give Meta.

The order of this guide differs from what you might expect: Meta checks your webhook URL while you save it, so FeedBouncer must already be configured (Parts 3 and 4) before you set up the webhook (Part 5).

## Part 1: Create your Meta developer account and app

### Step 1: Register as a Meta developer

Open [developers.facebook.com](https://developers.facebook.com/) and log in with the Facebook account that administers your Page. Choose **Get Started** and complete the registration prompts. If Meta asks you to verify your account, follow its prompts; this is Meta's own check and not specific to FeedBouncer.

Last verified: not yet checked on a live dashboard

### Step 2: Create a Business app

In the App Dashboard choose **Create app**. Give it any name that you recognise, such as `FeedBouncer`, and enter a contact email. When asked for the app type or use case, pick the one that lets you add **Facebook Login for Business** and **Webhooks**, which is the **Business** app type. You should land on the new app's dashboard.

Last verified: not yet checked on a live dashboard

## Part 2: Add the products FeedBouncer needs

### Step 3: Add Facebook Login for Business

On the app dashboard, find **Add products** (or **Products** in the left menu) and add **Facebook Login for Business**. FeedBouncer uses it so you can click **Connect** and approve the permissions listed under [Permissions and why](#permissions-and-why). The product's Settings page is where you add the redirect URI in Step 12.

Last verified: not yet checked on a live dashboard

### Step 4: Add Webhooks

Add the **Webhooks** product the same way. Meta uses it to tell your instance about new comments. Do not subscribe to anything yet, because Meta verifies your callback URL while you save it and FeedBouncer is not configured until Part 4.

Last verified: not yet checked on a live dashboard

## Part 3: Collect your app credentials

### Step 5: Copy the App ID

Open **App settings**, then **Basic**. The **App ID** is shown at the top. It is a number, and it is not secret, but do not post it in public. You will enter it as `FACEBOOK_APP_ID` in Part 4. Keep this page open for the next step.

Last verified: not yet checked on a live dashboard

### Step 6: Copy the App Secret

On the same **Basic** page, next to **App secret**, choose **Show** and enter your password if asked. Copy the value into a password manager or a secret file straight away. The app secret is a secret: never paste it in an issue, chat or screenshot, and hide it again when you are done. See [Keep your app secret and tokens safe](#keep-your-app-secret-and-tokens-safe).

Last verified: not yet checked on a live dashboard

### Step 7: Generate a verify token

The verify token is a random string that you invent. Meta sends it back during the handshake so that FeedBouncer knows the request is genuine. It must be at least 20 characters. Generate one on a machine you trust and keep it for Steps 9 and 13:

```bash
openssl rand -hex 32
```

Last verified: not yet checked on a live dashboard

### Step 8: Turn on Require App Secret

In **App settings**, then **Advanced**, make sure **Require App Secret** is on. FeedBouncer signs every Graph API call with `appsecret_proof`, so this setting is safe to enable and it stops anyone with only a stolen token from calling the API.

Last verified: not yet checked on a live dashboard

## Part 4: Configure FeedBouncer

### Step 9: Set the Meta settings

Add these settings to the `.env` of your instance and restrict the file with `chmod 600 .env`, because it now holds secrets:

```bash
FACEBOOK_APP_ID=<APP_ID>
FACEBOOK_APP_SECRET=<APP_SECRET>
FACEBOOK_WEBHOOK_VERIFY_TOKEN=<VERIFY_TOKEN>
```

These variables store real Page tokens, so replace the `dev-example` value of `FB_ENCRYPTION_KEYS` from `.env.example` with a production key first; [secrets.md](../operations/secrets.md) shows how to generate one. Compose does not read `PUBLIC_WEB_URL` from `.env`; you set it in the next step. Leave `FACEBOOK_GRAPH_API_VERSION` at its default. Docker Compose passes only these plain variables to the containers. To use the `_FILE` variants instead, mount the files from `compose.override.yaml` as shown in [secrets.md](../operations/secrets.md).

Last verified: not yet checked on a live dashboard

### Step 10: Override PUBLIC_WEB_URL for Docker Compose

`compose.yaml` sets `PUBLIC_WEB_URL` to `http://localhost:${WEB_HOST_PORT:-3000}`. Copy `compose.override.example.yaml` to `compose.override.yaml` (git-ignored) and set the public origin for both the API and the worker:

```yaml
services:
  api:
    environment:
      PUBLIC_WEB_URL: https://feedbouncer.example.com
  worker:
    environment:
      PUBLIC_WEB_URL: https://feedbouncer.example.com
```

Check it with `docker compose config | grep PUBLIC_WEB_URL`: both services must show your public origin.

Last verified: not yet checked on a live dashboard

### Step 11: Restart and prove the webhook route is live

Restart the stack with `docker compose up -d`. The webhook route exists only when the Facebook settings are present. Send a handshake with a deliberately wrong token, so nothing secret is typed. A working route answers `403`; `404` means the route does not exist, so recheck Step 9:

```bash
curl -i "https://feedbouncer.example.com/api/v1/webhooks/facebook?hub.mode=subscribe&hub.challenge=test123&hub.verify_token=wrong"
```

Last verified: not yet checked on a live dashboard

## Part 5: Configure the webhook

### Step 12: Add the OAuth redirect URI

Open **Facebook Login for Business**, then **Settings**, and add this under **Valid OAuth Redirect URIs**: `https://feedbouncer.example.com/api/v1/oauth/facebook/callback`. It must match your `PUBLIC_WEB_URL` exactly. Save the changes. Without it, clicking Connect later fails with a redirect error.

Last verified: not yet checked on a live dashboard

### Step 13: Register the callback URL

Open **Webhooks**, choose the **Page** object, then **Subscribe to this object**. Enter the callback URL `https://feedbouncer.example.com/api/v1/webhooks/facebook` and your verify token from Step 7, then choose **Verify and save**. Meta calls your instance immediately, which is why Part 4 comes first. If it fails, see the troubleshooting entry.

Last verified: not yet checked on a live dashboard

### Step 14: Subscribe to the feed field

In the list of Page fields, find `feed` and choose **Subscribe**. This only registers the app for the field. FeedBouncer subscribes each Page to your app by itself when you connect it, so you do not subscribe Pages by hand.

Last verified: not yet checked on a live dashboard

## Part 6: Connect your Facebook Page

### Step 15: Connect Facebook in FeedBouncer

In FeedBouncer open your brand, then **Connections**, and choose **Connect Facebook**. Facebook asks you to approve the permissions listed under [Permissions and why](#permissions-and-why). Leave every permission ticked, because FeedBouncer needs all of them and aborts the connection if one is declined. Do not paste any token from the Graph API Explorer; FeedBouncer obtains its own.

Last verified: not yet checked on a live dashboard

### Step 16: Choose the Page

Back in FeedBouncer, pick your Page in the Page picker. The connection should then show as connected. FeedBouncer stores its access token encrypted with `FB_ENCRYPTION_KEYS` and subscribes the Page to the `feed` field. Continue with [Test it end to end](#test-it-end-to-end), or with Part 7 for Instagram.

Last verified: not yet checked on a live dashboard

## Part 7: Connect Instagram (optional)

Read this before you change anything. Instagram needs more than Facebook:

- The account must be an Instagram **professional account** (Business or Creator). Personal accounts cannot work. See Meta's help on [switching to a professional account](https://help.instagram.com/) and on linking it to a Page.
- It must be **linked** to the Facebook Page you connected in Part 6.
- Meta's documentation says live Instagram comment webhooks are sent only to apps with **Advanced Access** to the permissions, which requires App Review, and for Business apps the business linked to the Page must be verified. If you only have Standard Access, Instagram comments may not reach FeedBouncer even for your own account. See [When you need App Review or Business Verification](#when-you-need-app-review-or-business-verification). Facebook Pages are not affected.

### Step 17: Add the Instagram product

In the App Dashboard add the **Instagram** product and choose **API setup with Facebook Login**, not the option that uses Instagram Login. FeedBouncer only works with the Facebook Login flavour, because it reaches the account through its linked Page.

Last verified: not yet checked on a live dashboard

### Step 18: Add the Instagram redirect URI

Under **Facebook Login for Business**, **Settings**, add a second **Valid OAuth Redirect URI**: `https://feedbouncer.example.com/api/v1/oauth/instagram/callback`. Keep the Facebook one from Step 12 as well.

Last verified: not yet checked on a live dashboard

### Step 19: Enable Instagram in FeedBouncer

Turn the Instagram connector on in the `.env` that both the API and the worker read, then restart the stack with `docker compose up -d`. It runs on the same Meta app, so it requires the Facebook settings from Step 9 and fails at startup without them:

```bash
INSTAGRAM_CONNECTOR_ENABLED=true
```

Last verified: not yet checked on a live dashboard

### Step 20: Register the Instagram webhook

Under **Webhooks** choose the **Instagram** object, not Page. Use the callback URL `https://feedbouncer.example.com/api/v1/webhooks/instagram` and the same verify token as in Step 13, then choose **Verify and save** and subscribe to the `comments` field.

Last verified: not yet checked on a live dashboard

### Step 21: Connect Instagram in FeedBouncer

In FeedBouncer open your brand, then **Connections**, and choose **Connect Instagram**. Approve every permission and choose the Page that is linked to your Instagram account. The Instagram account then appears as its own connection.

Last verified: not yet checked on a live dashboard

## Configuration map

| Meta value                    | Where to find it in Meta                            | FeedBouncer setting                                                                                    |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| App ID                        | App settings, Basic                                 | `FACEBOOK_APP_ID`                                                                                      |
| App Secret                    | App settings, Basic, Show                           | `FACEBOOK_APP_SECRET` (or `FACEBOOK_APP_SECRET_FILE`)                                                  |
| Verify token                  | You create it, then type it into Webhooks           | `FACEBOOK_WEBHOOK_VERIFY_TOKEN` (or `FACEBOOK_WEBHOOK_VERIFY_TOKEN_FILE`)                              |
| Callback URL and redirect URI | Webhooks, and Facebook Login for Business, Settings | `PUBLIC_WEB_URL` plus the path                                                                         |
| Graph API version             | Shown in the dashboard header                       | `FACEBOOK_GRAPH_API_VERSION` (leave the default)                                                       |
| Instagram product             | Add products, Instagram                             | `INSTAGRAM_CONNECTOR_ENABLED` set to `true`                                                            |
| Access token                  | Not needed                                          | None: FeedBouncer gets it when you click Connect and stores it encrypted. Never paste one into config. |

## Permissions and why

FeedBouncer asks for exactly these permissions when you click Connect.

| Permission                  | Used for                   | Why FeedBouncer needs it                                          | App Review needed?                                                              |
| --------------------------- | -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pages_show_list`           | Listing your Pages         | Shows the Page picker and gives a Page access token for each      | Only for people without a role on the app                                       |
| `pages_read_engagement`     | Reading posts and comments | Reads comments, replies and author ids                            | Only for people without a role on the app                                       |
| `pages_read_user_content`   | Reading user comments      | Reads comments written by users on Page posts                     | Only for people without a role on the app                                       |
| `pages_manage_engagement`   | Moderating comments        | Hides, unhides, deletes and replies to comments, and bans authors | Only for people without a role on the app                                       |
| `pages_manage_metadata`     | Webhook subscription       | Subscribes the Page to the `feed` and `comments` fields           | Only for people without a role on the app                                       |
| `pages_messaging`           | Private replies            | Sends a private reply to a commenter                              | Only for people without a role on the app                                       |
| `instagram_basic`           | Instagram account details  | Reads the account id and username                                 | Only for people without a role on the app                                       |
| `instagram_manage_comments` | Instagram moderation       | Reads, hides, deletes and replies to Instagram comments           | Only for people without a role on the app, and needed for live Instagram events |
| `instagram_manage_messages` | Private replies (optional) | Sends private replies on Instagram; not needed to moderate        | Only for people without a role on the app                                       |

Checked against Meta's documentation on 2026-10-21. See Meta's [Permissions Reference](https://developers.facebook.com/docs/permissions) and [Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels).

## Development mode and Live mode

A new app starts in **Development mode**. In Development mode, only people with a role on the app (admins, developers, testers) generate events. A comment from anyone else is never delivered to FeedBouncer, even though it is on your Page. This is the most common reason a working setup looks broken.

**Live mode** is required to receive events from people without a role on the app. Switching to Live needs details Meta asks for at the time, such as a privacy policy URL, and for permissions beyond Standard Access it needs App Review.

If you only moderate your own Page and the people commenting have a role on the app (add them as testers in **App roles**), you can stay in Development mode.

## Tokens: how long they last

FeedBouncer never asks you for a token. When you click Connect it receives a user token, exchanges it for a long-lived one and derives a Page access token, which it stores encrypted.

Meta can invalidate a token at any time: the user changes their password, loses their role on the Page, removes the app, or has not used the app for 90 days. You can inspect a token's `expires_at` and `data_access_expires_at` in Meta's Access Token Debugger, but never screenshot or share the output.

When Meta rejects a token, the connection shows **Needs reconnect** with a reason, FeedBouncer emails the owners once, and moderation actions are paused. Choose **Reconnect**, approve the permissions again, and the paused actions are replayed.

## Test it end to end

1. Create a keyword rule for the word `feedbouncer-test-spam` (brand, **Rules**, **New rule**; see [rules.md](../moderation/rules.md)) that hides matching comments.
2. From your own account, or another account with a role on the app, comment `feedbouncer-test-spam` on a post on your Page. A comment from someone without a role on the app will not arrive while the app is in Development mode.
3. Within about a minute the comment appears in the brand's Comments list. New connections start in review mode for 7 days, so FeedBouncer shows a **Suggestion** to hide it instead of hiding it. Open **Suggestions** and accept it. The comment is then hidden on Facebook and listed under **Hidden today**, with your rule as the reason. You can undo it.
4. Optional: turn review mode off for the connection and repeat. The hide then happens on its own.

If nothing appears, see [Troubleshooting](#troubleshooting).

## Troubleshooting

### Meta won't save the webhook callback URL

Meta calls your URL when you choose **Verify and save**. Check in this order:

1. The verify token differs from `FACEBOOK_WEBHOOK_VERIFY_TOKEN`. FeedBouncer answers a bad handshake with `403`, so repeat the `curl` in Step 11 and compare.
2. The URL is unreachable or has the wrong path, or `PUBLIC_WEB_URL` or your tunnel changed. The path is `/api/v1/webhooks/facebook`.
3. The TLS certificate is not publicly trusted or has expired.

### Comments don't show up in FeedBouncer at all

Check that the Page shows as connected, that `feed` is subscribed under Webhooks, that `FACEBOOK_APP_SECRET` is correct (a wrong secret makes signature checks fail with `403` in the API logs) and that the worker is running.

### Only your own comments show up

The app is in Development mode, or you only have Standard Access, so only people with a role on the app generate events. Add the commenter as a tester, or see [When you need App Review or Business Verification](#when-you-need-app-review-or-business-verification).

### The connection says "Needs reconnect"

Meta rejected the stored token, for example after a password change, a lost Page role or 90 days without use. Choose **Reconnect**.

### Instagram account not found when connecting Instagram

The account is not a professional account, is not linked to the Page, or the Page was not selected in the Facebook dialog. FeedBouncer shows "this Page was not found in your Facebook account" when the Page is missing. Fix the link and connect again.

### Connecting fails with "missing permissions"

A permission was unticked in the Facebook dialog. Connect again and grant every permission.

### Comments arrive but nothing gets hidden

Review mode is probably on: look under **Suggestions**. Otherwise check that the rule is enabled and that it matches the comment.

### URL blocked or a redirect URI error when connecting

The redirect URI is missing from Facebook Login for Business, or `PUBLIC_WEB_URL` is still `http://localhost:3000` because of `compose.yaml` (see Step 10). Compare the URI in the error with Step 12.

### Meta asks you to verify your identity or says the app is restricted

This is Meta's own check. Follow Meta's help for [identity verification](https://www.facebook.com/business/help) and app restrictions rather than guessing; FeedBouncer cannot lift it.

## Keep your app secret and tokens safe

- The app secret, the verify token and `FB_ENCRYPTION_KEYS` are secrets. Keep `.env` readable only by you (`chmod 600 .env`), or use the `_FILE` variants or your host's secret store; see [secrets.md](../operations/secrets.md).
- Never commit them, paste them into issues or chat, or screenshot them. Keep `.env` and `compose.override.yaml` out of git.
- If the app secret is exposed, reset it under **App settings**, **Basic**, update `FACEBOOK_APP_SECRET` and restart. To rotate the verify token, generate a new one and update both FeedBouncer and Meta.
- If a Page token may be exposed, remove the app from the Page's Business Integrations and connect again.
- Back up `FB_ENCRYPTION_KEYS`. Without it stored tokens cannot be decrypted and every connection needs a reconnect.

## When you need App Review or Business Verification

You need neither if only people with a role on your app moderate their own Pages. You need **App Review** (to get Advanced Access) to serve Pages of people without a role on the app, and, according to Meta's documentation, for live Instagram comments. **Business Verification** is required for Advanced Access on many permissions and for Instagram webhooks in Business apps. FeedBouncer does not walk you through either; follow Meta's own guides: [App Review](https://developers.facebook.com/docs/resp-plat-initiatives/app-review) and [Business Verification](https://developers.facebook.com/docs/development/release/business-verification).

## More Pages and accounts

One Meta app serves many Pages. To add another Page, choose **Connect Facebook** again and select it in the Page picker (in Facebook's dialog, edit the grant if the Page is not listed). Each Page becomes its own connection under a brand. See [shared Pages](../connectors/facebook.md#shared-pages).
