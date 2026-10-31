import type { ReactNode } from 'react';
import { BetaNotice } from '../components/beta-notice';
import { cn } from '../lib/utils';
import { body, display } from './fonts';
import './globals.css';

export const metadata = { title: 'FeedBouncer' };
export const viewport = { colorScheme: 'dark', themeColor: '#0b0e14' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn('dark', display.variable, body.variable)}>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <BetaNotice />
        {children}
      </body>
    </html>
  );
}
