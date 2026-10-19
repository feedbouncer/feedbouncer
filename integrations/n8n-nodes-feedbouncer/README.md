# n8n nodes for FeedBouncer

Community nodes for [n8n](https://n8n.io) that connect a workflow to [FeedBouncer](https://github.com/feedbouncer/feedbouncer) through its public `/v1` API and signed webhooks.

- **FeedBouncer Trigger** starts a workflow when FeedBouncer flags, hides or receives a comment.
- **FeedBouncer** reads comments and rules, and hides or un-hides comments.

The package has no runtime dependencies and is published from CI with npm provenance.

## Installation

In n8n, open **Settings → Community nodes → Install** and enter `@feedbouncer/n8n-nodes-feedbouncer`.

For a self-hosted instance in queue mode, install the package on every main, worker and webhook-processor instance instead, then restart them:

```sh
cd ~/.n8n/nodes
npm install @feedbouncer/n8n-nodes-feedbouncer
```

## Credential setup

Create a **FeedBouncer API** credential:

| Field | Meaning |
|---|---|
| Base URL | The address you sign in to FeedBouncer at, for example `https://feedbouncer.acme.io`. A path prefix such as `https://acme.io/feedbouncer` works. A trailing slash or a trailing `/v1` is ignored. Credentials in the URL, a query string and a fragment are rejected. |
| API Key | A key from FeedBouncer under Settings → API keys. It is stored only in the n8n credential store. |
| Allow Plain HTTP | Off by default. Turn it on only for a trusted network: over `http://` the key is sent unencrypted. |
| Ignore SSL Issues (Insecure) | Accept a self-signed or otherwise untrusted certificate. |

Which key scope you need:

| Feature | Scope |
|---|---|
| Comment and Rule operations | Read |
| FeedBouncer Trigger, and Decision operations (Hide, Undo Hide) | Read and write |

A read-only key used for a write feature fails with a message that says the key is read-only. Use **Test** on the credential to check the address and key: a revoked key reports that FeedBouncer rejected it, and an unknown address reports that no FeedBouncer API was found there.

Requests time out after 30 seconds and redirects are never followed, so the key is not sent to another address.

## FeedBouncer Trigger

The node registers a webhook endpoint in FeedBouncer when the workflow is activated and removes it when the workflow is deactivated. Nothing is created while you only test the node manually.

**Events** (default: Comment Flagged for Review):

| Option | Event type | When |
|---|---|---|
| Comment Flagged for Review | `item.flagged` | A comment is held for review. |
| Comment Hidden | `comment.hidden` | A comment was hidden. |
| Comment Received | `comment.received` | A new comment arrived. |

Each run receives one event. The item is the event body (`id`, `type`, `data`, and so on) plus `deliveryId`. Test deliveries from FeedBouncer are acknowledged and do not start the workflow. Example: `{{ $json.data.flaggedItem.comment.text }}` for a flagged item, and `{{ $json.data.comment.text }}` for the other two events.

Requirements:

- FeedBouncer delivers only to a public `https` address on port 443. Set n8n's public webhook address (`WEBHOOK_URL`) to such an address. A FeedBouncer operator can allow other networks with `WEBHOOK_ALLOWED_PRIVATE_CIDRS`. If the address is refused, activation fails with a message that says so.
- A FeedBouncer workspace can have at most 10 webhook endpoints. Every active FeedBouncer Trigger node uses one. At the limit, activation fails and tells you to deactivate another workflow or delete unused endpoints.
- The credential needs a Read and write key.

Deliveries are verified with the Standard Webhooks signature over the raw body, with a 5-minute timestamp tolerance. A missing or invalid signature gets HTTP 401 and starts nothing.

## Operations

Operations on **FeedBouncer** run once per input item. IDs are FeedBouncer UUIDs.

### Comment

| Operation | Inputs | Output |
|---|---|---|
| Get | Comment ID | One item: the comment. |
| Get Many | Return All or Limit (default 50); Filters: Brand ID, Platform (Facebook, Instagram), Posted After, Posted Before, Search (2 to 200 characters), Status (Flagged, Hidden, Replied, Unanswered, Visible) | One item per comment, newest first. |

### Decision

| Operation | Inputs | Output |
|---|---|---|
| Hide | Comment ID | One item: `action` (`id`, `kind`, `status`, `code`), `comment`, and `changed`. |
| Undo Hide | Comment ID | The same, for making a hidden comment visible again. |

Options for both: **Wait for Result** (on by default) polls up to 15 seconds for the platform to confirm the change, and **Idempotency Key** overrides the key sent with the request. By default the key is derived from the execution, node and item, so a retried run cannot repeat the action. A custom key may use 1 to 128 letters, digits and `. _ : -`. If the platform does not apply the change, the node fails with the platform's code. An Undo Hide that the platform cannot perform fails with a message saying so.

### Rule

| Operation | Inputs | Output |
|---|---|---|
| Get | Rule ID; optional Brand ID | One item: the rule, with `brandId` and `brandName` added. |
| Get Many | Optional Brand ID; Return All or Limit (default 50) | One item per live rule, in evaluation order. |

### Paging

Get Many fetches pages of 100. Return All stops at 10,000 items and then fails with a message asking you to narrow the filters or use Limit. Results are never silently cut off.

## Errors and retries

- When FeedBouncer answers 429 the node waits for the `Retry-After` time and tries again, up to 3 retries (4 attempts). Without that header it waits 1, 2 and 4 seconds. If FeedBouncer asks for more than 60 seconds the node fails at once with a rate-limit error that says how long to wait.
- Authentication, permission, not-found, validation and unreachable-server errors have plain messages. Error messages and output never contain your API key.
- Turn on **Continue On Fail** in the node settings to carry on with the next item; the failed item holds the error.

## Supported versions

- Tested with n8n 2.43.8. CI installs the package into that release and checks that both nodes load.
- `n8nNodesApiVersion` is 1.
- FeedBouncer must expose these operations in its `/v1/openapi.json`: `getApiKey`, `listComments`, `getComment`, `hideComment`, `unhideComment`, `getAction`, `listRules`, `listWebhookEndpoints`, `createWebhookEndpoint`, `getWebhookEndpoint`, `deleteWebhookEndpoint`. On an older server the node says the operation is not supported yet.

## Known limitations

- Submitting a comment for moderation, approving a flagged item and deleting a comment are not available yet, because the public API has no such routes.
- Undo covers hides only.
- De-duplication is per workflow and relies on n8n static data. With queue mode and several webhook processors, a simultaneous duplicate delivery can rarely run twice. FeedBouncer delivers at least once, so keep downstream steps idempotent.
- n8n does not save static data in manual test runs, so de-duplication and the stored endpoint apply to active workflows only.

## Security

The API key lives only in the n8n credential store. The trigger's signing secret is kept in the workflow's static data, so treat workflow exports as sensitive. It can only be used to forge deliveries to that one n8n webhook address, and it is not your API key. Deactivating and reactivating the workflow removes the endpoint and issues a new secret.

Report vulnerabilities as described in the [security policy](https://github.com/feedbouncer/feedbouncer/blob/main/SECURITY.md).

## Example workflow

[`alert-chat-when-comment-held.json`](https://github.com/feedbouncer/feedbouncer/blob/main/integrations/n8n-nodes-feedbouncer/examples/alert-chat-when-comment-held.json) posts the held comment's text to a Slack channel. In n8n choose **Import from file** (or paste the JSON), then select your own FeedBouncer API and Slack credentials and set the channel. The file contains no credentials.

For the API itself see the [public API reference](https://github.com/feedbouncer/feedbouncer/blob/main/docs/api/README.md).

## Licence

[MIT](LICENSE)
