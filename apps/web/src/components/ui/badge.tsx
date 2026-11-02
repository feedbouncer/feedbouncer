import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-caption font-semibold whitespace-nowrap duration-(--fb-dur-hover) ease-fb motion-safe:transition-[color,background-color,border-color] [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        good: 'border-good/40 bg-good/15 text-good',
        coral: 'bg-coral-dim text-coral-strong',
        danger: 'bg-danger/12 text-danger',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  },
);

function Badge({
  className,
  variant = 'secondary',
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
