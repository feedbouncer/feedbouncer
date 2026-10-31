import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StandaloneShell } from '@/components/shell/standalone-shell';

export default function NotFound() {
  return (
    <StandaloneShell>
      <Card className="mx-auto max-w-form">
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
          <CardDescription>This link may be wrong or out of date.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/">Go to start</Link>
        </CardContent>
      </Card>
    </StandaloneShell>
  );
}
