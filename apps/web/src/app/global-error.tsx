'use client';

import { ErrorPanel } from '@/components/states';
import { Button } from '@/components/ui/button';
import './globals.css';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <main className="mx-auto flex min-h-dvh w-full max-w-form flex-col justify-center gap-4 px-4">
          <ErrorPanel title="Something went wrong">
            {error.digest ? <p className="text-small text-dim">Reference: {error.digest}</p> : null}
          </ErrorPanel>
          <div>
            <Button onClick={reset}>Try again</Button>
          </div>
        </main>
      </body>
    </html>
  );
}
