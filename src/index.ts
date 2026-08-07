/**
 * @keelstack/guard
 *
 * A framework-agnostic action firewall for AI agents.
 */

export { guard } from "./guard.js";
export { canonicalizeIntent, fingerprintIntent } from "./intent.js";
export { MemoryLedger, defaultLedger } from "./ledger.js";
export { MemoryBudgetStore, defaultBudgetStore } from "./budget-store.js";
export { MemoryAuthorityStore, defaultAuthorityStore } from "./authority-store.js";

export type {
  // Core
  GuardOptions,
  GuardResult,
  GuardResultStatus,
  ActionMetadata,
  Primitive,
  DecisionReceipt,
  // Ledger
  Ledger,
  LedgerEntry,
  // Budget
  BudgetConfig,
  BudgetState,
  BudgetStore,
  BudgetWarnInfo,
  CostExtractor,
  // Risk
  RiskLevel,
  RiskPolicy,
  RiskConfig,
  RiskInfo,
  // Approval
  ApprovalConfig,
  ApprovalContext,
  ApprovalDecision,
  ApprovalInfo,
  // Authority
  AuthorityConfig,
  AuthorityState,
  AuthorityRequest,
  AuthorityDecision,
  AuthorityStore,
  AuthorityInfo,
  // Failure
  FailurePolicy,
  FailureConfig,
  FailureInfo,
} from "./types.js";
