export function ConnectChecklist() {
  return (
    <section
      aria-label="Before you connect"
      className="rounded-lg border border-border bg-card p-(--fb-card-pad) text-small text-dim"
    >
      <p className="font-semibold text-foreground">Before you connect:</p>
      <ol className="list-decimal ps-5">
        <li>
          Accept the FeedBouncer tester invitation in Facebook (developers.facebook.com/requests)
        </li>
        <li>Have full control or Moderate access on the Page</li>
        <li>Allow every permission on the Facebook screen</li>
      </ol>
      <p>
        Didn&apos;t come back from Facebook, or saw &quot;Feature unavailable&quot;? Step 1 is
        usually missing.
      </p>
    </section>
  );
}
