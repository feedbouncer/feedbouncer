import type { ReactNode } from 'react';
import { AuthShell } from '@/components/shell/auth-shell';

export default function Layout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
