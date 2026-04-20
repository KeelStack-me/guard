import type {
  GuardOptions,
  GuardResult,
  LedgerEntry,
  BudgetState,
  RiskInfo,
  RiskPolicy,
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

/**
 * guard() — the single entry point for KeelStack Guard.
 *
 * Wraps any async action with:
 *  1. Idempotency — the action runs at most once per unique `key`.
 *  2. Budget enforcement — blocks the action if per-user spend is exceeded.
 *  3. Risk gating — logs, warns, or blocks based on action risk level.
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
    ledger = defaultLedger,
    budgetStore = defaultBudgetStore,
  } = options;

  if (!key || key.trim() === "") {
    throw new TypeError("[keelstack/guard] `key` must be a non-empty string.");
  }
  if (typeof action !== "function") {
    throw new TypeError("[keelstack/guard] `action` must be a function.");
  }

  // ── 1. Idempotency check ──────────────────────────────────────────────────
  const existing = await ledger.get(key);
  if (existing) {
    // Increment replay counter
    const updated: LedgerEntry = {
      ...existing,
      replayCount: existing.replayCount + 1,
    };
    await ledger.set(key, updated);

    return {
      status: "replayed",
      value: existing.result as T,
      fromCache: true,
      replayCount: updated.replayCount,
    };
  }

  // ── 2. Budget check (before running the action) ───────────────────────────
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

  // ── 3. Risk gate check ────────────────────────────────────────────────────
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

  // ── 4. Execute the action ─────────────────────────────────────────────────
  const result = await action();

  // ── 5. Store the result in the ledger ─────────────────────────────────────
  const now = Date.now();
  const entry: LedgerEntry<T> = {
    key,
    result,
    storedAt: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    replayCount: 0,
  };
  await ledger.set(key, entry as LedgerEntry);

  // ── 6. Record cost if budget + extractor provided ─────────────────────────
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
