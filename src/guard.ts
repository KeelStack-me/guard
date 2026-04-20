import type {
  GuardOptions,
  GuardResult,
  LedgerEntry,
  RiskInfo,
  RiskPolicy,
  FailurePolicy,
} from "./types.js";
import { defaultLedger } from "./ledger.js";
import { defaultBudgetStore } from "./budget-store.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const DEFAULT_WARN_AT = [0.5, 0.8];
const DEFAULT_RISK_POLICIES: Record<string, RiskPolicy> = {
  safe: "allow",
  reversible: "log",
  irreversible: "warn",
};
const DEFAULT_FAILURE_POLICY: FailurePolicy = "retry";

// Process-local reservation map to avoid concurrent same-key double execution.
const inFlight = new Map<string, Promise<GuardResult<unknown>>>();

/**
 * guard() — the single entry point for KeelStack Guard.
 *
 * Wraps any async action with:
 *  1. Idempotency — duplicate retries replay stored results for the same `key`.
 *  2. Budget enforcement — blocks the action if per-user spend is exceeded.
 *  3. Risk gating — emits risk metadata and can warn or block.
 *  4. Failure policy — retry by default, or run compensation hooks.
 *
 * @example — Basic idempotency
 * ```ts
 * const result = await guard({
 *   key: `send-email:${userId}:${taskId}`,
 *   action: () => resend.emails.send({ to: user.email, subject: 'Welcome' }),
 * });
 * if (result.fromCache) console.log('Duplicate call — email NOT sent again');
 * ```
 *
 * @example — With budget enforcement
 * ```ts
 * const result = await guard({
 *   key: `ai-call:${userId}:${requestId}`,
 *   action: () => openai.chat.completions.create({ ... }),
 *   budget: { id: userId, limitUsd: 2.00 },
 *   extractCost: (res) => (res.usage.total_tokens / 1_000_000) * 15,
 * });
 * if (result.status === 'blocked:budget') {
 *   return { error: 'Daily AI budget exceeded', ...result.budgetInfo };
 * }
 * ```
 *
 * @example — With risk gating
 * ```ts
 * const result = await guard({
 *   key: `delete-user:${userId}`,
 *   action: () => db.users.delete({ where: { id: userId } }),
 *   risk: { level: 'irreversible', policy: 'block' },
 * });
 * if (result.status === 'blocked:risk') {
 *   return { error: 'Action blocked by risk policy' };
 * }
 * ```
 */
export async function guard<T>(options: GuardOptions<T>): Promise<GuardResult<T>> {
  const {
    key,
    action,
    ttlMs = DEFAULT_TTL_MS,
    budget,
    extractCost,
    risk,
    failure,
    ledger = defaultLedger,
    budgetStore = defaultBudgetStore,
  } = options;

  if (!key || key.trim() === "") {
    throw new TypeError("[keelstack/guard] `key` must be a non-empty string.");
  }
  if (typeof action !== "function") {
    throw new TypeError("[keelstack/guard] `action` must be a function.");
  }

  // ── 1. Replay if we already have a stored result ─────────────────────────
  const existing = await ledger.get(key);
  if (existing) {
    return replayFromEntry<T>(existing, ledger);
  }

  // ── 2. Join active same-key execution (process-local reservation) ────────
  const pending = inFlight.get(key) as Promise<GuardResult<T>> | undefined;
  if (pending) {
    const pendingResult = await pending;
    if (pendingResult.status === "executed" || pendingResult.status === "replayed") {
      const after = await ledger.get(key);
      if (after) {
        return replayFromEntry<T>(after, ledger);
      }
    }
    return pendingResult;
  }

  // Create a reservation before running checks + action so concurrent calls join.
  const task = runGuardCore<T>({
    key,
    action,
    ttlMs,
    budget,
    extractCost,
    risk,
    failure,
    ledger,
    budgetStore,
  });
  inFlight.set(key, task as Promise<GuardResult<unknown>>);

  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

async function runGuardCore<T>(options: {
  key: string;
  action: () => Promise<T>;
  ttlMs: number;
  budget: GuardOptions<T>["budget"] | undefined;
  extractCost: GuardOptions<T>["extractCost"] | undefined;
  risk: GuardOptions<T>["risk"] | undefined;
  failure: GuardOptions<T>["failure"] | undefined;
  ledger: NonNullable<GuardOptions<T>["ledger"]>;
  budgetStore: NonNullable<GuardOptions<T>["budgetStore"]>;
}): Promise<GuardResult<T>> {
  const {
    key,
    action,
    ttlMs,
    budget,
    extractCost,
    risk,
    failure,
    ledger,
    budgetStore,
  } = options;
  const effectiveTtlMs = ttlMs ?? DEFAULT_TTL_MS;

  // ── Budget check (before running the action) ─────────────────────────────
  if (budget) {
    let budgetState = await budgetStore.get(budget.id);

    if (!budgetState) {
      // First time we've seen this budget ID — initialise it
      budgetState = {
        id: budget.id,
        currentSpend: 0,
        limitUsd: budget.limitUsd,
        windowStart: Date.now(),
      };
      await budgetStore.set(budget.id, budgetState);
    }

    const percentUsed = budgetState.currentSpend / budget.limitUsd;

    // Fire warnings for crossed thresholds
    const thresholds = budget.warnAt ?? DEFAULT_WARN_AT;
    for (const threshold of thresholds) {
      if (percentUsed >= threshold && budget.onWarn) {
        await Promise.resolve(
          budget.onWarn({
            id: budget.id,
            threshold,
            currentSpend: budgetState.currentSpend,
            limitUsd: budget.limitUsd,
            percentUsed,
          })
        );
      }
    }

    // Hard block at 100%
    if (budgetState.currentSpend >= budget.limitUsd) {
      return {
        status: "blocked:budget",
        fromCache: false,
        replayCount: 0,
        budgetInfo: {
          id: budget.id,
          spent: budgetState.currentSpend,
          limit: budget.limitUsd,
          percentUsed,
        },
      };
    }
  }

  // ── Risk gate check ───────────────────────────────────────────────────────
  if (risk) {
    const policy: RiskPolicy =
      risk.policy ?? DEFAULT_RISK_POLICIES[risk.level] ?? "allow";

    const riskInfo: RiskInfo = {
      key,
      level: risk.level,
      policy,
      blocked: policy === "block",
    };

    if (risk.onRisk) {
      await Promise.resolve(risk.onRisk(riskInfo));
    }

    if (policy === "block") {
      return {
        status: "blocked:risk",
        fromCache: false,
        replayCount: 0,
        riskInfo,
      };
    }

    if (policy === "warn") {
      console.warn(
        `[keelstack/guard] Risk warning: key="${key}" level="${risk.level}" policy="${policy}"`
      );
    }
  }

  // ── Execute the action ────────────────────────────────────────────────────
  let result: T;
  try {
    result = await action();
  } catch (error) {
    const failurePolicy = failure?.policy ?? DEFAULT_FAILURE_POLICY;
    if (failurePolicy === "compensate" && failure?.onError) {
      await Promise.resolve(
        failure.onError({
          key,
          error,
          policy: failurePolicy,
        })
      );
    }
    throw error;
  }

  // ── Store the result in the ledger ────────────────────────────────────────
  const now = Date.now();
  const entry: LedgerEntry<T> = {
    key,
    result,
    storedAt: now,
    expiresAt: effectiveTtlMs > 0 ? now + effectiveTtlMs : 0,
    replayCount: 0,
  };
  await ledger.set(key, entry as LedgerEntry);

  // ── Record cost if budget + extractor provided ────────────────────────────
  if (budget && extractCost) {
    const costUsd = extractCost(result);
    if (costUsd > 0) {
      await budgetStore.record(budget.id, costUsd);
    }
  }

  return {
    status: "executed",
    value: result,
    fromCache: false,
    replayCount: 0,
  };
}

async function replayFromEntry<T>(
  existing: LedgerEntry,
  ledger: NonNullable<GuardOptions<T>["ledger"]>
): Promise<GuardResult<T>> {
  const updated: LedgerEntry = {
    ...existing,
    replayCount: existing.replayCount + 1,
  };
  await ledger.set(existing.key, updated);

  return {
    status: "replayed",
    value: existing.result as T,
    fromCache: true,
    replayCount: updated.replayCount,
  };
}
