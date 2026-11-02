'use client';

import { ErrorFallback } from '../../components/states';

export default function ScanError(props: Parameters<typeof ErrorFallback>[0]) {
  return (
    <main>
      <ErrorFallback {...props} />
    </main>
  );
}
