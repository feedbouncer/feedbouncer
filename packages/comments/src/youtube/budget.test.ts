import { describe, expect, it } from 'vitest';
import { budgetView, nextReadDelayMs, readReserve, type BudgetInputs } from './budget.js';

const inputs = (o: Partial<BudgetInputs> = {}): BudgetInputs => ({
  budgetUnits: 2000,
  spentUnits: 0,
  readsSpentUnits: 0,
  projectCapUnits: 9000,
  projectSpentUnits: 0,
  paused: false,
  msUntilReset: 3_600_000,
  ...o,
});

describe('readReserve', () => {
  it('is max(100, 15%) capped at the budget', () => {
    expect(readReserve(2000)).toBe(300);
    expect(readReserve(100)).toBe(100);
    expect(readReserve(40)).toBe(40);
  });
});

describe('budgetView', () => {
  it('keeps the unspent read reserve out of the write allowance', () => {
    const v = budgetView(inputs({ spentUnits: 550, readsSpentUnits: 40, projectSpentUnits: 550 }));
    expect(v.remainingUnits).toBe(1450);
    expect(v.readReserveUnits).toBe(300);
    expect(v.readReserveRemaining).toBe(260);
    expect(v.writeAllowanceUnits).toBe(1190);
    expect(v.affordableBatches).toBe(23);
    expect(v.mode).toBe('active');
  });

  it('budget lowered below spend', () => {
    const v = budgetView(inputs({ budgetUnits: 300, spentUnits: 550, projectSpentUnits: 550 }));
    expect(v.remainingUnits).toBe(0);
    expect(v.writeAllowanceUnits).toBe(0);
    expect(v.mode).toBe('exhausted');
  });

  it('a zero budget is disabled, even when paused', () => {
    expect(budgetView(inputs({ budgetUnits: 0 })).mode).toBe('disabled');
    expect(budgetView(inputs({ budgetUnits: 0, paused: true })).mode).toBe('disabled');
  });

  it('paused wins over exhausted', () => {
    expect(budgetView(inputs({ paused: true })).mode).toBe('paused');
    expect(budgetView(inputs({ paused: true, spentUnits: 5000 })).mode).toBe('paused');
  });

  it('the project cap limits the connection', () => {
    const v = budgetView(inputs({ spentUnits: 550, readsSpentUnits: 40, projectSpentUnits: 8950 }));
    expect(v.remainingUnits).toBe(50);
    expect(v.writeAllowanceUnits).toBe(0);
    expect(v.mode).toBe('read_only');
  });

  it('a budget below one batch plus the reserve is read_only', () => {
    expect(budgetView(inputs({ budgetUnits: 150 })).mode).toBe('read_only');
    expect(budgetView(inputs({ budgetUnits: 151 })).mode).toBe('active');
  });
});

describe('nextReadDelayMs', () => {
  it('spreads the read allowance over the rest of the day', () => {
    expect(
      nextReadDelayMs({ readAllowanceUnits: 260, unitsPerPoll: 2, msUntilReset: 46_800_000 }),
    ).toBe(360_000);
  });
  it('waits for the reset when one poll is not affordable', () => {
    expect(nextReadDelayMs({ readAllowanceUnits: 1, unitsPerPoll: 2, msUntilReset: 5_000 })).toBe(
      5_000,
    );
  });
  it('clamps to the base and maximum intervals', () => {
    expect(
      nextReadDelayMs({ readAllowanceUnits: 1e6, unitsPerPoll: 2, msUntilReset: 46_800_000 }),
    ).toBe(300_000);
    expect(
      nextReadDelayMs({ readAllowanceUnits: 2, unitsPerPoll: 2, msUntilReset: 46_800_000 }),
    ).toBe(3_600_000);
  });
});
