import * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'min-h-10 w-full min-w-0 rounded-md border border-input bg-elevated px-3 py-2.5 text-ui text-foreground duration-(--fb-dur-hover) ease-fb placeholder:text-faint file:inline-flex file:border-0 file:bg-transparent file:text-ui file:font-semibold file:text-foreground focus-visible:border-coral disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger motion-safe:transition-[color,border-color]',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
