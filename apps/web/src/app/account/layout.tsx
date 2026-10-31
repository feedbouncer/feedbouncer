import type { ReactNode } from 'react';
import { StandaloneShell } from '../../components/shell/standalone-shell';

export default function Layout({ children }: { children: ReactNode }) {
  return <StandaloneShell>{children}</StandaloneShell>;
}
