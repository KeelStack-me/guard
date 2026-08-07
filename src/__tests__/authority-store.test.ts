import { describe, expect, it } from "vitest";
import { MemoryAuthorityStore } from "../authority-store.js";

describe("MemoryAuthorityStore", () => {
  it("allows actions and accumulates executions and value", async () => {
    const store = new MemoryAuthorityStore();
    const first = await store.checkAndConsume({ id: "scope", valueUsd: 2, windowMs: 1000, now: 10 });
    const second = await store.checkAndConsume({ id: "scope", valueUsd: 3, windowMs: 1000, now: 20 });

    expect(first.allowed).toBe(true);
    expect(second.state).toMatchObject({ executions: 2, valueUsd: 5, windowStart: 10 });
    expect(await store.get("scope")).toEqual(second.state);
  });

  it("blocks execution and value limits without consuming authority", async () => {
    const store = new MemoryAuthorityStore();
    await store.checkAndConsume({ id: "scope", valueUsd: 2, windowMs: 1000, now: 10 });

    const executions = await store.checkAndConsume({ id: "scope", valueUsd: 1, maxExecutions: 1, windowMs: 1000, now: 20 });
    expect(executions).toMatchObject({ allowed: false, reason: "max-executions", projectedExecutions: 2 });

    const value = await store.checkAndConsume({ id: "scope", valueUsd: 4, maxValueUsd: 5, windowMs: 1000, now: 20 });
    expect(value).toMatchObject({ allowed: false, reason: "max-value-usd", projectedValueUsd: 6 });
    expect((await store.get("scope"))?.executions).toBe(1);
  });

  it("resets an expired window and can clear state", async () => {
    const store = new MemoryAuthorityStore();
    await store.checkAndConsume({ id: "scope", valueUsd: 2, windowMs: 10, now: 10 });
    const reset = await store.checkAndConsume({ id: "scope", valueUsd: 1, windowMs: 10, now: 21 });
    expect(reset.state).toMatchObject({ executions: 1, valueUsd: 1, windowStart: 21, windowMs: 10 });
    await store.clear();
    expect(await store.get("scope")).toBeUndefined();
  });
});
