// Pure budget math for one YouTube connection's Pacific day. Every call must fit
// both the connection's owner-set budget and the deployment's project cap; writes
// may never consume the unspent read reserve.
import { BATCH_UNITS } from '@feedbouncer/connector-youtube';

const BASE_READ_INTERVAL_MS = 300_000;
const MAX_READ_INTERVAL_MS = 3_600_000;

export interface BudgetInputs {
  budgetUnits: number;
  spentUnits: number;
  readsSpentUnits: number;
  projectCapUnits: number;
  projectSpentUnits: number;
  paused: boolean;
  msUntilReset: number;
}

export type BudgetMode = 'disabled' | 'paused' | 'exhausted' | 'read_only' | 'active';

export interface BudgetView {
  mode: BudgetMode;
  remainingUnits: number;
  readReserveUnits: number;
  readReserveRemaining: number;
  writeAllowanceUnits: number;
  affordableBatches: number;
}

/** max(100, ceil(15% of the budget)), never more than the budget. */
export function readReserve(budgetUnits: number): number {
  return Math.min(budgetUnits, Math.max(100, Math.ceil(0.15 * budgetUnits)));
}

export function budgetView(i: BudgetInputs): BudgetView {
  const remainingUnits = Math.max(
    0,
    Math.min(i.budgetUnits - i.spentUnits, i.projectCapUnits - i.projectSpentUnits),
  );
  const readReserveUnits = readReserve(i.budgetUnits);
  const readReserveRemaining = Math.max(0, readReserveUnits - i.readsSpentUnits);
  const writeAllowanceUnits = Math.max(0, remainingUnits - readReserveRemaining);
  const affordableBatches = Math.floor(writeAllowanceUnits / BATCH_UNITS);
  const mode: BudgetMode =
    i.budgetUnits === 0
      ? 'disabled'
      : i.paused
        ? 'paused'
        : remainingUnits < 1
          ? 'exhausted'
          : affordableBatches === 0
            ? 'read_only'
            : 'active';
  return {
    mode,
    remainingUnits,
    readReserveUnits,
    readReserveRemaining,
    writeAllowanceUnits,
    affordableBatches,
  };
}

/** Spread the remaining read allowance evenly until the reset, within the poll interval bounds. */
export function nextReadDelayMs(i: {
  readAllowanceUnits: number;
  unitsPerPoll: number;
  msUntilReset: number;
}): number {
  if (i.readAllowanceUnits < i.unitsPerPoll) return i.msUntilReset;
  const polls = Math.floor(i.readAllowanceUnits / i.unitsPerPoll);
  return Math.min(
    MAX_READ_INTERVAL_MS,
    Math.max(BASE_READ_INTERVAL_MS, Math.ceil(i.msUntilReset / polls)),
  );
}
