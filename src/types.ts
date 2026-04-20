/**
 * @keelstack/guard — types
 *
 * All public-facing types for the guard API.
 * Keep this file free of implementation details.
 */

// ─── Ledger (storage) ────────────────────────────────────────────────────────

/** A single stored result in the idempotency ledger. */
export interface LedgerEntry<T = unknown> {
  /** The idempotency key used to store this result. */
  key: string;
  /** The resolved value from the original action. */
  result: T;
  /** Unix timestamp (ms) when the entry was first stored. */
  storedAt: number;
  /** Unix timestamp (ms) when this entry expires. 0 = never. */
  expiresAt: number;
  /** How many times this key has been replayed (deduplicated). */
  replayCount: number;
}

/** Minimal interface any ledger backend must implement. */
export interface Ledger {
  /** Returns the stored entry for `key`, or `undefined` if not found / expired. */
  get(key: string): Promise<LedgerEntry | undefined>;
  /** Stores an entry. Must be atomic — concurrent writes to the same key must be safe. */
  set(key: string, entry: LedgerEntry): Promise<void>;
  /** Removes an entry. Idempotent — safe to call on missing keys. */
  delete(key: string): Promise<void>;
  /** Returns all current entries. Used for dashboard/debug inspection. */
  list(): Promise<LedgerEntry[]>;
  /** Removes all expired entries. Called periodically by the guard. */
  prune(): Promise<number>;
}

// ─── Budget ───────────────────────────────────────────────────────────────────

/** Per-user / per-agent spend tracking. */
export interface BudgetConfig {
  /** Unique identifier for the budget holder (user ID, agent ID, tenant ID). */
  id: string;
  /**
   * Maximum allowed spend in USD for the current window.
   * The guard will block the action if `currentSpend >= limitUsd`.
   */
  limitUsd: number;
  /**
    * Optional: thresholds (0–1) at which `onWarn` is evaluated.
    * Default: [0.5, 0.8].
   */
  warnAt?: number[];
    /** Called when current usage is greater than or equal to a threshold. */
  onWarn?: (info: BudgetWarnInfo) => void | Promise<void>;
}

export interface BudgetWarnInfo {
  id: string;
  threshold: number;
  currentSpend: number;
  limitUsd: number;
  percentUsed: number;
}

export interface BudgetState {
  id: string;
  currentSpend: number;
  limitUsd: number;
  windowStart: number;
}

export interface BudgetStore {
  get(id: string): Promise<BudgetState | undefined>;
  set(id: string, state: BudgetState): Promise<void>;
  /** Records cost after a successful action. Returns updated state. */
  record(id: string, costUsd: number): Promise<BudgetState>;
}

// ─── Risk gate ────────────────────────────────────────────────────────────────

/** How risky is this action if executed more than once? */
export type RiskLevel = "safe" | "reversible" | "irreversible";

/** What should happen when an action's risk level triggers the policy? */
export type RiskPolicy = "allow" | "log" | "warn" | "block";

export interface RiskConfig {
  level: RiskLevel;
  policy?: RiskPolicy;
  /** Called for every action at this risk level (even if allowed). */
  onRisk?: (info: RiskInfo) => void | Promise<void>;
}

export interface RiskInfo {
  key: string;
  level: RiskLevel;
  policy: RiskPolicy;
  blocked: boolean;
}

// ─── Failure handling ────────────────────────────────────────────────────────

/** Behavior when the protected action throws. */
export type FailurePolicy = "retry" | "compensate";

export interface FailureInfo {
  key: string;
  error: unknown;
  policy: FailurePolicy;
}

export interface FailureConfig {
  /**
   * Default: "retry"
   * - retry: rethrow and allow future attempts with the same key
   * - compensate: call onError before rethrowing
   */
  policy?: FailurePolicy;
  /** Optional compensation hook for side-effecting actions. */
  onError?: (info: FailureInfo) => void | Promise<void>;
}

// ─── Cost extraction ──────────────────────────────────────────────────────────

/**
 * Function the caller provides to extract USD cost from an action's result.
 * If not provided, budget tracking is disabled even when a BudgetConfig is given.
 *
 * @example
 * // OpenAI response
 * extractCost: (res) => (res.usage.total_tokens / 1_000_000) * 15
 */
export type CostExtractor<T> = (result: T) => number;

// ─── Guard options ────────────────────────────────────────────────────────────

export interface GuardOptions<T = unknown> {
  /**
   * Idempotency key. Must be unique per logical operation.
   * The caller is responsible for generating stable keys.
   *
   * @example `send-email:${userId}:${taskId}`
   * @example `stripe-charge:${invoiceId}`
   */
  key: string;

  /** The async action to protect. Called at most once per unique key. */
  action: () => Promise<T>;

  /**
   * Optional: how long (ms) to keep the result in the ledger.
   * Default: 86_400_000 (24 hours).
   */
  ttlMs?: number;

  /** Optional: per-user / per-agent spend budget. */
  budget?: BudgetConfig;

  /**
   * Optional: extract the USD cost from the action's result.
   * Required for budget tracking to work.
   */
  extractCost?: CostExtractor<T>;

  /** Optional: risk classification and policy for this action. */
  risk?: RiskConfig;

  /** Optional: behavior when the protected action throws. */
  failure?: FailureConfig;

  /**
   * Optional: custom ledger backend.
   * Defaults to the in-memory ledger (MemoryLedger).
   */
  ledger?: Ledger;

  /**
   * Optional: custom budget store.
   * Defaults to the in-memory budget store (MemoryBudgetStore).
   */
  budgetStore?: BudgetStore;
}

// ─── Guard result ─────────────────────────────────────────────────────────────

export type GuardResultStatus =
  | "executed"       // action ran for the first time
  | "replayed"       // duplicate — returned from ledger, action skipped
  | "blocked:budget" // action blocked — budget exceeded
  | "blocked:risk";  // action blocked — risk policy

export interface GuardResult<T> {
  /** What happened. */
  status: GuardResultStatus;
  /** The result value. Present for "executed" and "replayed". Undefined when blocked. */
  value?: T;
  /** Present when status is "blocked:budget". */
  budgetInfo?: {
    id: string;
    spent: number;
    limit: number;
    percentUsed: number;
  };
  /** Present when status is "blocked:risk". */
  riskInfo?: RiskInfo;
  /** True if the result came from the ledger cache. */
  fromCache: boolean;
  /** How many times this key has been replayed total (including this call). */
  replayCount: number;
}
