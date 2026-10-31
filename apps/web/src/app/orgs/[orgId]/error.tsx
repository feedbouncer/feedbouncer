'use client';

import { ErrorPanel } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function OrgError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <Card className="max-w-form">
        <CardContent className="flex flex-col gap-4">
          <ErrorPanel title="Something went wrong">
            {error.digest ? <p className="text-small text-dim">Reference: {error.digest}</p> : null}
          </ErrorPanel>
          <div>
            <Button onClick={reset}>Try again</Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
