import { describe, expect, it } from "vitest";
import {
  MemoryAuthorityStore,
  MemoryBudgetStore,
  MemoryLedger,
  canonicalizeIntent,
  fingerprintIntent,
  guard,
} from "../index.js";

describe("public API", () => {
  it("exports the runtime guard primitives", async () => {
    expect(canonicalizeIntent({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    await expect(fingerprintIntent({ action: "test" })).resolves.toMatch(/^[a-f0-9]{64}$/);
    expect(new MemoryLedger()).toBeInstanceOf(MemoryLedger);
    expect(new MemoryBudgetStore()).toBeInstanceOf(MemoryBudgetStore);
    expect(new MemoryAuthorityStore()).toBeInstanceOf(MemoryAuthorityStore);
    await expect(guard({ key: "public-api", action: async () => "ok", ledger: new MemoryLedger() })).resolves.toMatchObject({ status: "executed" });
  });
});
