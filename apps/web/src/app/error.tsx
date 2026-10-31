'use client';

import { StandaloneShell } from '../components/shell/standalone-shell';
import { ErrorFallback } from '../components/states';

export default function RootError(props: Parameters<typeof ErrorFallback>[0]) {
  return (
    <StandaloneShell>
      <main>
        <ErrorFallback {...props} />
      </main>
    </StandaloneShell>
  );
}
