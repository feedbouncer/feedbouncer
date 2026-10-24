# Bring your own Meta app

A step-by-step guide to creating a Meta app you own and connecting it to your FeedBouncer instance, so a comment on your Facebook Page is received and moderated.

## Status of this guide

Nothing in this guide has been verified against a live Meta dashboard yet. Screenshots, a permissions check against Meta's documentation and a dry run by two readers are still pending; see [meta-app-verification.md](meta-app-verification.md) for the checklist.

| Section                                            | Status           |
| -------------------------------------------------- | ---------------- |
| Meta terms used in this guide                      | Not yet verified |
| Before you start                                   | Not yet verified |
| Part 1: Create your Meta developer account and app | Not yet verified |
| Part 2: Add the products FeedBouncer needs         | Not yet verified |
| Part 3: Collect your app credentials               | Not yet verified |
| Part 5: Configure the webhook                      | Not yet verified |
| Part 6: Connect your Facebook Page                 | Not yet verified |
| Part 7: Connect Instagram (optional)               | Not yet verified |
| Configuration map                                  | Not yet verified |
| Permissions and why                                | Not yet verified |
| Development mode and Live mode                     | Not yet verified |
| Tokens: how long they last                         | Not yet verified |
| Test it end to end                                 | Not yet verified |
| Troubleshooting                                    | Not yet verified |
| Keep your app secret and tokens safe               | Not yet verified |
| Rotate secrets and tokens                          | Not yet verified |
| Optional: the free ad-comment scan                 | Not yet verified |
| When you need App Review or Business Verification  | Not yet verified |
| More Pages and accounts                            | Not yet verified |

## About this guide

Written against: Graph API v26.0 (text only; see [Status of this guide](#status-of-this-guide))

This guide covers Facebook Pages, and Instagram professional accounts as an optional extra. It does not cover YouTube, X or TikTok. For Meta Ads, see [meta-ads.md](../connectors/meta-ads.md). For TikTok, see [tiktok.md](../connectors/tiktok.md) and [tiktok-ads.md](../connectors/tiktok-ads.md).

Labels and menu paths come from FeedBouncer's connector docs and Meta's documentation. Meta changes its dashboard often, so some labels may differ from what you see. Each section that depends on Meta starts with a dated note saying what has not been checked yet. If the dashboard uses another language, labels will differ from the English ones used here.

A CI test fails when the version above no longer matches FeedBouncer's default Graph API version, so the guide cannot silently fall behind that. Issues and corrections are welcome.

Placeholders: `<APP_ID>`, `<APP_SECRET>`, `<VERIFY_TOKEN>` and `https://feedbouncer.example.com` stand for your own values.

## Meta terms used in this guide

> Not yet verified against Meta's documentation as of 2026-10-21. Check: each definition below, especially the access levels, App Review and Business Verification, against Meta's current glossary.

- **Meta developer account**: your Facebook login registered at developers.facebook.com so that you can create apps.
- **App Dashboard**: the Meta web page where you configure one app: products, settings, roles and webhooks.
- **App type / use case**: the choice Meta asks for when you create an app; it decides which products you can add.
- **Product**: a feature you add to an app, such as Facebook Login for Business or Webhooks.
- **Development mode**: the state of a new app; Meta's documentation says only people with a role on the app generate real events.
- **Live mode**: the state in which Meta's documentation says the app can serve people without a role on it.
- **App role (admin / developer / tester)**: a person you give access to your app in the dashboard; they can use it while it is in Development mode.
- **Standard Access**: Meta's documentation says this is the default level, which works for people with a role on the app.
- **Advanced Access**: Meta's documentation says this level is needed to serve people without a role on the app, and is granted through App Review.
- **App Review**: Meta's documentation says this is the process in which Meta checks how your app uses a permission before granting Advanced Access.
- **Business Verification**: Meta's documentation says this is a check of your business that some Advanced Access permissions require.
- **System user**: a non-human account that Meta Business Manager can create for automated access. FeedBouncer does not use system-user tokens; you connect with your own Facebook login.

## Before you start

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: that a personal profile, a Page you administer and a public HTTPS URL are the only prerequisites the create-app flow enforces.

You need:

- A Meta developer account. You create it in [Step 1](#step-1-register-as-a-meta-developer).
- A Facebook **Page** on which you have full control or admin rights. A personal profile is not enough, because FeedBouncer moderates comments on Pages, not on profiles.
- Optionally, an Instagram **professional account** (Business or Creator) linked to that Page. See the prerequisites at the top of [Part 7](#part-7-connect-instagram-optional).
- A running FeedBouncer instance. Installing it is covered in [Local stack with Docker Compose](../../README.md#local-stack-with-docker-compose).
- A **public HTTPS URL** for that instance, with a publicly trusted certificate: no `localhost` and no self-signed certificate. Meta's documentation says webhooks need a publicly reachable HTTPS endpoint, so expect Meta not to deliver to `localhost` or to a self-signed certificate (see Meta's [webhooks documentation](https://developers.facebook.com/docs/graph-api/webhooks)).

For testing you can put any HTTPS tunnel in front of your instance, for example Cloudflare Tunnel or ngrok (neither is endorsed). If the tunnel URL changes, update `PUBLIC_WEB_URL` and both URLs you give Meta.

The order of this guide differs from what you might expect: Meta checks your webhook URL while you save it, so FeedBouncer must already be configured (Parts 3 and 4) before you set up the webhook (Part 5).

## Part 1: Create your Meta developer account and app

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: the create-app flow's app type or use-case labels and which choice allows Facebook Login for Business plus Webhooks.

### Step 1: Register as a Meta developer

**Goal:** Get a Meta developer account on the Facebook login that administers your Page.

Open [developers.facebook.com](https://developers.facebook.com/) and log in with the Facebook account that administers your Page. Choose **Get Started** and complete the registration prompts. If Meta asks you to verify your account, follow its prompts; this is Meta's own check and not specific to FeedBouncer.

> [SCREENSHOT: developers home, get started] Must show: The Meta for Developers home page after you log in, with the Get Started option visible. Redact: your name, avatar and email address.

### Step 2: Create a Business app

**Goal:** Create the app that FeedBouncer will use to talk to Meta.

In the App Dashboard choose **Create app**. Give it any name that you recognise, such as `FeedBouncer`, and enter a contact email. When asked for the app type or use case, pick the one that lets you add **Facebook Login for Business** and **Webhooks**, which is the **Business** app type. You should land on the new app's dashboard.

> [SCREENSHOT: create app, app type or use case] Must show: The create-app screen with the app type or use-case choices that allow Facebook Login for Business and Webhooks. Redact: the App ID and app name in the dashboard header, your name and avatar, and any email address.

**Checkpoint:** You have a Meta developer account and an app in Development mode, shown on its dashboard, ready for products.

## Part 2: Add the products FeedBouncer needs

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: the Add products list, and the current names of Facebook Login for Business and Webhooks.

### Step 3: Add Facebook Login for Business

**Goal:** Let people approve FeedBouncer's permissions by logging in with Facebook.

On the app dashboard, find **Add products** (or **Products** in the left menu) and add **Facebook Login for Business**. FeedBouncer uses it so you can click **Connect** and approve the permissions listed under [Permissions and why](#permissions-and-why). The product's Settings page is where you add the redirect URI in Step 12.

> [SCREENSHOT: app dashboard, add products] Must show: The Add products list with Facebook Login for Business highlighted. Redact: the App ID and app name in the dashboard header, your name and avatar, and any email address.

### Step 4: Add Webhooks

**Goal:** Let Meta tell your instance when a comment arrives.

Add the **Webhooks** product the same way. Meta uses it to tell your instance about new comments. Do not subscribe to anything yet, because Meta verifies your callback URL while you save it and FeedBouncer is not configured until Part 4.

> [SCREENSHOT: app dashboard, webhooks product added] Must show: The dashboard product list with Webhooks added and nothing subscribed yet. Redact: the App ID and app name in the dashboard header, your name and avatar, and any email address.

**Checkpoint:** You have an app in Development mode with Facebook Login for Business and Webhooks listed under Products.

## Part 3: Collect your app credentials

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: where the App ID, App secret and Require App Secret setting live under App settings and whether they are still labelled this way.

### Step 5: Copy the App ID

**Goal:** Find the public identifier of your app so FeedBouncer can name it in login requests.

Open **App settings**, then **Basic**. The **App ID** is shown at the top. It is a number, and it is public: Meta shows it in the login dialog and in URLs. It is not a credential, but there is also no need to publish it. You will enter it as `FACEBOOK_APP_ID` in Part 4. Keep this page open for the next step.

> [SCREENSHOT: app settings, basic, app id] Must show: The Basic settings page with the App ID field visible. Redact: the App ID and app name in the dashboard header, your name and avatar, and any email address.

### Step 6: Copy the App Secret

**Goal:** Store the secret Meta uses to sign webhooks and that FeedBouncer uses to check them. It is under your app's basic settings.

On the same **Basic** page, next to **App secret**, choose **Show** and enter your password if asked. Copy the value into a password manager or a secret file straight away. The app secret is a secret: never paste it in an issue, chat or screenshot, and hide it again when you are done.

Meta's documentation says it signs every webhook payload with this secret and sends the result in the `X-Hub-Signature-256` header. FeedBouncer rejects any event whose signature does not match, with a `403`, so a wrong secret looks like "comments never arrive". FeedBouncer also signs its own Graph API calls with it (`appsecret_proof`). See [Keep your app secret and tokens safe](#keep-your-app-secret-and-tokens-safe).

> [SCREENSHOT: app settings, basic, app secret] Must show: The Basic settings page with the App secret field still masked, before you choose Show. Redact: the app secret field (it must stay masked), the App ID and app name in the dashboard header, your name and avatar, and any email address.

### Step 7: Generate a verify token

**Goal:** Invent the shared password Meta sends back during the webhook handshake, and keep it for later steps.

The verify token is a random string that you invent. Meta sends it back during the handshake so that FeedBouncer knows the request is genuine. It must be at least 20 characters. Generate one on a machine you trust and keep it for Steps 9 and 13:

```bash
openssl rand -hex 32
```

### Step 8: Turn on Require App Secret

**Goal:** Make Meta reject Graph API calls that lack proof of the app secret, so a stolen token alone is useless.

In **App settings**, then **Advanced**, make sure **Require App Secret** is on. FeedBouncer signs every Graph API call with `appsecret_proof`, so this setting is safe to enable and it stops anyone with only a stolen token from calling the API.

> [SCREENSHOT: app settings, advanced, require app secret] Must show: The Advanced settings page with Require App Secret switched on. Redact: the App ID and app name in the dashboard header, your name and avatar, and any email address.

**Checkpoint:** App ID noted; app secret and verify token stored in your password manager or secret files, nowhere else.

## Part 4: Configure FeedBouncer

### Step 9: Set the Meta settings

**Goal:** Give FeedBouncer your app's credentials and replace the example values before the instance goes public.

Add these settings to the `.env` of your instance and restrict the file with `chmod 600 .env`, because it now holds secrets:

```bash
FACEBOOK_APP_ID=<APP_ID>
FACEBOOK_APP_SECRET=<APP_SECRET>
FACEBOOK_WEBHOOK_VERIFY_TOKEN=<VERIFY_TOKEN>
```

Before this instance is reachable from the internet, replace the example values that `.env.example` ships, because they are published in this repository and would let anyone forge a login or reach your database:

```bash
FB_ENV=production
AUTH_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
```

Write the generated values into `.env` itself (the `$(...)` is not expanded there). Replace every other `dev-only-*` value in `.env` the same way. With `FB_ENV=production`, the services refuse to start while any example value is left in place. Postgres sets its password only when its volume is first created, so on an existing stack either change the password inside Postgres too or start from a fresh volume. Redis takes its password as a command argument, so restarting the stack is enough.

FeedBouncer encrypts the Page tokens it obtains with `FB_ENCRYPTION_KEYS`, so replace the `dev-example` key in your `.env` with a production key first, and set `FB_ENCRYPTION_ACTIVE_KEY_ID` to that key's id; [secrets.md](../operations/secrets.md) shows how to generate one. Compose does not read `PUBLIC_WEB_URL` from `.env`; you set it in the next step. Leave `FACEBOOK_GRAPH_API_VERSION` at its default. Docker Compose passes only these plain variables to the containers. To use the `_FILE` variants instead, mount the files from `compose.override.yaml` as shown in [secrets.md](../operations/secrets.md).

### Step 10: Override PUBLIC_WEB_URL for Docker Compose

**Goal:** Tell FeedBouncer its real public address, because Compose otherwise assumes localhost.

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

### Step 11: Restart and prove the webhook route is live

**Goal:** Prove that FeedBouncer's webhook route is live before you ask Meta to call it.

Restart the stack with `docker compose up -d`. The webhook route exists only when the Facebook settings are present. Send a handshake with a deliberately wrong token, so nothing secret is typed. A working route answers `403`; `404` means the route does not exist, so recheck Step 9:

```bash
curl -i "https://feedbouncer.example.com/api/v1/webhooks/facebook?hub.mode=subscribe&hub.challenge=test123&hub.verify_token=wrong"
```

**Checkpoint:** The settings are in your `.env`, the public URL is set for both services, and the curl in Step 11 returns 403.

## Part 5: Configure the webhook

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: the Webhooks and Facebook Login for Business Settings pages, the Page object and feed field names, and the Verify and save behaviour.

### Step 12: Add the OAuth redirect URI

**Goal:** Allow Meta to send people back to FeedBouncer after they approve the login.

Open **Facebook Login for Business**, then **Settings**, and add this under **Valid OAuth Redirect URIs**: `https://feedbouncer.example.com/api/v1/oauth/facebook/callback`. It must match your `PUBLIC_WEB_URL` exactly. Save the changes. Without it, clicking Connect later fails with a redirect error.

> [SCREENSHOT: facebook login for business, redirect uris] Must show: The Valid OAuth Redirect URIs field containing the Facebook callback URL and the Save changes button. Redact: the app ID and app name in the dashboard header, your name and avatar.

### Step 13: Register the callback URL

**Goal:** Tell Meta where to send comment events and prove you own that URL.

Open **Webhooks**, choose the **Page** object, then **Subscribe to this object**. Enter the callback URL `https://feedbouncer.example.com/api/v1/webhooks/facebook` and your verify token from Step 7, then choose **Verify and save**. Meta calls your instance immediately, which is why Part 4 comes first. If it fails, see the troubleshooting entry.

> [SCREENSHOT: webhooks, page callback url and verify token] Must show: The Page webhook dialog with the callback URL entered and the Verify and save button. Redact: the verify token field (it must be empty or covered), the App ID and app name in the dashboard header, your name and avatar, and any email address.

### Step 14: Subscribe to the feed field

**Goal:** Ask Meta to send comment and post changes on Pages for this app.

In the list of Page fields, find `feed` and choose **Subscribe**. This only registers the app for the field. FeedBouncer subscribes each Page to your app by itself when you connect it, so you do not subscribe Pages by hand.

> [SCREENSHOT: webhooks, page feed field subscribed] Must show: The Page webhook field list with feed subscribed. Redact: the App ID and app name in the dashboard header, your name and avatar, and any email address.

**Checkpoint:** Meta shows the callback verified, the Page feed field is subscribed and the Facebook redirect URI is saved under Facebook Login for Business. You add the Instagram one in Part 7 if you use Instagram.

## Part 6: Connect your Facebook Page

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: the Facebook permission dialog wording and whether every permission can be declined individually.

### Step 15: Connect Facebook in FeedBouncer

**Goal:** Let FeedBouncer obtain its own long-lived Page access, so you never paste a token.

In FeedBouncer open your brand, then **Connections**, and choose **Connect Facebook Page**. Facebook asks you to approve the permissions listed under [Permissions and why](#permissions-and-why). Leave every permission ticked, because FeedBouncer needs all of them and aborts the connection if one is declined. Do not paste any token from the Graph API Explorer; FeedBouncer obtains its own.

> [SCREENSHOT: feedbouncer connections, connect facebook] Must show: The brand's Connections page with the Connect Facebook Page button. Redact: Page, user and brand names, avatars and email addresses, and any URL query string such as an OAuth code.

### Step 16: Choose the Page

**Goal:** Pick which Page this brand moderates and confirm the connection is healthy.

Back in FeedBouncer, pick your Page in the Page picker. The connection should then show as connected. FeedBouncer stores its access token encrypted with `FB_ENCRYPTION_KEYS` and subscribes the Page to the `feed` field. Continue with [Test it end to end](#test-it-end-to-end), or with Part 7 for Instagram.

> [SCREENSHOT: feedbouncer page picker, connected] Must show: The Page picker and then the connection shown as connected. Redact: Page, user and brand names, avatars and email addresses.

**Checkpoint:** Your Page shows as connected in FeedBouncer under the brand's Connections; if it does not, repeat Step 15 and Step 16.

## Part 7: Connect Instagram (optional)

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: the Instagram product's API setup options and whether live Instagram comment events need Advanced Access plus Business Verification.

Read this before you change anything. Instagram needs more than Facebook:

- The account must be an Instagram **professional account** (Business or Creator). Personal accounts cannot work. In the Instagram app, switch it under **Settings** > **Account type and tools** > **Switch to professional account**, then link it to your Page; search the Instagram Help Center if the menu differs.
- It must be **linked** to the Facebook Page you connected in Part 6.
- Meta's documentation appears to say that live Instagram comment webhooks may require **Advanced Access** to the permissions (which needs App Review) and, for Business apps, a verified business; this is an open question and not yet verified (see [Meta's webhooks documentation](https://developers.facebook.com/docs/graph-api/webhooks)). If so, with only Standard Access, Instagram comments may not reach FeedBouncer even for your own account. See [When you need App Review or Business Verification](#when-you-need-app-review-or-business-verification). Facebook Pages are not affected.

### Step 17: Add the Instagram product

**Goal:** Make the same Meta app able to read Instagram comments through your linked Page.

In the App Dashboard add the **Instagram** product and choose **API setup with Facebook Login**, not the option that uses Instagram Login. FeedBouncer only works with the Facebook Login flavour, because it reaches the account through its linked Page.

> [SCREENSHOT: app dashboard, instagram api setup] Must show: The Instagram product page with API setup with Facebook Login chosen. Redact: the App ID and app name in the dashboard header, your name and avatar, and any email address.

### Step 18: Add the Instagram redirect URI

**Goal:** Allow Meta to send people back to FeedBouncer after the Instagram approval too.

Under **Facebook Login for Business**, **Settings**, add a second **Valid OAuth Redirect URI**: `https://feedbouncer.example.com/api/v1/oauth/instagram/callback`. Keep the Facebook one from Step 12 as well.

> [SCREENSHOT: facebook login for business, instagram redirect uri] Must show: The Valid OAuth Redirect URIs field listing both the Facebook and Instagram callback URLs. Redact: the App ID and app name in the dashboard header, your name and avatar, and any email address.

### Step 19: Enable Instagram in FeedBouncer

**Goal:** Switch the Instagram connector on in FeedBouncer.

Turn the Instagram connector on in the `.env` that both the API and the worker read, then restart the stack with `docker compose up -d`. It runs on the same Meta app, so it requires the Facebook settings from Step 9 and fails at startup without them:

```bash
INSTAGRAM_CONNECTOR_ENABLED=true
```

### Step 20: Register the Instagram webhook

**Goal:** Tell Meta where to send Instagram comment events.

Under **Webhooks** choose the **Instagram** object, not Page. Use the callback URL `https://feedbouncer.example.com/api/v1/webhooks/instagram` and the same verify token as in Step 13, then choose **Verify and save** and subscribe to the `comments` field.

> [SCREENSHOT: webhooks, instagram callback and comments field] Must show: The Instagram webhook dialog with the callback URL entered and the comments field subscribed. Redact: the verify token field (it must be empty or covered), the App ID and app name in the dashboard header, your name and avatar, and any email address.

### Step 21: Connect Instagram in FeedBouncer

**Goal:** Let FeedBouncer connect your Instagram account through its linked Page.

In FeedBouncer open your brand, then **Connections**, and choose **Connect Instagram account**. Approve every permission and choose the Page that is linked to your Instagram account. The Instagram account then appears as its own connection.

> [SCREENSHOT: feedbouncer connections, connect instagram] Must show: The Connections page with the Instagram account listed as its own connection. Redact: Page, user and Instagram names, avatars and email addresses, and any URL query string such as an OAuth code.

**Checkpoint:** Instagram is optional: the Instagram account shows as its own connection, or you skipped this Part and Facebook alone works.

## Configuration map

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: each place named in the middle column, and that the Graph API version is shown in the dashboard header.

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

> Not yet verified against Meta's documentation as of 2026-10-21. Check: each permission name and whether Standard Access covers app-role users.

Across **Connect Facebook Page** and **Connect Instagram account**, FeedBouncer asks for exactly these permissions.

| Permission                  | Used for                   | Why FeedBouncer needs it                                          | App Review (per Meta's docs)                                                                 |
| --------------------------- | -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pages_show_list`           | Listing your Pages         | Shows the Page picker and gives a Page access token for each      | Meta's docs: only for people without a role on the app                                       |
| `pages_read_engagement`     | Reading posts and comments | Reads comments, replies and author ids                            | Meta's docs: only for people without a role on the app                                       |
| `pages_read_user_content`   | Reading user comments      | Reads comments written by users on Page posts                     | Meta's docs: only for people without a role on the app                                       |
| `pages_manage_engagement`   | Moderating comments        | Hides, unhides, deletes and replies to comments, and bans authors | Meta's docs: only for people without a role on the app                                       |
| `pages_manage_metadata`     | Webhook subscription       | Subscribes the Page to the `feed` and `comments` fields           | Meta's docs: only for people without a role on the app                                       |
| `pages_messaging`           | Private replies            | Sends a private reply to a commenter                              | Meta's docs: only for people without a role on the app                                       |
| `instagram_basic`           | Instagram account details  | Reads the account id and username                                 | Meta's docs: only for people without a role on the app                                       |
| `instagram_manage_comments` | Instagram moderation       | Reads, hides, deletes and replies to Instagram comments           | Meta's docs: only for people without a role on the app, and needed for live Instagram events |
| `instagram_manage_messages` | Private replies (optional) | Sends private replies on Instagram; not needed to moderate        | Meta's docs: only for people without a role on the app                                       |

See Meta's [Permissions Reference](https://developers.facebook.com/docs/permissions) and [Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels).

## Development mode and Live mode

> Not yet verified against Meta's documentation as of 2026-10-21. Check: what Development mode delivers, and what the Live-mode switch requires today.

A new app starts in **Development mode**. Meta's documentation says that in Development mode only people with a role on the app (admins, developers, testers) generate events, so expect a comment from anyone else not to be delivered to FeedBouncer even though it is on your Page (see Meta's [webhooks documentation](https://developers.facebook.com/docs/graph-api/webhooks)). This is the most common reason a working setup looks broken.

Meta's documentation says **Live mode** is required to receive events from people without a role on the app, that switching to Live needs details such as a privacy policy URL, and that permissions beyond Standard Access need App Review. See [App Review](https://developers.facebook.com/docs/resp-plat-initiatives/app-review) and ask Meta for the current requirements.

If you only moderate your own Page and the people commenting have a role on the app (add them as testers in **App roles**), you may be able to stay in Development mode. This is unverified; Meta's documentation says apps in development mode only receive webhook notifications for people with a role on the app (see [Meta's webhooks documentation](https://developers.facebook.com/docs/graph-api/webhooks)).

## Tokens: how long they last

> Not yet verified against Meta's documentation as of 2026-10-21. Check: long-lived user and Page token lifetimes and the invalidation causes listed below.

FeedBouncer never asks you for a token. When you click Connect it receives a user token, exchanges it for a long-lived one and derives a Page access token, which it stores encrypted.

Meta can invalidate a token at any time: the user changes their password, loses their role on the Page, removes the app, or has not used the app for a long time. Exact token lifetimes are not yet verified; check Meta's documentation. You can inspect a token's `expires_at` and `data_access_expires_at` in Meta's Access Token Debugger, but never screenshot or share the output.

When Meta rejects a token, the connection shows **Needs reconnect** with a reason, FeedBouncer emails the owners once, and moderation actions are paused. Choose **Reconnect**, approve the permissions again, and the paused actions are replayed.

## Test it end to end

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: that a comment from a user with an app role is delivered while the app is in Development mode.

1. Create a keyword rule for the word `feedbouncer-test-spam` (brand, **Rules**, **New rule**; see [rules.md](../moderation/rules.md)) that hides matching comments.
2. From your own account, or another account with a role on the app, comment `feedbouncer-test-spam` on a post on your Page. A comment from someone without a role on the app will not arrive while the app is in Development mode.
3. Within about a minute the comment appears in the brand's Comments list. New connections start in review mode for 7 days, so FeedBouncer shows a **Suggestion** to hide it instead of hiding it. Open **Suggestions** and accept it. The comment is then hidden on Facebook and listed under **Hidden today**, with your rule as the reason. You can undo it.

> [SCREENSHOT: feedbouncer suggestion for test comment] Must show: The Suggestions list with a suggestion to hide the test comment and its rule reason. Redact: commenter names and avatars, Page and brand names, and email addresses.

> [SCREENSHOT: feedbouncer hidden today with rule reason] Must show: The Hidden today list with the test comment and your rule named as the reason. Redact: commenter names and avatars, Page and brand names, and email addresses.

4. Optional: turn review mode off for the connection and repeat. The hide then happens on its own.

If nothing appears, see [Troubleshooting](#troubleshooting).

## Troubleshooting

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: each Meta-side symptom and fix below by reproducing it on a test app.

### Meta won't save the webhook callback URL

Meta calls your URL when you choose **Verify and save**. Check in this order:

1. The verify token differs from `FACEBOOK_WEBHOOK_VERIFY_TOKEN`. FeedBouncer answers a bad handshake with `403`, so repeat the `curl` in Step 11 and compare.
2. The URL is unreachable or has the wrong path, or `PUBLIC_WEB_URL` or your tunnel changed. The path is `/api/v1/webhooks/facebook`.
3. The TLS certificate is not publicly trusted or has expired.
4. The URL is not HTTPS or is not publicly reachable. Test it from outside your own network, for example from a phone on mobile data.
5. A reverse proxy or tunnel is changing the request. The handshake query string (`hub.mode`, `hub.challenge`, `hub.verify_token`) must reach FeedBouncer intact and the path must not be rewritten. For events, the body must pass through byte-for-byte and the `X-Hub-Signature-256` header must not be stripped, or every event gets a `403`.

### Comments don't show up in FeedBouncer at all

Check that the Page shows as connected, that `feed` is subscribed under Webhooks, that `FACEBOOK_APP_SECRET` is correct (a wrong secret makes signature checks fail with `403` in the API logs) and that the worker is running.

### Only your own comments show up

Meta's documentation says that in Development mode, or with only Standard Access, only people with a role on the app generate events. Add the commenter as a tester, or see [When you need App Review or Business Verification](#when-you-need-app-review-or-business-verification).

### The connection says "Needs reconnect"

Meta rejected the stored token. Common causes:

- A short-lived token was never exchanged for a long-lived one. This cannot happen through **Connect**, but it can if someone pasted Graph API Explorer tokens elsewhere.
- The user changed their Facebook password.
- The user lost their role on the Page.
- The admin who connected the Page left the Page.
- The app was removed from your Facebook account's Business Integrations.
- According to Meta's documentation, a long period without use made the token expire.

FeedBouncer emails the owners and pauses moderation actions until you choose **Reconnect**.

### Instagram account not found when connecting Instagram

The account is not a professional account, is not linked to the Page, or the Page was not selected in the Facebook dialog. FeedBouncer shows "this Page was not found in your Facebook account" when the Page is missing. Fix the link and connect again.

### Connecting fails with "missing permissions"

A permission was unticked in the Facebook dialog. Connect again and grant every permission.

### Actions fail with a permission error

FeedBouncer shows "FeedBouncer lacks the permission for this action". Likely causes, not yet verified: a permission was unticked when you connected, the user lost their role on the Page, or the action needs a permission that has only Standard Access (see [Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels)). Choose **Reconnect** and grant all permissions.

### Processing is delayed and Meta asked FeedBouncer to slow down

FeedBouncer shows "Processing delayed: Meta asked FeedBouncer to slow down. New comments are queued and will be checked; none are dropped." Meta is rate limiting the app; see Meta's [rate limiting documentation](https://developers.facebook.com/docs/graph-api/overview/rate-limiting). Comments are queued, not dropped, and there is nothing for you to change unless the message persists for hours.

### Comments arrive but nothing gets hidden

Review mode is probably on: look under **Suggestions**. Otherwise check that the rule is enabled and that it matches the comment.

### URL blocked or a redirect URI error when connecting

The redirect URI is missing from Facebook Login for Business, or `PUBLIC_WEB_URL` is still `http://localhost:3000` because of `compose.yaml` (see Step 10). Compare the URI in the error with Step 12.

### Meta asks you to verify your identity or says the app is restricted

This is Meta's own check. Follow Meta's help for [identity verification](https://www.facebook.com/business/help) and app restrictions rather than guessing; FeedBouncer cannot lift it.

## Keep your app secret and tokens safe

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: where the app secret reveal and the Access Token Debugger live today.

- The app secret, the verify token and `FB_ENCRYPTION_KEYS` are secrets. Keep `.env` readable only by you (`chmod 600 .env`), or use the `_FILE` variants or your host's secret store; see [secrets.md](../operations/secrets.md).
- Never commit them. Keep `.env` and `compose.override.yaml` out of git.
- Never paste tokens or the app secret into issues, logs, chat or screenshots. FeedBouncer never logs them, so if a log you are about to share contains one, stop and rotate it; see [Rotate secrets and tokens](#rotate-secrets-and-tokens).
- Back up `FB_ENCRYPTION_KEYS`. Without it stored tokens cannot be decrypted and every connection needs a reconnect.

### What to redact in screenshots

Cover sensitive areas with an opaque fill. Never use blur or pixelation, which can be reversed or guessed. Redact:

- The App ID, the app name and the Page name.
- User and Instagram names and avatars.
- The app secret. Never choose **Show** while capturing a screenshot.
- The verify token.
- Any `access_token`, `code` or other URL query string.
- Email addresses.
- The Access Token Debugger output. Never capture it.

## Rotate secrets and tokens

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: where the app secret reset lives under App settings and where the Business Integrations list is today.

### App secret

If the app secret is exposed, reset it under **App settings**, **Basic**, then update `FACEBOOK_APP_SECRET` (or its file) in your `.env` and restart the stack. Webhooks fail with `403` until both sides match, so do both in one sitting.

### Verify token

Generate a new one as in Step 7, update `FACEBOOK_WEBHOOK_VERIFY_TOKEN`, restart, then re-enter the new value in Meta's Webhooks settings and choose **Verify and save**.

### Page tokens

Choosing **Reconnect** in FeedBouncer re-issues them. To revoke a Page token, remove the app from your Facebook account's Business Integrations.

### Encryption keys

Follow [secrets.md](../operations/secrets.md) to rotate `FB_ENCRYPTION_KEYS`. Back up your keys and keep the old key until every connection is re-encrypted; otherwise every connection needs a **Reconnect**.

## Optional: the free ad-comment scan

> Not yet verified against Meta's documentation as of 2026-10-23. Check: that the four required permissions are enough to read ad-post comments, and what App Review asks for.

The free scan is a public page where a visitor connects a Facebook Page and sees how many comments on their recent ads look like scams (including phishing) or spam. It is **off by default**. A self-hosted instance only serves it when you set `SCAN_TOOL_ENABLED=true`.

To turn it on:

1. Configure the Meta app and the classifier as in the rest of this guide. The instance refuses to start with `SCAN_TOOL_ENABLED=true` if the `FACEBOOK_*` settings are missing or `CLASSIFIER_PROVIDER` is not set.
2. Under **Facebook Login for Business**, **Settings**, add this to **Valid OAuth Redirect URIs**: `${PUBLIC_WEB_URL}/api/v1/scan/oauth/meta/callback` (for example `https://feedbouncer.example.com/api/v1/scan/oauth/meta/callback`). This is a separate address from the one in Step 12.
3. Set the scan variables in your `.env`, then restart the API and worker:

| Variable                  | Values            | Default | What it does                                  |
| ------------------------- | ----------------- | ------- | --------------------------------------------- |
| `SCAN_TOOL_ENABLED`       | `true` or `false` | `false` | Turns the scan on                             |
| `SCAN_MAX_COMMENTS`       | 100 to 5000       | `2000`  | Most comments read in one scan                |
| `SCAN_RETENTION_DAYS`     | 1 to 30           | `30`    | Days before a scan and its result are deleted |
| `SCAN_WORKER_CONCURRENCY` | 1 to 16           | `2`     | Scans one worker runs at the same time        |

The scan asks for these permissions, and never writes with any of them:

| Permission                  | Required | Used for                             |
| --------------------------- | -------- | ------------------------------------ |
| `pages_show_list`           | Yes      | Listing the visitor's Pages          |
| `pages_read_engagement`     | Yes      | Reading ad posts and their comments  |
| `pages_read_user_content`   | Yes      | Reading comments written by users    |
| `ads_read`                  | Yes      | Finding the Page's recent ads        |
| `instagram_basic`           | No       | Finding the linked Instagram account |
| `instagram_manage_comments` | No       | Reading comments on Instagram ads    |

Meta requires `instagram_manage_comments` to read Instagram comments, so the scan requests it only for that. It is never used to hide, delete or reply to a comment.

The scan's Graph client refuses anything but GET requests. The only POST requests the tool makes go to Meta's token endpoint, when the sign-in code is exchanged for an access token. They make no change to the visitor's Page or ads.

`ads_read` and `pages_read_user_content` need **Advanced Access** through Meta App Review before visitors who have no role on your app can grant them. Until then, only people with a role on the app (administrators, developers, testers) can run a scan. Keep the tool off until review is granted if you want it open to the public.

The visitor-facing description of what is read and stored is in [the free scan page](../../apps/docs/docs/free-scan.md). The deletion schedule is in [data-retention.md](../operations/data-retention.md#free-scan-data).

## When you need App Review or Business Verification

> Not yet verified against Meta's documentation as of 2026-10-21. Check: the App Review and Business Verification requirements and links against Meta's current pages.

Meta's documentation says you need **App Review** (to get Advanced Access) to serve Pages of people without a role on the app. Whether live Instagram comments also need Advanced Access and, for Business apps, **Business Verification** is an open question that is not yet verified; Meta's documentation appears to say so for many permissions. Meta's review and verification take time, so plan for a wait.

Self-hosters who only moderate their own assets, with commenters who have a role on the app, _may_ be able to stay in Development mode and need neither. This is unverified; it is an open question (see [meta-app-verification.md](meta-app-verification.md)). FeedBouncer does not walk you through either process; follow Meta's own guides: [App Review](https://developers.facebook.com/docs/resp-plat-initiatives/app-review) and [Business Verification](https://developers.facebook.com/docs/development/release/business-verification).

## More Pages and accounts

> Not yet verified against Meta's dashboard as of 2026-10-21. Check: that one app can serve several Pages and how the Page picker lists them.

Use the **same app** for every Page and Instagram account; never create a second app. To add another Page, choose **Connect Facebook Page** again and pick the new Page in the Page picker. If the Page is not offered, edit the grant in Facebook's dialog (your Facebook account's Business Integrations entry for the app) to include it. The webhook and redirect URIs are per app, so nothing changes in Meta. Each Page becomes its own connection under a brand, and different brands can hold different Pages. See [shared Pages](../connectors/facebook.md#shared-pages).
