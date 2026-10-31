'use client';

import { StandaloneShell } from '@/components/shell/standalone-shell';
import { ErrorPanel } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StandaloneShell>
      <main>
        <Card className="mx-auto max-w-form">
          <CardContent className="flex flex-col gap-4">
            <ErrorPanel title="Something went wrong">
              {error.digest ? (
                <p className="text-small text-dim">Reference: {error.digest}</p>
              ) : null}
            </ErrorPanel>
            <div>
              <Button onClick={reset}>Try again</Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </StandaloneShell>
  );
}
