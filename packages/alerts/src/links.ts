const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

function id(v: string): string {
  if (!UUID.test(v)) throw new TypeError('invalid id');
  return v.toLowerCase();
}

function iso(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid date');
  return d.toISOString();
}

function token(v: string): string {
  if (!TOKEN.test(v)) throw new TypeError('invalid token');
  return v;
}

export function spikeLink(web: URL, orgId: string, brandId: string, from: Date, to: Date): string {
  return `${web.origin}/orgs/${id(orgId)}/comments?brand=${id(brandId)}&signal=negative&from=${iso(from)}&to=${iso(to)}&queue=all`;
}

export function reviewLink(web: URL, orgId: string, brandId: string): string {
  return `${web.origin}/orgs/${id(orgId)}/brands/${id(brandId)}/review`;
}

export function settingsLink(web: URL, orgId: string, brandId?: string): string {
  const org = `${web.origin}/orgs/${id(orgId)}`;
  return brandId === undefined ? `${org}/alerts` : `${org}/brands/${id(brandId)}/alerts`;
}

export function confirmLink(web: URL, t: string): string {
  return `${web.origin}/alerts/confirm?token=${token(t)}`;
}

export function unsubscribeLink(web: URL, t: string): string {
  return `${web.origin}/alerts/unsubscribe?token=${token(t)}`;
}

export function unsubscribeApiUrl(web: URL, t: string): string {
  return `${web.origin}/api/v1/alert-recipients/unsubscribe?token=${token(t)}`;
}
