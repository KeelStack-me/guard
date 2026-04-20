import type { BudgetStore, BudgetState } from "./types.js";

/**
 * MemoryBudgetStore — zero-config per-user spend tracking.
 *
 * Resets automatically every `windowMs` (default: 24 hours).
 * For multi-instance deployments, swap for a Redis-backed store.
 */
export class MemoryBudgetStore implements BudgetStore {
  private readonly store = new Map<string, BudgetState>();
  private readonly windowMs: number;

  constructor(windowMs = 24 * 60 * 60 * 1_000) {
    this.windowMs = windowMs;
  }

  async get(id: string): Promise<BudgetState | undefined> {
    const state = this.store.get(id);
    if (!state) return undefined;

    // Reset window if expired
    if (Date.now() - state.windowStart > this.windowMs) {
      const reset: BudgetState = {
        id,
        currentSpend: 0,
        limitUsd: state.limitUsd,
        windowStart: Date.now(),
      };
      this.store.set(id, reset);
      return reset;
    }

    return state;
  }

  async set(id: string, state: BudgetState): Promise<void> {
    this.store.set(id, state);
  }

  async record(id: string, costUsd: number): Promise<BudgetState> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(
        `[keelstack/guard] BudgetStore.record: no state found for id "${id}". ` +
          `Call set() to initialise the budget before recording spend.`
      );
    }
    const updated: BudgetState = {
      ...existing,
      currentSpend: existing.currentSpend + costUsd,
    };
    this.store.set(id, updated);
    return updated;
  }

  /** Clears all budget state. Useful in tests. */
  async clear(): Promise<void> {
    this.store.clear();
  }
}

export const defaultBudgetStore = new MemoryBudgetStore();
