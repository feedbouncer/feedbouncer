# Approving rule changes

An API key, and so the MCP server, can propose a rule change but never make one. `propose_rule_change` (or `POST /v1/rule-change-proposals`) stores a **proposal**. A person signed in to the web app decides it. Until then the brand's rules are exactly as they were.

## Lifecycle

```
pending ──approve (person)──────────────────────────► approved
   ├────reject (person)───────────────────────────► rejected
   ├────expiresAt passes──────────────────────────► expired
   └────approve attempted after the rules changed──► stale
```

| Status     | Meaning                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`  | Waiting for a decision. Nothing has changed.                                                                                                                   |
| `approved` | A person approved it and the change was applied as that person.                                                                                                |
| `rejected` | A person rejected it. Nothing changed.                                                                                                                         |
| `expired`  | Nobody decided before `expiresAt`. Nothing changed.                                                                                                            |
| `stale`    | Someone tried to approve it after the brand's rules had changed, so it was not applied. Nothing changed. See [below](#stale-proposals-must-be-proposed-again). |

`read_rules` shows the status of each brand's proposals from the last 7 days, and `GET /v1/rules` returns the same list.

## Where to approve

- The brand's **Rules** page in the web app shows how many changes are pending and links to them.
- Each proposal has its own review page, `/orgs/<organization id>/brands/<brand id>/rules/changes/<proposal id>`. This is the `reviewUrl` that `propose_rule_change` returns, so the assistant can hand it to you.
- The review page shows the operation, a before and after of every changed field, any warnings, the rationale, the API key that proposed it and when it expires.
- Owners and admins can approve or reject, with an optional note. Members can see proposals but not decide them.

Approving applies the change through the same code path as editing a rule by hand: the same validation, the same `rule.created`, `rule.updated` or `rule.archived` audit entry, attributed to the person who approved.

## Expiry

A proposal expires `RULE_PROPOSAL_TTL_HOURS` after it was made. The default is **24 hours**; set it on the API to anything from 1 to 168 hours. The setting applies to proposals made after the change.

Expiry needs no background job. A pending proposal past its `expiresAt` is reported as `expired` everywhere, and trying to approve or reject it records it as expired and answers `409 proposal_expired`.

## Stale proposals must be proposed again

Every brand has a rule revision, a counter that goes up whenever any of its rules is created, changed or archived (`ruleRevision` in `read_rules`). A proposal records the revision it was made against.

When someone approves, the API checks that the revision is still the same and validates the change again. If any rule of the brand changed in between, the proposal is recorded as `stale` and the approval fails with `409 proposal_stale`.

`stale` is recorded only at that moment. Until someone tries to approve, a proposal whose rules have changed underneath it:

- shows a stale warning on its review page, which offers no Approve or Reject button for it;
- is reported as `pending` by `read_rules` and `GET /v1/rules`, and as `expired` once its `expiresAt` passes;
- cannot be rejected, and counts toward the brand's limit of 20 pending proposals until it expires.

This is on purpose. The diff you review and the checks for duplicate, conflicting or overbroad rules were computed against the rules as they were. Applying the change on top of different rules could do something nobody reviewed. A stale proposal cannot be revived: ask for the change again (call `propose_rule_change` again), and review the new proposal against the current rules.

## Proposals that cannot be applied

Some problems only show when the change is applied, through the same checks as a hand edit:

- `invalid_actions`: a step that none of the brand's connected accounts can perform, for example after an account was disconnected.
- `rule_limit_reached`: the brand reached 200 rules after the proposal was made.

The approval then fails with that error and the proposal stays `pending`. Approving it again fails the same way until the cause goes away. Such a proposal can only be rejected or left to expire, and it counts toward the 20-pending limit until then; if the change is still wanted, propose it again once the cause is fixed.

## Why no tool or API key can approve

- The approve and reject routes, `POST /api/v1/orgs/{orgId}/brands/{brandId}/rule-changes/{id}/approve` and `.../reject`, are dashboard routes. They accept only a signed-in session with the `rule.write` permission (owners and admins). A request with an API key as a bearer token gets `401`.
- The public API (`/v1`) has no approve or reject route, and the MCP server has no such tool. A `write` key can propose, nothing more.
- A comment that tells the assistant to "approve" a change therefore cannot get one applied, however it is phrased. See [untrusted content](README.md#untrusted-content).

A brand can have at most 20 pending proposals at once; further proposals get `409 pending_limit_reached` until some are decided or expire.

## Audit

Every step is in the organization's audit log:

| Action                 | Actor                              | Details                                                    |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `rule_change.proposed` | the API key                        | `apiKeyId`, `operation`, `ruleId` for update and archive   |
| `rule_change.approved` | the person                         | `proposalId`, `operation`, `ruleId`                        |
| `rule_change.rejected` | the person                         | `proposalId`, `operation`, `ruleId` for update and archive |
| `rule_change.expired`  | the person who tried to decide it  | `proposalId`, `operation`                                  |
| `rule_change.stale`    | the person who tried to approve it | `proposalId`, `operation`                                  |

Rule names, conditions, rationales and notes are not copied into the audit details.
