import type {
  AuthorityDecision,
  AuthorityRequest,
  AuthorityState,
  AuthorityStore,
} from "./types.js";

/**
 * Zero-config process-local authority/circuit-breaker store.
 * Shared production backends should make checkAndConsume atomic.
 */
export class MemoryAuthorityStore implements AuthorityStore {
  private readonly store = new Map<string, AuthorityState>();

  async get(id: string): Promise<AuthorityState | undefined> {
    return this.store.get(id);
  }

  async checkAndConsume(request: AuthorityRequest): Promise<AuthorityDecision> {
    const existing = this.store.get(request.id);
    const expired =
      !existing || request.now - existing.windowStart >= request.windowMs;

    const state: AuthorityState = expired
      ? {
          id: request.id,
          executions: 0,
          valueUsd: 0,
          windowStart: request.now,
          windowMs: request.windowMs,
        }
      : { ...existing, windowMs: request.windowMs };

    const projectedExecutions = state.executions + 1;
    const projectedValueUsd = state.valueUsd + request.valueUsd;

    if (
      request.maxExecutions !== undefined &&
      projectedExecutions > request.maxExecutions
    ) {
      this.store.set(request.id, state);
      return {
        allowed: false,
        reason: "max-executions",
        state,
        projectedExecutions,
        projectedValueUsd,
      };
    }

    if (
      request.maxValueUsd !== undefined &&
      projectedValueUsd > request.maxValueUsd
    ) {
      this.store.set(request.id, state);
      return {
        allowed: false,
        reason: "max-value-usd",
        state,
        projectedExecutions,
        projectedValueUsd,
      };
    }

    const consumed: AuthorityState = {
      ...state,
      executions: projectedExecutions,
      valueUsd: projectedValueUsd,
    };
    this.store.set(request.id, consumed);

    return {
      allowed: true,
      state: consumed,
      projectedExecutions,
      projectedValueUsd,
    };
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

export const defaultAuthorityStore = new MemoryAuthorityStore();
