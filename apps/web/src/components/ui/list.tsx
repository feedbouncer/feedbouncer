import { cn } from '../../lib/utils';

/**
 * Turns a plain `<ul>` of rows (members, brands, tags, invitations, …) into a bordered panel
 * with a card background and a hairline between rows, instead of a flat stack of text.
 */
function ListPanel({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      className={cn('flex flex-col divide-y divide-border rounded-lg border border-border bg-card', className)}
      {...props}
    />
  );
}

function ListRow({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      className={cn('flex flex-wrap items-center justify-between gap-3 p-(--fb-card-pad)', className)}
      {...props}
    />
  );
}

export { ListPanel, ListRow };
