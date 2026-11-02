import type { ReactNode } from 'react';
import { ScanShell } from '../../components/shell/scan-shell';

export default function ScanLayout({ children }: { children: ReactNode }) {
  return <ScanShell>{children}</ScanShell>;
}
