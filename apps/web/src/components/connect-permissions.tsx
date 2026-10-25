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
    <section aria-label="Permissions">
      <p>FeedBouncer will ask for these permissions:</p>
      <ul>
        {props.permissions.map((p) => (
          <li key={p.scope}>
            <code>{p.scope}</code> <small>{p.required ? 'Required' : 'Optional'}</small>
            <br />
            {p.purpose}
          </li>
        ))}
      </ul>
    </section>
  );
}
