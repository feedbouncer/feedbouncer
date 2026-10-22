# Reader test

A manual release gate. Before the first tagged release, and before any release that changes the
structure of the site, two people who have never used FeedBouncer work through the four tasks below
using only the published documentation. The run is recorded in the table at the end.

## Reader profile

- Has not used FeedBouncer before.
- Works against a local stack and a throwaway brand, so nothing real can be hidden, banned or deleted.
- Gets no help from a maintainer. The observer only writes down where the reader stops, hesitates or
  guesses.

## Tasks

Give the reader each task as a short instruction and nothing else.

1. **Block spam links.** Using the Rules section, create a rule that hides comments containing links
   to a domain of your choice, run it in dry run first, then switch it to enforce. Explain what
   happens to a comment that matches no rule.
2. **Call the API.** Using the API reference, create an API key, list the comments of your brand
   with `curl`, fetch the second page, and then handle a deliberate error (a missing scope or a bad
   cursor) by reading the error code in the docs.
3. **Connect an MCP client.** Using MCP setup, connect the client you normally use, confirm that the
   tools are listed, and ask it for the comments waiting for review. Do not place the API key in a
   file that could be committed.
4. **Explain a decision.** Using Concepts, take one comment that FeedBouncer acted on and say which
   rule or policy decided it, why that one won, and how to undo the action.

## Rules

- A task counts as finished when the reader reaches the stated result without outside help.
- Any step where the reader gets stuck is fixed in the docs and re-checked, with a reader who has not
  seen the fix, before the release is tagged. Record the fixing commit in the table.
- Use anonymised names (Reader A, Reader B). Do not record personal data.

## Record

| Reader   | Date | Version | Task | Finished? | Stuck at | Fix (commit) |
| -------- | ---- | ------- | ---- | --------- | -------- | ------------ |
| Reader A |      |         | 1    |           |          |              |
| Reader A |      |         | 2    |           |          |              |
| Reader A |      |         | 3    |           |          |              |
| Reader A |      |         | 4    |           |          |              |
| Reader B |      |         | 1    |           |          |              |
| Reader B |      |         | 2    |           |          |              |
| Reader B |      |         | 3    |           |          |              |
| Reader B |      |         | 4    |           |          |              |
