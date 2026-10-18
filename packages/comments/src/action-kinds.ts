export const ACTION_KINDS = [
  'hide',
  'unhide',
  'delete',
  'ban_author',
  'unban_author',
  'public_reply',
  'private_reply',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type ActionActor =
  | { type: 'user'; userId: string }
  | { type: 'api_key'; apiKeyId: string }
  | { type: 'rule'; ruleId: string }
  | { type: 'classifier' }
  | { type: 'policy' }
  | { type: 'system' };

export const AUTHOR_KINDS: ReadonlySet<ActionKind> = new Set(['ban_author', 'unban_author']);
