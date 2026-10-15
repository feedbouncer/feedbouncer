import type { Evidence } from '../types.js';
import type { CommentView } from '../view.js';

export interface Budget {
  now(): number;
  startedAt: number;
  limitMs: number;
}
export type Matcher = (v: CommentView, budget: Budget) => Evidence | null | 'timeout';
