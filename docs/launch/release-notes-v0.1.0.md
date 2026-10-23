# FeedBouncer v0.1.0

This is an alpha release. It runs, but interfaces and the database schema may change.

## What FeedBouncer does

Scam links, spam and abuse in the comments under ads and social posts have to be found and hidden by someone, while the ad keeps running and people keep reading the thread. FeedBouncer checks new comments on connected accounts, hides what your rules and policies say to hide, and routes real questions and complaints to a person. It is open source (AGPL-3.0) and you host it yourself.

## What works today

- Connectors for Facebook Pages and for Instagram business or creator accounts. Comments on Meta ads, dark posts included, are polled.
- Rules run first: keyword, regex, link domain, emoji, author or competitor.
- An optional AI classifier and plain-language policies look at what no rule decided. The provider is your choice: OpenAI, Google or any OpenAI-compatible endpoint. With no provider, nothing is classified.
- Review mode, on by default: for the first 7 days after an account is connected, hides, deletes, bans and replies are suggestions that a person approves.
- An undo log: every decision keeps its reason, and the Hidden today page undoes a hide in one click.
- A public REST API, outgoing webhooks, an MCP server and n8n nodes.

## Known limitations

- Neither the Facebook Pages nor the Instagram connector has been verified against a live Meta app yet. The open points are listed in https://github.com/feedbouncer/feedbouncer/blob/main/docs/connectors/facebook.md
- Meta App Review is not complete. You bring your own Meta app, so connecting accounts means creating and configuring one.
- TikTok and YouTube are planned, not available yet.
- There are no published accuracy figures yet. Measure false hides on your own comments with the evaluation method in the docs.
- Not for production use. Interfaces and the database schema may change without notice.

## Install

Self-host with Docker Compose. Start with the quick start in https://github.com/feedbouncer/feedbouncer and then follow the Meta app setup in https://github.com/feedbouncer/feedbouncer/blob/main/docs/self-hosting/meta-app.md

## Contributing

Issues and small pull requests are welcome. Setup and checks are in https://github.com/feedbouncer/feedbouncer/blob/main/CONTRIBUTING.md

FeedBouncer is not affiliated with or endorsed by Meta, Google or any other platform it connects to.
