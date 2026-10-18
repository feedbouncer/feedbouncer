import type { ReactNode } from 'react';
import { BetaNotice } from '../components/beta-notice';

export const metadata = { title: 'FeedBouncer' };
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BetaNotice />
        {children}
      </body>
    </html>
  );
}
