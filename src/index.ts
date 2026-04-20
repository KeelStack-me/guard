/**
 * @keelstack/guard
 *
 * Guardrails that reduce duplicate AI tool side effects
 * and runaway costs.
 *
 * @example
 * import { guard } from '@keelstack/guard';
 *
 * const result = await guard({
 *   key: `send-email:${userId}:${taskId}`,
 *   action: () => resend.emails.send({ ... }),
 * });
 */

export { guard } from "./guard.js";
export { MemoryLedger, defaultLedger } from "./ledger.js";
export { MemoryBudgetStore, defaultBudgetStore } from "./budget-store.js";

export type {
  // Core
  GuardOptions,
  GuardResult,
  GuardResultStatus,
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
  // Failure
  FailurePolicy,
  FailureConfig,
  FailureInfo,
} from "./types.js";
