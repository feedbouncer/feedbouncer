import Link from 'next/link';

export function Wordmark({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="font-display text-brand tracking-brand font-bold text-foreground hover:text-coral hover:no-underline"
    >
      FeedBouncer
    </Link>
  );
}
