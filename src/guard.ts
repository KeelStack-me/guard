import type {
  ActionMetadata,
  ApprovalInfo,
  AuthorityInfo,
  DecisionReceipt,
  FailurePolicy,
  GuardOptions,
  GuardResult,
  GuardResultStatus,
  LedgerEntry,
  RiskInfo,
  RiskPolicy,
} from "./types.js";
import { defaultLedger } from "./ledger.js";
import { defaultBudgetStore } from "./budget-store.js";
import { defaultAuthorityStore } from "./authority-store.js";
import { fingerprintIntent } from "./intent.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WARN_AT = [0.5, 0.8];
const DEFAULT_AUTHORITY_WINDOW_MS = 60 * 1_000;
const DEFAULT_RISK_POLICIES: Record<string, RiskPolicy> = {
  safe: "allow",
  reversible: "log",
  irreversible: "warn",
};
const DEFAULT_FAILURE_POLICY: FailurePolicy = "retry";

interface InFlightEntry {
  intentHash: string;
  promise: Promise<GuardResult<unknown>>;
}

// Process-local same-key reservation. Crucially, the reservation is bound to
// the action intent too: same key + different arguments is a conflict, not a join.
const inFlight = new Map<string, InFlightEntry>();

// Process-local estimated-cost reservations prevent concurrent calls in the same
// process from all passing the same budget check before any of them records cost.
const budgetReservations = new Map<string, number>();

/**
 * Guard an agent side effect at the last responsible moment before execution.
 *
 * Protection order:
 *  1. Intent-bound idempotency
 *  2. Budget preflight
 *  3. Risk policy
 *  4. Human/system approval
 *  5. Scoped authority / circuit breaker
 *  6. Execute + persist result + cost
 */
export async function guard<T>(options: GuardOptions<T>): Promise<GuardResult<T>> {
  const {
    key,
    action,
    intent,
    metadata,
    ttlMs = DEFAULT_TTL_MS,
    budget,
    extractCost,
    risk,
    approval,
    authority,
    failure,
    ledger = defaultLedger,
    budgetStore = defaultBudgetStore,
    authorityStore = defaultAuthorityStore,
    onDecision,
  } = options;

  if (!key || key.trim() === "") {
    throw new TypeError("[keelstack/guard] `key` must be a non-empty string.");
  }
  if (typeof action !== "function") {
    throw new TypeError("[keelstack/guard] `action` must be a function.");
  }
  if (ttlMs < 0 || !Number.isFinite(ttlMs)) {
    throw new TypeError("[keelstack/guard] `ttlMs` must be a finite number >= 0.");
  }

  validateBudget(budget);
  validateAuthority(authority);

  // Even legacy calls get a stable fingerprint. Passing `intent` upgrades this
  // from key-binding to exact tool-name/argument binding.
  const intentHash = await fingerprintIntent(intent === undefined ? { key } : intent);

  // ── 1. Replay only when key AND intent agree ──────────────────────────────
  const existing = await ledger.get(key);
  if (existing) {
    if (existing.intentHash && existing.intentHash !== intentHash) {
      return finalize<T>(
        {
          status: "blocked:intent-conflict",
          fromCache: false,
          replayCount: existing.replayCount,
          intentConflict: {
            key,
            storedIntentHash: existing.intentHash,
            receivedIntentHash: intentHash,
          },
        },
        { key, intentHash, metadata, reason: "same key was reused for a different action intent", onDecision }
      );
    }
    return replayFromEntry<T>(existing, ledger, {
      key,
      intentHash,
      metadata,
      onDecision,
    });
  }

  // ── 2. Join same key only when intent also matches ────────────────────────
  const pending = inFlight.get(key);
  if (pending) {
    if (pending.intentHash !== intentHash) {
      return finalize<T>(
        {
          status: "blocked:intent-conflict",
          fromCache: false,
          replayCount: 0,
          intentConflict: {
            key,
            storedIntentHash: pending.intentHash,
            receivedIntentHash: intentHash,
          },
        },
        { key, intentHash, metadata, reason: "concurrent call reused the key with a different intent", onDecision }
      );
    }

    const pendingResult = (await pending.promise) as GuardResult<T>;
    if (pendingResult.status === "executed" || pendingResult.status === "replayed") {
      const after = await ledger.get(key);
      if (after) {
        return replayFromEntry<T>(after, ledger, {
          key,
          intentHash,
          metadata,
          onDecision,
        });
      }
    }
    return pendingResult;
  }

  const task = runGuardCore<T>({
    key,
    action,
    intentHash,
    intent,
    metadata,
    ttlMs,
    budget,
    extractCost,
    risk,
    approval,
    authority,
    failure,
    ledger,
    budgetStore,
    authorityStore,
    onDecision,
  });

  inFlight.set(key, { intentHash, promise: task as Promise<GuardResult<unknown>> });

  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

async function runGuardCore<T>(options: {
  key: string;
  action: () => Promise<T>;
  intentHash: string;
  intent: GuardOptions<T>["intent"];
  metadata: GuardOptions<T>["metadata"];
  ttlMs: number;
  budget: GuardOptions<T>["budget"];
  extractCost: GuardOptions<T>["extractCost"];
  risk: GuardOptions<T>["risk"];
  approval: GuardOptions<T>["approval"];
  authority: GuardOptions<T>["authority"];
  failure: GuardOptions<T>["failure"];
  ledger: NonNullable<GuardOptions<T>["ledger"]>;
  budgetStore: NonNullable<GuardOptions<T>["budgetStore"]>;
  authorityStore: NonNullable<GuardOptions<T>["authorityStore"]>;
  onDecision: GuardOptions<T>["onDecision"];
}): Promise<GuardResult<T>> {
  const {
    key,
    action,
    intentHash,
    intent,
    metadata,
    ttlMs,
    budget,
    extractCost,
    risk,
    approval,
    authority,
    failure,
    ledger,
    budgetStore,
    authorityStore,
    onDecision,
  } = options;

  // ── Budget preflight ──────────────────────────────────────────────────────
  if (budget) {
    const state = await getOrInitBudgetState(budgetStore, budget.id, budget.limitUsd);
    const reserved = budgetReservations.get(budget.id) ?? 0;
    const estimate = budget.estimatedCostUsd ?? 0;
    const projectedSpend = state.currentSpend + reserved + estimate;
    const percentUsed = state.currentSpend / budget.limitUsd;
    const projectedPercent = projectedSpend / budget.limitUsd;

    const thresholds = budget.warnAt ?? DEFAULT_WARN_AT;
    for (const threshold of thresholds) {
      if (projectedPercent >= threshold && budget.onWarn) {
        const info = {
          id: budget.id,
          threshold,
          currentSpend: state.currentSpend,
          limitUsd: budget.limitUsd,
          percentUsed,
          ...(estimate > 0 ? { projectedSpend } : {}),
        };
        await Promise.resolve(budget.onWarn(info));
      }
    }

    if (state.currentSpend >= budget.limitUsd || projectedSpend > budget.limitUsd) {
      return finalize<T>(
        {
          status: "blocked:budget",
          fromCache: false,
          replayCount: 0,
          budgetInfo: {
            id: budget.id,
            spent: state.currentSpend,
            limit: budget.limitUsd,
            percentUsed,
            ...(estimate > 0 ? { projectedSpend } : {}),
          },
        },
        {
          key,
          intentHash,
          metadata,
          reason:
            estimate > 0
              ? "projected action cost would exceed the budget"
              : "budget is exhausted",
          onDecision,
        }
      );
    }
  }

  // ── Risk gate ─────────────────────────────────────────────────────────────
  if (risk) {
    const policy: RiskPolicy =
      risk.policy ?? DEFAULT_RISK_POLICIES[risk.level] ?? "allow";

    const riskInfo: RiskInfo = {
      key,
      level: risk.level,
      policy,
      blocked: policy === "block",
    };

    if (risk.onRisk) await Promise.resolve(risk.onRisk(riskInfo));

    if (policy === "block") {
      return finalize<T>(
        {
          status: "blocked:risk",
          fromCache: false,
          replayCount: 0,
          riskInfo,
        },
        { key, intentHash, metadata, reason: `risk policy blocked ${risk.level} action`, onDecision }
      );
    }

    if (policy === "warn") {
      console.warn(
        `[keelstack/guard] Risk warning: key="${key}" level="${risk.level}" policy="${policy}"`
      );
    }
  }

  // ── Framework-neutral approval handoff ───────────────────────────────────
  let approvedInfo: ApprovalInfo | undefined;
  if (approval) {
    const context = {
      key,
      intentHash,
      ...(intent !== undefined ? { intent } : {}),
      ...(metadata ? { metadata } : {}),
    };
    const required =
      typeof approval.required === "function"
        ? await Promise.resolve(approval.required(context))
        : approval.required;

    if (required) {
      const decision = approval.decision;

      if (!decision) {
        const approvalInfo: ApprovalInfo = {
          key,
          intentHash,
          required: true,
          status: "pending",
        };
        return finalize<T>(
          {
            status: "pending:approval",
            fromCache: false,
            replayCount: 0,
            approvalInfo,
          },
          { key, intentHash, metadata, reason: "action requires approval before execution", onDecision }
        );
      }

      if (decision.intentHash !== intentHash) {
        const approvalInfo: ApprovalInfo = {
          key,
          intentHash,
          required: true,
          status: "mismatch",
          ...(decision.by ? { by: decision.by } : {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
        };
        return finalize<T>(
          {
            status: "blocked:approval",
            fromCache: false,
            replayCount: 0,
            approvalInfo,
          },
          { key, intentHash, metadata, reason: "approval was issued for a different action intent", onDecision }
        );
      }

      if (decision.status === "denied") {
        const approvalInfo: ApprovalInfo = {
          key,
          intentHash,
          required: true,
          status: "denied",
          ...(decision.by ? { by: decision.by } : {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
        };
        return finalize<T>(
          {
            status: "blocked:approval",
            fromCache: false,
            replayCount: 0,
            approvalInfo,
          },
          { key, intentHash, metadata, reason: decision.reason ?? "approval denied", onDecision }
        );
      }

      approvedInfo = {
        key,
        intentHash,
        required: true,
        status: "approved",
        ...(decision.by ? { by: decision.by } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
    }
  }

  // ── Reserve estimated budget immediately before execution ────────────────
  // Do this after approval but before consuming authority, so a concurrent
  // budget race cannot burn an authority slot for an action that never ran.
  const budgetEstimate = budget?.estimatedCostUsd ?? 0;
  let budgetReserved = false;
  if (budget && budgetEstimate > 0) {
    const fresh = await getOrInitBudgetState(budgetStore, budget.id, budget.limitUsd);
    const alreadyReserved = budgetReservations.get(budget.id) ?? 0;
    const projected = fresh.currentSpend + alreadyReserved + budgetEstimate;
    if (projected > budget.limitUsd) {
      return finalize<T>(
        {
          status: "blocked:budget",
          fromCache: false,
          replayCount: 0,
          budgetInfo: {
            id: budget.id,
            spent: fresh.currentSpend,
            limit: budget.limitUsd,
            percentUsed: fresh.currentSpend / budget.limitUsd,
            projectedSpend: projected,
          },
          ...(approvedInfo ? { approvalInfo: approvedInfo } : {}),
        },
        { key, intentHash, metadata, reason: "concurrent projected spend would exceed the budget", onDecision }
      );
    }
    budgetReservations.set(budget.id, alreadyReserved + budgetEstimate);
    budgetReserved = true;
  }

  // ── Scoped authority / circuit breaker ───────────────────────────────────
  let authorityInfo: AuthorityInfo | undefined;
  if (authority) {
    const windowMs = authority.windowMs ?? DEFAULT_AUTHORITY_WINDOW_MS;
    const valueUsd = authority.valueUsd ?? 0;
    const decision = await authorityStore.checkAndConsume({
      id: authority.id,
      ...(authority.maxExecutions !== undefined
        ? { maxExecutions: authority.maxExecutions }
        : {}),
      ...(authority.maxValueUsd !== undefined
        ? { maxValueUsd: authority.maxValueUsd }
        : {}),
      valueUsd,
      windowMs,
      now: Date.now(),
    });

    authorityInfo = {
      id: authority.id,
      allowed: decision.allowed,
      ...(decision.reason ? { reason: decision.reason } : {}),
      executions: decision.allowed
        ? decision.state.executions
        : decision.projectedExecutions,
      ...(authority.maxExecutions !== undefined
        ? { maxExecutions: authority.maxExecutions }
        : {}),
      valueUsd: decision.allowed ? decision.state.valueUsd : decision.projectedValueUsd,
      ...(authority.maxValueUsd !== undefined
        ? { maxValueUsd: authority.maxValueUsd }
        : {}),
      windowStart: decision.state.windowStart,
      windowMs: decision.state.windowMs,
    };

    if (!decision.allowed) {
      if (budgetReserved && budget) releaseBudgetReservation(budget.id, budgetEstimate);
      return finalize<T>(
        {
          status: "blocked:authority",
          fromCache: false,
          replayCount: 0,
          authorityInfo,
          ...(approvedInfo ? { approvalInfo: approvedInfo } : {}),
        },
        {
          key,
          intentHash,
          metadata,
          reason:
            decision.reason === "max-value-usd"
              ? "action would exceed the authority value limit"
              : "action would exceed the authority execution limit",
          onDecision,
        }
      );
    }
  }

  let result: T;
  try {
    result = await action();
  } catch (error) {
    const failurePolicy = failure?.policy ?? DEFAULT_FAILURE_POLICY;
    if (failurePolicy === "compensate" && failure?.onError) {
      await Promise.resolve(failure.onError({ key, error, policy: failurePolicy }));
    }
    throw error;
  } finally {
    if (budgetReserved && budget) {
      releaseBudgetReservation(budget.id, budgetEstimate);
    }
  }

  // ── Persist successful result ─────────────────────────────────────────────
  const now = Date.now();
  const entry: LedgerEntry<T> = {
    key,
    result,
    storedAt: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    replayCount: 0,
    intentHash,
  };
  await ledger.set(key, entry as LedgerEntry);

  // Record actual cost if available; otherwise the preflight estimate becomes
  // the recorded cost so estimated-only budgeting still works end-to-end.
  if (budget) {
    let costUsd = 0;
    if (extractCost) costUsd = extractCost(result);
    else if (budget.estimatedCostUsd !== undefined) costUsd = budget.estimatedCostUsd;

    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw new TypeError("[keelstack/guard] extracted cost must be a finite number >= 0.");
    }
    if (costUsd > 0) await budgetStore.record(budget.id, costUsd);
  }

  return finalize<T>(
    {
      status: "executed",
      value: result,
      fromCache: false,
      replayCount: 0,
      ...(authorityInfo ? { authorityInfo } : {}),
      ...(approvedInfo ? { approvalInfo: approvedInfo } : {}),
    },
    { key, intentHash, metadata, onDecision }
  );
}

async function replayFromEntry<T>(
  existing: LedgerEntry,
  ledger: NonNullable<GuardOptions<T>["ledger"]>,
  context: {
    key: string;
    intentHash: string;
    metadata: ActionMetadata | undefined;
    onDecision: GuardOptions<T>["onDecision"] | undefined;
  }
): Promise<GuardResult<T>> {
  const updated: LedgerEntry = {
    ...existing,
    replayCount: existing.replayCount + 1,
  };
  await ledger.set(existing.key, updated);

  return finalize<T>(
    {
      status: "replayed",
      value: existing.result as T,
      fromCache: true,
      replayCount: updated.replayCount,
    },
    context
  );
}

async function finalize<T>(
  result: Omit<GuardResult<T>, "receipt">,
  context: {
    key: string;
    intentHash: string;
    metadata: ActionMetadata | undefined;
    reason?: string | undefined;
    onDecision: GuardOptions<T>["onDecision"] | undefined;
  }
): Promise<GuardResult<T>> {
  const receipt: DecisionReceipt = {
    id: globalThis.crypto.randomUUID(),
    key: context.key,
    status: result.status,
    timestamp: Date.now(),
    intentHash: context.intentHash,
    ...(context.metadata ? { metadata: context.metadata } : {}),
    ...(context.reason ? { reason: context.reason } : {}),
    ...(result.riskInfo ? { riskInfo: result.riskInfo } : {}),
    ...(result.approvalInfo ? { approvalInfo: result.approvalInfo } : {}),
    ...(result.authorityInfo ? { authorityInfo: result.authorityInfo } : {}),
    ...(result.budgetInfo ? { budgetInfo: result.budgetInfo } : {}),
  };

  if (context.onDecision) await Promise.resolve(context.onDecision(receipt));
  return { ...result, receipt };
}

async function getOrInitBudgetState(
  budgetStore: NonNullable<GuardOptions<unknown>["budgetStore"]>,
  id: string,
  limitUsd: number
) {
  let state = await budgetStore.get(id);
  if (!state) {
    state = { id, currentSpend: 0, limitUsd, windowStart: Date.now() };
    await budgetStore.set(id, state);
  } else if (state.limitUsd !== limitUsd) {
    state = { ...state, limitUsd };
    await budgetStore.set(id, state);
  }
  return state;
}

function releaseBudgetReservation(id: string, amount: number): void {
  const current = budgetReservations.get(id) ?? 0;
  const next = Math.max(0, current - amount);
  if (next === 0) budgetReservations.delete(id);
  else budgetReservations.set(id, next);
}

function validateBudget(budget: GuardOptions<unknown>["budget"]): void {
  if (!budget) return;
  if (!Number.isFinite(budget.limitUsd) || budget.limitUsd <= 0) {
    throw new TypeError("[keelstack/guard] `budget.limitUsd` must be > 0.");
  }
  if (
    budget.estimatedCostUsd !== undefined &&
    (!Number.isFinite(budget.estimatedCostUsd) || budget.estimatedCostUsd < 0)
  ) {
    throw new TypeError(
      "[keelstack/guard] `budget.estimatedCostUsd` must be a finite number >= 0."
    );
  }
}

function validateAuthority(authority: GuardOptions<unknown>["authority"]): void {
  if (!authority) return;
  if (!authority.id || authority.id.trim() === "") {
    throw new TypeError("[keelstack/guard] `authority.id` must be non-empty.");
  }
  if (
    authority.maxExecutions !== undefined &&
    (!Number.isInteger(authority.maxExecutions) || authority.maxExecutions < 1)
  ) {
    throw new TypeError("[keelstack/guard] `authority.maxExecutions` must be an integer >= 1.");
  }
  if (
    authority.windowMs !== undefined &&
    (!Number.isFinite(authority.windowMs) || authority.windowMs <= 0)
  ) {
    throw new TypeError("[keelstack/guard] `authority.windowMs` must be > 0.");
  }
  if (
    authority.maxValueUsd !== undefined &&
    (!Number.isFinite(authority.maxValueUsd) || authority.maxValueUsd < 0)
  ) {
    throw new TypeError("[keelstack/guard] `authority.maxValueUsd` must be >= 0.");
  }
  if (
    authority.valueUsd !== undefined &&
    (!Number.isFinite(authority.valueUsd) || authority.valueUsd < 0)
  ) {
    throw new TypeError("[keelstack/guard] `authority.valueUsd` must be >= 0.");
  }
}
