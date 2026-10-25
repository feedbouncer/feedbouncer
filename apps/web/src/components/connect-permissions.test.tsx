import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectPermissions } from './connect-permissions';

const PERMISSIONS = [
  {
    scope: 'threads_basic',
    purpose: 'See your profile and list your posts, so FeedBouncer knows which posts to watch.',
    required: true,
  },
  {
    scope: 'threads_read_replies',
    purpose: 'Read replies to your posts, so your rules can check them. Required.',
    required: true,
  },
  {
    scope: 'threads_manage_replies',
    purpose:
      'Hide and unhide replies, and post replies, when your rules say so. Without it, rules can only flag replies for review.',
    required: false,
  },
  {
    scope: 'threads_content_publish',
    purpose: "Publish the replies your rules send. Without it, rules can't post replies.",
    required: false,
  },
];

describe('ConnectPermissions', () => {
  it('lists four Threads permissions with purposes; two marked Required', () => {
    const html = renderToStaticMarkup(<ConnectPermissions permissions={PERMISSIONS} />);
    expect(html.match(/<li/g)).toHaveLength(4);
    for (const p of PERMISSIONS) {
      expect(html).toContain(p.scope);
      expect(html).toContain(p.purpose.replace(/'/g, '&#x27;'));
    }
    expect(html.match(/>Required</g)).toHaveLength(2);
    expect(html.match(/>Optional</g)).toHaveLength(2);
  });

  it('renders nothing when the platform has no permission choices', () => {
    expect(renderToStaticMarkup(<ConnectPermissions permissions={[]} />)).toBe('');
  });

  it('renders server text as text', () => {
    const html = renderToStaticMarkup(
      <ConnectPermissions
        permissions={[{ scope: 'x', purpose: '<img src=x onerror=alert(1)>', required: false }]}
      />,
    );
    expect(html).not.toContain('<img');
  });
});
