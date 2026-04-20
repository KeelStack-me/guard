import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryLedger } from "../ledger.js";
import type { LedgerEntry } from "../types.js";

function makeEntry(key: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    key,
    result: { ok: true },
    storedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    replayCount: 0,
    ...overrides,
  };
}

describe("MemoryLedger", () => {
  let ledger: MemoryLedger;

  beforeEach(() => {
    ledger = new MemoryLedger();
  });

  it("returns undefined for unknown key", async () => {
    expect(await ledger.get("missing")).toBeUndefined();
  });

  it("stores and retrieves an entry", async () => {
    const entry = makeEntry("k1");
    await ledger.set("k1", entry);
    expect(await ledger.get("k1")).toEqual(entry);
  });

  it("returns undefined and removes expired entry on get()", async () => {
    const entry = makeEntry("k-expired", { expiresAt: Date.now() - 1 });
    await ledger.set("k-expired", entry);
    expect(await ledger.get("k-expired")).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it("never expires entry with expiresAt = 0", async () => {
    const entry = makeEntry("k-forever", { expiresAt: 0 });
    await ledger.set("k-forever", entry);
    expect(await ledger.get("k-forever")).toBeDefined();
  });

  it("deletes an entry", async () => {
    await ledger.set("k2", makeEntry("k2"));
    await ledger.delete("k2");
    expect(await ledger.get("k2")).toBeUndefined();
  });

  it("delete is idempotent on missing key", async () => {
    await expect(ledger.delete("ghost")).resolves.toBeUndefined();
  });

  it("lists only non-expired entries", async () => {
    await ledger.set("a", makeEntry("a", { expiresAt: Date.now() + 10_000 }));
    await ledger.set("b", makeEntry("b", { expiresAt: Date.now() - 1 }));
    const list = await ledger.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe("a");
  });

  it("prune() removes expired entries and returns count", async () => {
    await ledger.set("live", makeEntry("live", { expiresAt: Date.now() + 10_000 }));
    await ledger.set("dead1", makeEntry("dead1", { expiresAt: Date.now() - 1 }));
    await ledger.set("dead2", makeEntry("dead2", { expiresAt: Date.now() - 1 }));
    const pruned = await ledger.prune();
    expect(pruned).toBe(2);
    expect(ledger.size).toBe(1);
  });

  it("clear() empties the store", async () => {
    await ledger.set("x", makeEntry("x"));
    await ledger.clear();
    expect(ledger.size).toBe(0);
  });

  it("destroy() stops the prune timer without throwing", () => {
    expect(() => ledger.destroy()).not.toThrow();
    // Second destroy is safe too
    expect(() => ledger.destroy()).not.toThrow();
  });
});
