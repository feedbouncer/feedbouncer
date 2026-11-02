import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-ui font-semibold whitespace-nowrap duration-(--fb-dur-hover) ease-fb motion-safe:transition-[color,background-color,border-color,transform] motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-(--fb-scale-press) disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        /** The one primary action on a page or card; the website's coral pill. */
        default:
          'rounded-full border-primary bg-primary text-primary-foreground hover:border-coral-hover hover:bg-coral-hover',
        /** The common case: an action next to (or inline with) the field it affects. */
        secondary: 'border-border bg-elevated text-foreground hover:bg-accent',
        outline:
          'border-input bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        /** A dangerous or irreversible action (archive, remove, delete, leave). */
        destructive: 'border-danger/40 bg-danger/12 text-danger hover:bg-danger/20',
        /** A tertiary action with no border or fill, e.g. inside a table row. */
        ghost: 'border-transparent bg-transparent text-foreground hover:bg-accent',
      },
      size: {
        sm: 'min-h-8 px-3 py-1.5 text-small has-[>svg]:px-2.5',
        default: 'min-h-10 px-4.5 py-2.5 has-[>svg]:px-3',
        lg: 'min-h-12 px-6 py-3 has-[>svg]:px-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
