// Page webhook subscriptions are per app, and Graph's POST replaces the app's
// whole `subscribed_fields` list. Facebook and Instagram connections can share
// one Page, so every change reads the current list and merges client-side.
// There is no compare-and-set on Graph, so two connections changing the same
// Page at once can overwrite each other: after each write the list is read
// again and the merge repeated (a bounded number of times) until this call's
// fields are in the state it asked for.
import { ConnectorError } from '@feedbouncer/connectors';
import { graphId, graphRequest, type GraphCall } from './graph.js';

const FIELD = /^[a-z][a-z_]{0,63}$/;
const MAX_WRITES = 3;
const pageNode = (n: string) => (n === 'me' ? 'me' : graphId(n));
const success = (body: unknown) => (body as { success?: unknown } | null)?.success === true;

function checkFields(fields: readonly string[]) {
  for (const f of fields)
    if (!FIELD.test(f)) throw new ConnectorError('permanent', 'invalid_field');
}

async function currentFields(call: GraphCall, node: string, appId: string): Promise<string[]> {
  const { body } = await graphRequest(call, { method: 'GET', path: [node, 'subscribed_apps'] });
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const mine = data.find(
    (a): a is { id: string; subscribed_fields?: unknown } =>
      typeof a === 'object' && a !== null && (a as { id?: unknown }).id === appId,
  );
  const fields = mine?.subscribed_fields;
  return Array.isArray(fields)
    ? fields.filter((x): x is string => typeof x === 'string' && FIELD.test(x))
    : [];
}

async function replaceFields(call: GraphCall, node: string, fields: readonly string[]) {
  const r = await graphRequest(call, {
    method: 'POST',
    path: [node, 'subscribed_apps'],
    form: { subscribed_fields: fields.join(',') },
  });
  if (!success(r.body)) throw new ConnectorError('transient', 'subscription_not_confirmed');
}

const notConverged = () => new ConnectorError('transient', 'subscription_not_converged');

/** Adds `fields` to this app's subscription on the Page (`node` = page id, or 'me' with a Page token). Idempotent. */
export async function subscribePageFields(
  call: GraphCall,
  node: string,
  appId: string,
  fields: readonly string[],
): Promise<{ fields: readonly string[] }> {
  checkFields(fields);
  const target = pageNode(node);
  for (let writes = 0; ; writes++) {
    const have = await currentFields(call, target, appId);
    const next = [...new Set([...have, ...fields])].sort();
    if (next.length === have.length) return { fields: next };
    if (writes === MAX_WRITES) throw notConverged();
    await replaceFields(call, target, next);
  }
}

/** Removes `fields`; DELETEs the subscription only if no field remains. Idempotent. */
export async function unsubscribePageFields(
  call: GraphCall,
  node: string,
  appId: string,
  fields: readonly string[],
): Promise<{ fields: readonly string[]; deleted: boolean }> {
  checkFields(fields);
  const target = pageNode(node);
  let deleted = false;
  for (let writes = 0; ; writes++) {
    const have = await currentFields(call, target, appId);
    const next = have.filter((f) => !fields.includes(f)).sort();
    if (next.length === have.length) return { fields: next, deleted: deleted && next.length === 0 };
    if (writes === MAX_WRITES) throw notConverged();
    if (next.length > 0) {
      await replaceFields(call, target, next);
      continue;
    }
    const r = await graphRequest(call, { method: 'DELETE', path: [target, 'subscribed_apps'] });
    if (!success(r.body)) throw new ConnectorError('transient', 'subscription_not_confirmed');
    deleted = true;
  }
}
