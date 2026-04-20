/**
 * @keelstack/guard
 *
 * Guardrails that stop repeated AI tool calls from causing
 * duplicate actions and runaway costs.
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
} from "./types.js";
