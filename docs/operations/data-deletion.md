# Data deletion

How an organization's data is deleted at the end of the private beta, or on
request.

## Owner

The **Beta operator**. The named person is recorded in the team's ops roster,
not in this repository.

## Turnaround

Target: 5 business days from a verified request. Maximum: 30 days.

## Procedure

1. Verify that the request comes from an organization owner's email.
2. Run `pnpm ops erase-org --org <id> --confirm "<name>" --delete-orphan-users`.
   It disconnects every live connection, waits for the platform teardown to
   delete the stored tokens, then deletes the organization and the users who
   belonged to no other one. Nothing is deleted if the teardown stalls.
3. Remove the partner's Meta app role (Tester) in the Meta dashboard.
4. Ask the partner to remove FeedBouncer under Facebook Business Integrations.
5. Check backups. State the actual backup retention of the deployment, or "no
   backups beyond N days", in the confirmation.
6. Send the confirmation email below.

## Confirmation email

Subject: Your FeedBouncer data has been deleted

> Hello,
>
> We have deleted your FeedBouncer organization, its connections and stored
> comments, and the accounts that belonged only to it. Backups: [backup retention statement].
>
> Please also remove FeedBouncer under Facebook Business Integrations in your
> Facebook settings, so Meta stops listing it as connected.
>
> Questions: reply to this email.

## Record

Add a row for each request. Do not write email addresses here.

| Request date | Org id | Completed | By  |
| ------------ | ------ | --------- | --- |
