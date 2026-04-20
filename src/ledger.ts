import type { Ledger, LedgerEntry } from "./types.js";

/**
 * MemoryLedger — zero-config, zero-dependency idempotency ledger.
 *
 * Thread-safe for single-process Node.js (the event loop is single-threaded).
 * For multi-instance deployments, swap this for a Redis-backed ledger.
 *
 * The ledger auto-prunes expired entries every `pruneIntervalMs` (default 5 min).
 */
export class MemoryLedger implements Ledger {
  private readonly store = new Map<string, LedgerEntry>();
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(pruneIntervalMs = 5 * 60 * 1_000) {
    if (pruneIntervalMs > 0 && typeof setInterval !== "undefined") {
      this.pruneTimer = setInterval(() => void this.prune(), pruneIntervalMs);
      // Node.js specific: allow the process to exit even if the timer is active.
      // We cast to `unknown` first because the DOM type for setInterval returns
      // `number` (no .unref), while Node returns a Timeout object with .unref().
      const timer = this.pruneTimer as unknown as { unref?: () => void };
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    }
  }

  async get(key: string): Promise<LedgerEntry | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Lazy expiry check
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry;
  }

  async set(key: string, entry: LedgerEntry): Promise<void> {
    this.store.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<LedgerEntry[]> {
    const now = Date.now();
    const entries: LedgerEntry[] = [];
    for (const entry of this.store.values()) {
      if (entry.expiresAt === 0 || entry.expiresAt > now) {
        entries.push(entry);
      }
    }
    return entries;
  }

  async prune(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Clears all entries. Useful in tests. */
  async clear(): Promise<void> {
    this.store.clear();
  }

  /** Returns current entry count (including not-yet-pruned expired entries). */
  get size(): number {
    return this.store.size;
  }

  /** Stops the auto-prune timer. Call in tests or on graceful shutdown. */
  destroy(): void {
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }
}

// Shared default instance — callers who don't provide a ledger share this one.
// This is intentional: duplicate keys across different guard() calls in the
// same process will correctly deduplicate against each other.
export const defaultLedger = new MemoryLedger();
