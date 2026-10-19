# Changelog

## 0.1.0

- FeedBouncer Trigger: starts a workflow on flagged, hidden or received comments. It registers and removes its own webhook endpoint, verifies Standard Webhooks signatures and de-duplicates deliveries.
- FeedBouncer node: get and list comments, hide and undo a hide, get and list rules.
- FeedBouncer API credential with a connection test, cloud and self-hosted base URLs, and 429 retry handling.
- Example workflow and documentation.
