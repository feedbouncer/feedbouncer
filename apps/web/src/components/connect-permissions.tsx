export interface ConnectPermission {
  scope: string;
  purpose: string;
  required: boolean;
}

// What the owner is asked to approve before the platform's consent screen. Rendered only
// for platforms whose permissions are a choice; the server text is shown as text nodes.
export function ConnectPermissions(props: { permissions: readonly ConnectPermission[] }) {
  if (props.permissions.length === 0) return null;
  return (
    <section aria-label="Permissions" className="flex flex-col gap-2 text-small">
      <p className="text-dim">FeedBouncer will ask for these permissions:</p>
      <ul className="flex flex-col gap-2">
        {props.permissions.map((p) => (
          <li key={p.scope}>
            <code>{p.scope}</code>{' '}
            <small className="text-dim">{p.required ? 'Required' : 'Optional'}</small>
            <br />
            <span className="text-dim">{p.purpose}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
