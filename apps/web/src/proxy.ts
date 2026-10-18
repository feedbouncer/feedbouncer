import { NextResponse, type NextRequest } from 'next/server';

// Headers a client could use to claim a different address or origin. Removing
// them here makes Next set X-Forwarded-For to the real TCP peer before the API
// route handlers run (it only fills the header in when it is absent); see
// src/lib/api-proxy.ts.
const CLIENT_FORWARDING = /^(?:forwarded|x-real-ip|x-forwarded-.*)$/;

export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!CLIENT_FORWARDING.test(name)) headers.set(name, value);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/api/auth/:path*', '/api/v1/:path*', '/v1/:path*'] };
