import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from './proxy';

describe('proxy', () => {
  it('drops every client-supplied forwarding header from the request it passes on', () => {
    const res = proxy(
      new NextRequest('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          cookie: 'fb.session_token=abc',
          'x-forwarded-for': '6.6.6.6',
          'x-forwarded-proto': 'https',
          'x-real-ip': '6.6.6.6',
          forwarded: 'for=6.6.6.6',
        },
      }),
    );
    // Next applies exactly the headers listed here to the request and deletes the rest.
    const kept = (res.headers.get('x-middleware-override-headers') ?? '').split(',');
    expect(kept).toContain('cookie');
    for (const h of ['x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'forwarded']) {
      expect(kept, h).not.toContain(h);
    }
  });

  it('runs for the proxied API paths', () => {
    expect(config.matcher).toEqual(['/api/auth/:path*', '/api/v1/:path*', '/v1/:path*']);
  });
});
