import type { ReactNode } from 'react';

const LABELS = { partial: 'Partial', planned: 'Planned', unsupported: 'Not supported' } as const;

export type FeatureStatusKind = keyof typeof LABELS;

export default function FeatureStatus({
  status,
  children,
}: {
  status: FeatureStatusKind;
  children: ReactNode;
}): ReactNode {
  return (
    <aside
      role="note"
      className={`theme-admonition alert alert--${status === 'partial' ? 'warning' : 'info'} margin-bottom--md`}
    >
      <p>
        <strong>{LABELS[status]}</strong>
      </p>
      {children}
    </aside>
  );
}
