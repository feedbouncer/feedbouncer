import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Slot } from '@radix-ui/react-slot';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-ui font-semibold whitespace-nowrap duration-(--fb-dur-hover) ease-fb motion-safe:transition-[color,background-color,border-color,transform] motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-(--fb-scale-press) disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'rounded-full border-primary bg-primary text-primary-foreground hover:border-coral-hover hover:bg-coral-hover',
        destructive: 'border-destructive bg-destructive text-on-coral hover:bg-destructive/90',
        outline:
          'border-input bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        secondary:
          'rounded-full border-secondary bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'rounded-full border-border bg-transparent text-foreground hover:border-faint',
        link: 'bg-transparent text-coral underline-offset-4 hover:underline',
      },
      size: {
        default: 'min-h-10 px-4.5 py-2.5 has-[>svg]:px-3',
        sm: 'min-h-8 gap-1.5 px-3 py-1.5 text-small has-[>svg]:px-2.5',
        lg: 'min-h-12 px-6 py-3 has-[>svg]:px-4',
        icon: 'size-10 p-0',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'min-h-0 px-0 py-0 has-[>svg]:px-0' }],
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
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
