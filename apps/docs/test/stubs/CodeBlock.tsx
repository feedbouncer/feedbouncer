import type { ReactNode } from 'react';

export default function CodeBlock({ children }: { children: string }): ReactNode {
  return (
    <pre>
      <code>{children}</code>
    </pre>
  );
}
