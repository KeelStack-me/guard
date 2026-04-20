import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBudgetStore } from "../budget-store.js";

describe("MemoryBudgetStore", () => {
  let store: MemoryBudgetStore;

  beforeEach(() => {
    store = new MemoryBudgetStore();
  });

  it("returns undefined for unknown id", async () => {
    expect(await store.get("u1")).toBeUndefined();
  });

  it("stores and retrieves state", async () => {
    const state = { id: "u1", currentSpend: 0, limitUsd: 5, windowStart: Date.now() };
    await store.set("u1", state);
    expect(await store.get("u1")).toEqual(state);
  });

  it("record() adds to currentSpend", async () => {
    await store.set("u2", { id: "u2", currentSpend: 1.0, limitUsd: 5, windowStart: Date.now() });
    const updated = await store.record("u2", 0.5);
    expect(updated.currentSpend).toBeCloseTo(1.5);
  });

  it("record() throws on unknown id", async () => {
    await expect(store.record("ghost", 1)).rejects.toThrow(/no state found/);
  });

  it("resets spend after window expires", async () => {
    // Use a very short window
    const shortStore = new MemoryBudgetStore(1); // 1ms window
    await shortStore.set("u3", { id: "u3", currentSpend: 3.0, limitUsd: 5, windowStart: Date.now() - 10 });
    await new Promise((r) => setTimeout(r, 5)); // wait for window to expire
    const state = await shortStore.get("u3");
    expect(state?.currentSpend).toBe(0);
  });

  it("clear() empties the store", async () => {
    await store.set("u4", { id: "u4", currentSpend: 0, limitUsd: 5, windowStart: Date.now() });
    await store.clear();
    expect(await store.get("u4")).toBeUndefined();
  });
});
