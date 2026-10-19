export type BaseUrlResult = { ok: true; url: string } | { ok: false; message: string };

const fail = (message: string): BaseUrlResult => ({ ok: false, message });

export function normalizeBaseUrl(raw: string, allowHttp: boolean): BaseUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return fail('Enter the address of your FeedBouncer, for example https://feedbouncer.acme.io.');
  }

  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    return fail(
      'The FeedBouncer address must start with https://. To use http://, turn on Allow Plain HTTP.',
    );
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return fail('Remove the user name, password, query or # part from the FeedBouncer address.');
  }

  const path = parsed.pathname.replace(/\/+/g, '/').replace(/\/$/, '').replace(/\/v1$/, '');
  return { ok: true, url: parsed.origin + path };
}
