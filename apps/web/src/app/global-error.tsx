'use client';

import { ErrorFallback } from '../components/states';
import './globals.css';

export default function GlobalError(props: Parameters<typeof ErrorFallback>[0]) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <main className="grid min-h-dvh place-items-center px-4">
          <ErrorFallback {...props} />
        </main>
      </body>
    </html>
  );
}
