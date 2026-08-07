/**
 * @keelstack/guard — public types
 *
 * Guard is an action firewall for AI agents. It protects the boundary between
 * "the model decided to do something" and "the side effect actually happened".
 */

// ─── Shared metadata ─────────────────────────────────────────────────────────

export type Primitive = string | number | boolean | null;

/** Human-readable metadata attached to decisions and audit receipts. */
export interface ActionMetadata {
  /** Tool/function name, e.g. "send_email" or "refund_payment". */
  tool?: string;
  /** Agent, user, tenant, or service initiating the action. */
  actor?: string;
  /** Resource being touched, e.g. "invoice:in_123". */
  resource?: string;
  /** A compact description safe to show in an approval UI or audit log. */
  summary?: string;
  /** Extra low-cardinality audit metadata. */
  tags?: Record<string, Primitive>;
}

// ─── Ledger (idempotency storage) ────────────────────────────────────────────

/** A single stored result in the idempotency ledger. */
export interface LedgerEntry<T = unknown> {
  key: string;
  result: T;
  storedAt: number;
  expiresAt: number;
  replayCount: number;
  /** SHA-256 of the canonical intent, when intent binding is enabled. */
  intentHash?: string;
}

/** Minimal interface any ledger backend must implement. */
export interface Ledger {
  get(key: string): Promise<LedgerEntry | undefined>;
  set(key: string, entry: LedgerEntry): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<LedgerEntry[]>;
  prune(): Promise<number>;
}

// ─── Budget ──────────────────────────────────────────────────────────────────

/** Per-user / per-agent spend tracking. */
export interface BudgetConfig {
  /** Unique identifier for the budget holder (user ID, agent ID, tenant ID). */
  id: string;
  /** Maximum allowed spend in USD for the current window. */
  limitUsd: number;
  /**
   * Optional preflight estimate for THIS action. If currentSpend + estimate
   * would exceed the limit, Guard blocks before the action starts.
   */
  estimatedCostUsd?: number;
  /** Thresholds (0–1) at which `onWarn` is evaluated. Default: [0.5, 0.8]. */
  warnAt?: number[];
  onWarn?: (info: BudgetWarnInfo) => void | Promise<void>;
}

export interface BudgetWarnInfo {
  id: string;
  threshold: number;
  currentSpend: number;
  limitUsd: number;
  percentUsed: number;
  projectedSpend?: number;
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

export type RiskLevel = "safe" | "reversible" | "irreversible";
export type RiskPolicy = "allow" | "log" | "warn" | "block";

export interface RiskConfig {
  level: RiskLevel;
  policy?: RiskPolicy;
  onRisk?: (info: RiskInfo) => void | Promise<void>;
}

export interface RiskInfo {
  key: string;
  level: RiskLevel;
  policy: RiskPolicy;
  blocked: boolean;
}

// ─── Human approval ──────────────────────────────────────────────────────────

export interface ApprovalDecision {
  status: "approved" | "denied";
  /**
   * Intent hash returned by a prior `pending:approval` result. Binding the
   * approval to the exact intent prevents approving one call and executing
   * mutated arguments later.
   */
  intentHash: string;
  by?: string;
  reason?: string;
}

export interface ApprovalContext {
  key: string;
  intentHash: string;
  /** Original caller-supplied intent, when available. */
  intent?: unknown;
  metadata?: ActionMetadata;
}

export interface ApprovalConfig {
  /** Always require approval, or decide dynamically from the action context. */
  required: boolean | ((context: ApprovalContext) => boolean | Promise<boolean>);
  /** Supply this when resuming after a human/system approval decision. */
  decision?: ApprovalDecision;
}

export interface ApprovalInfo {
  key: string;
  intentHash: string;
  required: boolean;
  status: "pending" | "approved" | "denied" | "mismatch";
  by?: string;
  reason?: string;
}

// ─── Scoped authority / circuit breaker ─────────────────────────────────────

export interface AuthorityConfig {
  /** Scope being constrained, e.g. `support-agent:user-123` or `tenant:acme`. */
  id: string;
  /** Max real executions in a rolling/fixed store window. */
  maxExecutions?: number;
  /** Window length. Default: 60 seconds. */
  windowMs?: number;
  /** Max cumulative monetary value this scope may act on during the window. */
  maxValueUsd?: number;
  /** Monetary value at risk for THIS action, e.g. refund or purchase amount. */
  valueUsd?: number;
}

export interface AuthorityState {
  id: string;
  executions: number;
  valueUsd: number;
  windowStart: number;
  windowMs: number;
}

export interface AuthorityRequest {
  id: string;
  maxExecutions?: number;
  maxValueUsd?: number;
  valueUsd: number;
  windowMs: number;
  now: number;
}

export interface AuthorityDecision {
  allowed: boolean;
  reason?: "max-executions" | "max-value-usd";
  state: AuthorityState;
  projectedExecutions: number;
  projectedValueUsd: number;
}

/**
 * Shared backends should implement `checkAndConsume` atomically so multiple
 * agent workers cannot exceed the same authority scope concurrently.
 */
export interface AuthorityStore {
  checkAndConsume(request: AuthorityRequest): Promise<AuthorityDecision>;
  get(id: string): Promise<AuthorityState | undefined>;
}

export interface AuthorityInfo {
  id: string;
  allowed: boolean;
  reason?: "max-executions" | "max-value-usd";
  executions: number;
  maxExecutions?: number;
  valueUsd: number;
  maxValueUsd?: number;
  windowStart: number;
  windowMs: number;
}

// ─── Failure handling ────────────────────────────────────────────────────────

export type FailurePolicy = "retry" | "compensate";

export interface FailureInfo {
  key: string;
  error: unknown;
  policy: FailurePolicy;
}

export interface FailureConfig {
  policy?: FailurePolicy;
  onError?: (info: FailureInfo) => void | Promise<void>;
}

// ─── Cost extraction ─────────────────────────────────────────────────────────

export type CostExtractor<T> = (result: T) => number;

// ─── Decision receipts ───────────────────────────────────────────────────────

export type GuardResultStatus =
  | "executed"
  | "replayed"
  | "pending:approval"
  | "blocked:approval"
  | "blocked:intent-conflict"
  | "blocked:authority"
  | "blocked:budget"
  | "blocked:risk";

export interface DecisionReceipt {
  id: string;
  key: string;
  status: GuardResultStatus;
  timestamp: number;
  intentHash?: string;
  metadata?: ActionMetadata;
  reason?: string;
  riskInfo?: RiskInfo;
  approvalInfo?: ApprovalInfo;
  authorityInfo?: AuthorityInfo;
  budgetInfo?: {
    id: string;
    spent: number;
    limit: number;
    percentUsed: number;
    projectedSpend?: number;
  };
}

// ─── Guard options ────────────────────────────────────────────────────────────

export interface GuardOptions<T = unknown> {
  /** Stable idempotency key for one logical operation. */
  key: string;
  /** The async side effect to protect. */
  action: () => Promise<T>;
  /**
   * Canonical action intent (normally tool name + arguments). When provided,
   * Guard hashes it and refuses to replay a key if the intent changed.
   */
  intent?: unknown;
  /** Optional audit/approval metadata. */
  metadata?: ActionMetadata;
  /** How long (ms) to retain successful results. Default: 24 hours. */
  ttlMs?: number;
  budget?: BudgetConfig;
  extractCost?: CostExtractor<T>;
  risk?: RiskConfig;
  approval?: ApprovalConfig;
  authority?: AuthorityConfig;
  failure?: FailureConfig;
  ledger?: Ledger;
  budgetStore?: BudgetStore;
  authorityStore?: AuthorityStore;
  /** Called once for every final allow/replay/block/pending decision. */
  onDecision?: (receipt: DecisionReceipt) => void | Promise<void>;
}

// ─── Guard result ─────────────────────────────────────────────────────────────

export interface GuardResult<T> {
  status: GuardResultStatus;
  value?: T;
  budgetInfo?: {
    id: string;
    spent: number;
    limit: number;
    percentUsed: number;
    projectedSpend?: number;
  };
  riskInfo?: RiskInfo;
  approvalInfo?: ApprovalInfo;
  authorityInfo?: AuthorityInfo;
  intentConflict?: {
    key: string;
    storedIntentHash: string;
    receivedIntentHash: string;
  };
  fromCache: boolean;
  replayCount: number;
  receipt: DecisionReceipt;
}
