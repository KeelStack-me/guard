import { describe, it, expect, beforeEach, vi } from "vitest";
import { guard } from "../guard.js";
import { MemoryLedger } from "../ledger.js";
import { MemoryBudgetStore } from "../budget-store.js";

// Fresh ledger + budget store per test — no cross-test contamination
function freshDeps() {
  return {
    ledger: new MemoryLedger(0), // disable auto-prune in tests
    budgetStore: new MemoryBudgetStore(),
  };
}

describe("guard() — idempotency", () => {
  it("executes the action on first call", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue("hello");

    const result = await guard({ key: "k1", action, ledger, budgetStore });

    expect(result.status).toBe("executed");
    expect(result.value).toBe("hello");
    expect(result.fromCache).toBe(false);
    expect(result.replayCount).toBe(0);
    expect(action).toHaveBeenCalledOnce();
  });

  it("replays from cache on second call — action NOT called again", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue("hello");

    await guard({ key: "k2", action, ledger, budgetStore });
    const second = await guard({ key: "k2", action, ledger, budgetStore });

    expect(second.status).toBe("replayed");
    expect(second.value).toBe("hello");
    expect(second.fromCache).toBe(true);
    expect(second.replayCount).toBe(1);
    expect(action).toHaveBeenCalledOnce(); // still only once
  });

  it("increments replayCount on each duplicate call", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue(42);

    await guard({ key: "k3", action, ledger, budgetStore });
    await guard({ key: "k3", action, ledger, budgetStore });
    const third = await guard({ key: "k3", action, ledger, budgetStore });

    expect(third.replayCount).toBe(2);
    expect(action).toHaveBeenCalledOnce();
  });

  it("treats different keys as independent operations", async () => {
    const { ledger, budgetStore } = freshDeps();
    const a = vi.fn().mockResolvedValue("a");
    const b = vi.fn().mockResolvedValue("b");

    const r1 = await guard({ key: "ka", action: a, ledger, budgetStore });
    const r2 = await guard({ key: "kb", action: b, ledger, budgetStore });

    expect(r1.value).toBe("a");
    expect(r2.value).toBe("b");
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("respects custom TTL — entry missing after expiry", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue("ttl-test");

    await guard({ key: "k-ttl", action, ttlMs: 1, ledger, budgetStore });
    await new Promise((r) => setTimeout(r, 10)); // wait for entry to expire
    const second = await guard({ key: "k-ttl", action, ttlMs: 1, ledger, budgetStore });

    expect(second.status).toBe("executed");
    expect(action).toHaveBeenCalledTimes(2); // ran again after TTL
  });

  it("throws TypeError for empty key", async () => {
    const { ledger, budgetStore } = freshDeps();
    await expect(
      guard({ key: "", action: async () => "x", ledger, budgetStore })
    ).rejects.toThrow(TypeError);
  });

  it("throws TypeError if action is not a function", async () => {
    const { ledger, budgetStore } = freshDeps();
    await expect(
      // @ts-expect-error intentionally wrong type
      guard({ key: "bad", action: "not-a-fn", ledger, budgetStore })
    ).rejects.toThrow(TypeError);
  });

  it("prevents concurrent same-key double execution", async () => {
    const { ledger, budgetStore } = freshDeps();

    let resolveAction: ((value: string) => void) | undefined;
    let actionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      actionStarted = resolve;
    });
    const action = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveAction = resolve;
          actionStarted?.();
        })
    );

    const firstPromise = guard({ key: "k-concurrent", action, ledger, budgetStore });
    const secondPromise = guard({ key: "k-concurrent", action, ledger, budgetStore });

    // Wait until the first request has entered the action. This is more
    // reliable across Node versions than assuming a fixed number of
    // microtask turns for WebCrypto intent fingerprinting.
    await started;

    resolveAction?.("ok");

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(action).toHaveBeenCalledOnce();
    // WebCrypto fingerprinting is asynchronous, so either caller may reach
    // the ledger first. Exactly one executes and the other replays.
    expect([first.status, second.status].sort()).toEqual(["executed", "replayed"]);
    expect([first.fromCache, second.fromCache].filter(Boolean)).toHaveLength(1);
  });
});

describe("guard() — budget enforcement", () => {
  it("allows action when budget has headroom", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue({ tokens: 100 });

    const result = await guard({
      key: "budget-ok",
      action,
      budget: { id: "user-1", limitUsd: 5.0 },
      extractCost: () => 0.001,
      ledger,
      budgetStore,
    });

    expect(result.status).toBe("executed");
  });

  it("blocks action when budget is exhausted", async () => {
    const { ledger, budgetStore } = freshDeps();

    // Pre-fill budget to limit
    await budgetStore.set("user-2", {
      id: "user-2",
      currentSpend: 5.0,
      limitUsd: 5.0,
      windowStart: Date.now(),
    });

    const action = vi.fn().mockResolvedValue("should-not-run");
    const result = await guard({
      key: "budget-block",
      action,
      budget: { id: "user-2", limitUsd: 5.0 },
      extractCost: () => 0.001,
      ledger,
      budgetStore,
    });

    expect(result.status).toBe("blocked:budget");
    expect(result.budgetInfo?.spent).toBe(5.0);
    expect(result.budgetInfo?.percentUsed).toBe(1);
    expect(action).not.toHaveBeenCalled();
  });

  it("records cost after successful execution", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue("done");

    await guard({
      key: "cost-record",
      action,
      budget: { id: "user-3", limitUsd: 10.0 },
      extractCost: () => 1.5,
      ledger,
      budgetStore,
    });

    const state = await budgetStore.get("user-3");
    expect(state?.currentSpend).toBeCloseTo(1.5);
  });

  it("fires onWarn callback when threshold is crossed", async () => {
    const { ledger, budgetStore } = freshDeps();
    const onWarn = vi.fn();

    // Pre-fill to 60% — crosses the 50% threshold
    await budgetStore.set("user-4", {
      id: "user-4",
      currentSpend: 3.0, // 60% of $5
      limitUsd: 5.0,
      windowStart: Date.now(),
    });

    await guard({
      key: "warn-test",
      action: async () => "ok",
      budget: { id: "user-4", limitUsd: 5.0, warnAt: [0.5], onWarn },
      extractCost: () => 0,
      ledger,
      budgetStore,
    });

    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]?.[0].threshold).toBe(0.5);
  });

  it("does not record cost if extractCost not provided", async () => {
    const { ledger, budgetStore } = freshDeps();

    await guard({
      key: "no-extractor",
      action: async () => "done",
      budget: { id: "user-5", limitUsd: 5.0 },
      // no extractCost
      ledger,
      budgetStore,
    });

    const state = await budgetStore.get("user-5");
    expect(state?.currentSpend).toBe(0);
  });
});

describe("guard() — risk gating", () => {
  it("allows action with risk level 'safe' (default policy: allow)", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue("safe-result");

    const result = await guard({
      key: "risk-safe",
      action,
      risk: { level: "safe" },
      ledger,
      budgetStore,
    });

    expect(result.status).toBe("executed");
    expect(action).toHaveBeenCalledOnce();
  });

  it("blocks action when policy is 'block'", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue("blocked");

    const result = await guard({
      key: "risk-block",
      action,
      risk: { level: "irreversible", policy: "block" },
      ledger,
      budgetStore,
    });

    expect(result.status).toBe("blocked:risk");
    expect(result.riskInfo?.blocked).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });

  it("calls onRisk callback for every classified action", async () => {
    const { ledger, budgetStore } = freshDeps();
    const onRisk = vi.fn();

    await guard({
      key: "risk-callback",
      action: async () => "ok",
      risk: { level: "reversible", policy: "allow", onRisk },
      ledger,
      budgetStore,
    });

    expect(onRisk).toHaveBeenCalledOnce();
    expect(onRisk.mock.calls[0]?.[0].level).toBe("reversible");
  });

  it("logs a console.warn for 'warn' policy", async () => {
    const { ledger, budgetStore } = freshDeps();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await guard({
      key: "risk-warn",
      action: async () => "ok",
      risk: { level: "irreversible", policy: "warn" },
      ledger,
      budgetStore,
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe("guard() — combined primitives", () => {
  it("idempotency + budget: replay skips budget check", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockResolvedValue("result");

    // First call
    await guard({
      key: "combo-1",
      action,
      budget: { id: "user-combo", limitUsd: 1.0 },
      extractCost: () => 0.5,
      ledger,
      budgetStore,
    });

    // Exhaust the budget
    await budgetStore.set("user-combo", {
      id: "user-combo",
      currentSpend: 1.0,
      limitUsd: 1.0,
      windowStart: Date.now(),
    });

    // Second call — same key, should replay from ledger even though budget is gone
    const replay = await guard({
      key: "combo-1",
      action,
      budget: { id: "user-combo", limitUsd: 1.0 },
      extractCost: () => 0.5,
      ledger,
      budgetStore,
    });

    expect(replay.status).toBe("replayed");
    expect(action).toHaveBeenCalledOnce(); // not called again
  });

  it("budget + risk: budget checked before risk gate", async () => {
    const { ledger, budgetStore } = freshDeps();
    await budgetStore.set("user-br", {
      id: "user-br",
      currentSpend: 5.0,
      limitUsd: 5.0,
      windowStart: Date.now(),
    });

    const action = vi.fn();
    const result = await guard({
      key: "combo-2",
      action,
      budget: { id: "user-br", limitUsd: 5.0 },
      risk: { level: "irreversible", policy: "block" },
      ledger,
      budgetStore,
    });

    // Budget is checked first — should be blocked by budget, not risk
    expect(result.status).toBe("blocked:budget");
    expect(action).not.toHaveBeenCalled();
  });

  it("failure policy retry rethrows and allows future retries", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      guard({ key: "fail-retry", action, ledger, budgetStore })
    ).rejects.toThrow("boom");

    await expect(
      guard({ key: "fail-retry", action, ledger, budgetStore })
    ).rejects.toThrow("boom");

    expect(action).toHaveBeenCalledTimes(2);
  });

  it("failure policy compensate invokes onError before rethrow", async () => {
    const { ledger, budgetStore } = freshDeps();
    const action = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();

    await expect(
      guard({
        key: "fail-compensate",
        action,
        ledger,
        budgetStore,
        failure: { policy: "compensate", onError },
      })
    ).rejects.toThrow("boom");

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0].key).toBe("fail-compensate");
    expect(onError.mock.calls[0]?.[0].policy).toBe("compensate");
  });
});

describe("guard() — approvals, authority, and validation", () => {
  it("rejects a reused key when its intent differs", async () => {
    const { ledger, budgetStore } = freshDeps();
    await guard({ key: "intent-conflict", intent: { tool: "email", to: "a" }, action: async () => "ok", ledger, budgetStore });

    const result = await guard({ key: "intent-conflict", intent: { tool: "email", to: "b" }, action: async () => "no", ledger, budgetStore });

    expect(result.status).toBe("blocked:intent-conflict");
    expect(result.intentConflict?.key).toBe("intent-conflict");
  });

  it("returns pending approval with an auditable decision receipt", async () => {
    const { ledger, budgetStore } = freshDeps();
    const onDecision = vi.fn();
    const result = await guard({
      key: "approval-pending", intent: { operation: "transfer" }, action: async () => "no",
      approval: { required: true }, metadata: { source: "test" }, onDecision, ledger, budgetStore,
    });

    expect(result.status).toBe("pending:approval");
    expect(result.approvalInfo?.status).toBe("pending");
    expect(onDecision).toHaveBeenCalledOnce();
    expect(result.receipt.metadata).toEqual({ source: "test" });
  });

  it("blocks denied and mismatched approvals", async () => {
    const { ledger, budgetStore } = freshDeps();
    const { fingerprintIntent } = await import("../intent.js");
    const denied = await guard({
      key: "approval-denied", action: async () => "no", approval: { required: true, decision: { intentHash: await fingerprintIntent({ key: "approval-denied" }), status: "denied", by: "reviewer", reason: "unsafe" } }, ledger, budgetStore,
    });
    const mismatch = await guard({
      key: "approval-mismatch", action: async () => "no", approval: { required: true, decision: { intentHash: "wrong", status: "approved", by: "reviewer" } }, ledger, budgetStore,
    });

    expect(denied.approvalInfo?.status).toBe("denied");
    expect(denied.receipt.reason).toBe("unsafe");
    expect(mismatch.status).toBe("blocked:approval");
    expect(mismatch.approvalInfo?.status).toBe("mismatch");
  });

  it("executes approved actions and enforces authority execution limits", async () => {
    const { ledger, budgetStore } = freshDeps();
    const intent = { operation: "publish" };
    const { fingerprintIntent } = await import("../intent.js");
    const intentHash = await fingerprintIntent(intent);
    const authority = { id: "publisher", maxExecutions: 1 };
    const first = await guard({ key: "authority-one", intent, action: async () => "ok", approval: { required: () => true, decision: { intentHash, status: "approved", by: "admin" } }, authority, ledger, budgetStore });
    const second = await guard({ key: "authority-two", action: async () => "no", authority, ledger, budgetStore });

    expect(first.approvalInfo?.status).toBe("approved");
    expect(first.authorityInfo?.allowed).toBe(true);
    expect(second.status).toBe("blocked:authority");
    expect(second.authorityInfo?.reason).toBe("max-executions");
  });

  it("uses estimates for preflight, recording, and concurrent budget protection", async () => {
    const { ledger, budgetStore } = freshDeps();
    const first = await guard({ key: "estimate-record", action: async () => "ok", budget: { id: "estimated", limitUsd: 2, estimatedCostUsd: 1 }, ledger, budgetStore });
    const blocked = await guard({ key: "estimate-block", action: async () => "no", budget: { id: "estimated", limitUsd: 2, estimatedCostUsd: 1.1 }, ledger, budgetStore });

    expect(first.status).toBe("executed");
    expect((await budgetStore.get("estimated"))?.currentSpend).toBe(1);
    expect(blocked.status).toBe("blocked:budget");
    expect(blocked.budgetInfo?.projectedSpend).toBe(2.1);
  });

  it("enforces authority value limits and includes projected budget warnings", async () => {
    const { ledger, budgetStore } = freshDeps();
    const onWarn = vi.fn();
    const budget = { id: "warning-estimate", limitUsd: 10, estimatedCostUsd: 6, warnAt: [0.5], onWarn };
    const executed = await guard({ key: "warning-estimate", action: async () => "ok", budget, ledger, budgetStore });
    const blocked = await guard({
      key: "authority-value", action: async () => "no",
      authority: { id: "value-limited", maxValueUsd: 1, valueUsd: 1.1 }, ledger, budgetStore,
    });

    expect(executed.status).toBe("executed");
    expect(onWarn).toHaveBeenCalledWith(expect.objectContaining({ projectedSpend: 6 }));
    expect(blocked.status).toBe("blocked:authority");
    expect(blocked.authorityInfo).toMatchObject({ reason: "max-value-usd", valueUsd: 1.1, maxValueUsd: 1 });
  });

  it("validates TTL, budget, and authority configuration", async () => {
    const { ledger, budgetStore } = freshDeps();
    const base = { key: "invalid", action: async () => "ok", ledger, budgetStore };

    await expect(guard({ ...base, ttlMs: -1 })).rejects.toThrow("ttlMs");
    await expect(guard({ ...base, key: "invalid-budget", budget: { id: "b", limitUsd: 0 } })).rejects.toThrow("limitUsd");
    await expect(guard({ ...base, key: "invalid-authority", authority: { id: "", maxExecutions: 1 } })).rejects.toThrow("authority.id");
    await expect(guard({ ...base, key: "invalid-window", authority: { id: "a", windowMs: 0 } })).rejects.toThrow("windowMs");
  });
});
