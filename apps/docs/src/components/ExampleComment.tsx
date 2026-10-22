import type { ReactNode } from 'react';

export default function ExampleComment({
  text,
  mild = false,
}: {
  text: string;
  mild?: boolean;
}): ReactNode {
  return (
    <figure className="margin-bottom--md">
      <blockquote>{text}</blockquote>
      <figcaption>Invented example{mild ? ' (mild sample of abusive language)' : ''}</figcaption>
    </figure>
  );
}
