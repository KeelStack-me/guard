<div align="center">

<!-- ANIMATED TERMINAL DEMO -->
<img src="https://raw.githubusercontent.com/KeelStack-me/guard/main/assets/demo.svg" alt="@keelstack/guard demo — idempotency gate, budget enforcer, risk gate" width="100%"/>

<br/>

# @keelstack/guard

**Guardrails that stop repeated AI tool calls from causing duplicate actions and runaway costs.**

*Wrap any agent tool call. It runs at most once per key across retries and loops in a process (and across crashes when using a persistent ledger).*

<br/>

[![npm version](https://img.shields.io/npm/v/@keelstack/guard?style=flat-square&color=e8a820&label=npm)](https://www.npmjs.com/package/@keelstack/guard)
[![npm downloads](https://img.shields.io/npm/dm/@keelstack/guard?style=flat-square&color=e8a820)](https://www.npmjs.com/package/@keelstack/guard)
[![CI](https://img.shields.io/github/actions/workflow/status/KeelStack-me/guard/ci.yml?style=flat-square&label=tests&color=3ddc84)](https://github.com/KeelStack-me/guard/actions)
[![coverage](https://img.shields.io/badge/coverage-98%25-3ddc84?style=flat-square)](https://github.com/KeelStack-me/guard)
[![zero deps](https://img.shields.io/badge/dependencies-0-3ddc84?style=flat-square)](https://www.npmjs.com/package/@keelstack/guard)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-lightgrey?style=flat-square)](https://nodejs.org)

<br/>

[**Docs & Demo**](https://guard.keelstack.me) · [npm](https://www.npmjs.com/package/@keelstack/guard) · [Report bug](https://github.com/KeelStack-me/guard/issues) · [Request feature](https://github.com/KeelStack-me/guard/issues)

</div>

---

## The problem

Your AI agent retries a failed tool call. The email sends **twice**. The charge fires **twice**. The record duplicates.

Agent frameworks — LangGraph, Vercel AI SDK, Mastra, OpenAI Agents SDK — retry on timeout by design. Without application-level deduplication, your side effects fire multiple times. And if your agent loops from a bad prompt or injection, your LLM bill triples overnight.

`@keelstack/guard` wraps any `async () => T` with three primitives that make this impossible:

| Primitive | What it does | Status returned |
|-----------|-------------|-----------------|
| **Idempotency gate** | Replays cached result on duplicate key — action skipped | `replayed` |
| **Budget enforcer** | Blocks action before it fires when per-user spend is hit | `blocked:budget` |
| **Risk gate** | Logs, warns, or blocks based on action risk level | `blocked:risk` |

Zero config. Zero framework coupling. Zero runtime dependencies.

---

## Install

```bash
npm install @keelstack/guard
```

> **Requirements:** Node.js ≥ 20 · TypeScript ≥ 5 (optional but recommended)

---

## Quick start

### 1 — Idempotency gate

Stop duplicate emails, charges, and records.

```typescript
import { guard } from '@keelstack/guard';

// Agent calls sendWelcomeEmail(). Network blips. Framework retries.
// Without guard → email sent twice.
// With guard    → second call returns cached result. Email sent once.

const result = await guard({
  key: `send-welcome:${userId}`,       // stable, unique per operation
  action: () => resend.emails.send({
    to: user.email,
    subject: 'Welcome to the app!',
  }),
});

console.log(result.status);    // "executed" | "replayed"
console.log(result.fromCache); // false | true
```

That's it. Same key on retry → action skipped, cached result returned.

---

### 2 — Budget enforcer

Stop runaway agent costs.

```typescript
const result = await guard({
  key: `ai-call:${userId}:${requestId}`,
  action: () => openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
  }),
  budget: {
    id: userId,             // per-user budget
    limitUsd: 2.00,         // hard cap: $2.00 per day
    warnAt: [0.5, 0.8],     // callbacks at 50% and 80%
    onWarn: ({ percentUsed, id }) =>
      console.warn(`User ${id}: ${(percentUsed * 100).toFixed(0)}% of AI budget used`),
  },
  extractCost: (res) => (res.usage.total_tokens / 1_000_000) * 15, // gpt-4o rate
});

if (result.status === 'blocked:budget') {
  return Response.json({ error: 'Daily AI limit reached' }, { status: 429 });
}
```

---

### 3 — Risk gate

Stop irreversible agent actions.

```typescript
const result = await guard({
  key: `delete-account:${userId}`,
  action: () => db.users.delete({ where: { id: userId } }),
  risk: {
    level: 'irreversible',   // 'safe' | 'reversible' | 'irreversible'
    policy: 'block',         // 'allow' | 'log' | 'warn' | 'block'
    onRisk: (info) =>
      auditLog.write({ key: info.key, level: info.level, blocked: info.blocked }),
  },
});

if (result.status === 'blocked:risk') {
  return Response.json({ error: 'Action blocked by risk policy' }, { status: 403 });
}
```

---

## Framework examples

<details>
<summary><strong>Vercel AI SDK</strong></summary>

```typescript
import { tool } from 'ai';
import { guard } from '@keelstack/guard';
import { z } from 'zod';

const sendEmailTool = tool({
  description: 'Send a confirmation email to the user',
  parameters: z.object({ userId: z.string(), subject: z.string() }),
  execute: async ({ userId, subject }) => {
    return guard({
      key: `send-email:${userId}:${subject}`,
      action: () => resend.emails.send({ to: await getEmail(userId), subject }),
    });
  },
});
```

</details>

<details>
<summary><strong>LangGraph.js</strong></summary>

```typescript
import { tool } from '@langchain/core/tools';
import { guard } from '@keelstack/guard';
import { z } from 'zod';

const chargeUserTool = tool(
  async ({ userId, amountUsd, invoiceId }) => {
    const result = await guard({
      key: `stripe-charge:${invoiceId}`,
      action: () => stripe.charges.create({ amount: amountUsd * 100, currency: 'usd' }),
      risk: { level: 'irreversible', policy: 'log' },
    });
    return result.value;
  },
  {
    name: 'charge_user',
    schema: z.object({ userId: z.string(), amountUsd: z.number(), invoiceId: z.string() }),
  }
);
```

</details>

<details>
<summary><strong>Mastra</strong></summary>

```typescript
import { createTool } from '@mastra/core';
import { guard } from '@keelstack/guard';
import { z } from 'zod';

export const sendNotificationTool = createTool({
  id: 'send-notification',
  inputSchema: z.object({ userId: z.string(), message: z.string(), runId: z.string() }),
  execute: async ({ context }) => {
    return guard({
      key: `notify:${context.userId}:${context.runId}`,
      action: () => pushService.send({ to: context.userId, body: context.message }),
    });
  },
});
```

</details>

<details>
<summary><strong>OpenAI Agents SDK</strong></summary>

```typescript
import { tool } from '@openai/agents';
import { guard } from '@keelstack/guard';
import { z } from 'zod';

const sendInvoiceTool = tool({
  name: 'send_invoice',
  description: 'Send a payment invoice to a customer',
  parameters: z.object({ customerId: z.string(), invoiceId: z.string() }),
  execute: async ({ customerId, invoiceId }) => {
    const result = await guard({
      key: `invoice:${invoiceId}`,
      action: () => stripe.invoices.send(invoiceId),
      risk: { level: 'irreversible', policy: 'log' },
    });
    return result.value;
  },
});
```

</details>

<details>
<summary><strong>Raw fetch / custom agent loop</strong></summary>

```typescript
import { guard } from '@keelstack/guard';

// Works with any async function — no framework required
async function agentStep(userId: string, stepId: string) {
  return guard({
    key: `agent-step:${userId}:${stepId}`,
    action: async () => {
      const response = await fetch('https://api.example.com/trigger', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
      return response.json();
    },
  });
}
```

</details>

---

## API reference

### `guard(options)`

```typescript
async function guard<T>(options: GuardOptions<T>): Promise<GuardResult<T>>
```

#### Options

| Option | Type | Required | Default | Description |
|--------|------|:--------:|---------|-------------|
| `key` | `string` | ✅ | — | Idempotency key. Unique per logical operation. |
| `action` | `() => Promise<T>` | ✅ | — | The async action to protect. |
| `ttlMs` | `number` | — | `86_400_000` | How long to cache the result (ms). |
| `budget` | `BudgetConfig` | — | — | Per-user spend limit configuration. |
| `extractCost` | `(result: T) => number` | — | — | Extract USD cost from result. Required when using `budget`. |
| `risk` | `RiskConfig` | — | — | Action risk classification and policy. |
| `failure` | `FailureConfig` | — | — | Behavior when the action throws. |
| `ledger` | `Ledger` | — | `MemoryLedger` | Custom storage backend (e.g. Redis). |
| `budgetStore` | `BudgetStore` | — | `MemoryBudgetStore` | Custom budget store. |

#### Result

```typescript
type GuardResult<T> = {
  status:      'executed' | 'replayed' | 'blocked:budget' | 'blocked:risk';
  value?:      T;          // present when executed or replayed
  fromCache:   boolean;
  replayCount: number;
  budgetInfo?: { id: string; spent: number; limit: number; percentUsed: number };
  riskInfo?:   { key: string; level: string; policy: string; blocked: boolean };
}
```

#### BudgetConfig

```typescript
type BudgetConfig = {
  id:       string;     // budget owner — userId, agentId, tenantId
  limitUsd: number;     // hard cap per window
  warnAt?:  number[];   // thresholds 0–1; onWarn fires at each
  onWarn?:  (info: BudgetWarnInfo) => void | Promise<void>;
}
```

#### RiskConfig

```typescript
type RiskConfig = {
  level:    'safe' | 'reversible' | 'irreversible';
  policy?:  'allow' | 'log' | 'warn' | 'block';  // default: safe→allow, reversible→log, irreversible→warn
  onRisk?:  (info: RiskInfo) => void | Promise<void>;
}
```

---

## Storage backends

### Default: in-memory

Zero config. Works immediately. Process-local; resets on restart.

```typescript
import { guard, MemoryLedger } from '@keelstack/guard';

// Shared default — no setup needed
await guard({ key: 'my-op', action });

// Isolated instance (recommended in tests)
const ledger = new MemoryLedger();
await guard({ key: 'my-op', action, ledger });
```

### Production: bring your own Redis adapter

Implement the `Ledger` interface with any persistent backend:

```typescript
import type { Ledger, LedgerEntry } from '@keelstack/guard';
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const redisLedger: Ledger = {
  async get(key) {
    const raw = await redis.get(`guard:${key}`);
    return raw ? (JSON.parse(raw) as LedgerEntry) : undefined;
  },
  async set(key, entry) {
    const ttlSec = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
    await redis.set(`guard:${key}`, JSON.stringify(entry), { EX: ttlSec || undefined });
  },
  async delete(key) { await redis.del(`guard:${key}`); },
  async list() {
    const keys = await redis.keys('guard:*');
    const entries = await Promise.all(keys.map(k => redis.get(k)));
    return entries.flatMap(e => (e ? [JSON.parse(e) as LedgerEntry] : []));
  },
  async prune() { return 0; }, // Redis TTL handles expiry
};

await guard({ key: 'my-op', action, ledger: redisLedger });
```

> A first-party `@keelstack/guard-redis` adapter is on the roadmap. [Star the repo](https://github.com/KeelStack-me/guard) to follow progress.

---

## Testing

`MemoryLedger` and `MemoryBudgetStore` are exported so tests stay isolated and fast:

```typescript
import { guard, MemoryLedger, MemoryBudgetStore } from '@keelstack/guard';
import { describe, it, expect, vi } from 'vitest';

describe('sendEmail tool', () => {
  it('does not send twice on retry', async () => {
    const ledger = new MemoryLedger();
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-123' });

    const opts = { key: 'test:welcome:user-1', action: sendEmail, ledger };

    const first  = await guard(opts);
    const second = await guard(opts); // retry

    expect(sendEmail).toHaveBeenCalledOnce(); // ← action ran once
    expect(first.status).toBe('executed');
    expect(second.status).toBe('replayed');
    expect(second.fromCache).toBe(true);
  });

  it('blocks when budget is exhausted', async () => {
    const ledger      = new MemoryLedger();
    const budgetStore = new MemoryBudgetStore();
    const callApi     = vi.fn().mockResolvedValue({ usage: { total_tokens: 999_999 } });

    const opts = {
      key: `ai:user-1:req-1`,
      action: callApi,
      ledger,
      budgetStore,
      budget: { id: 'user-1', limitUsd: 0.01 },
      extractCost: () => 999, // way over limit
    };

    await guard(opts);

    const blocked = await guard({ ...opts, key: 'ai:user-1:req-2' });
    expect(blocked.status).toBe('blocked:budget');
    expect(callApi).toHaveBeenCalledOnce(); // second call never hit the API
  });
});
```

---

## Key construction guide

A good idempotency key is **stable**, **unique per logical operation**, and **scoped to the right boundary**.

```typescript
// ✅ Stable and unique per operation
key: `send-email:${userId}:${taskId}`
key: `stripe-charge:${invoiceId}`
key: `ai-call:${userId}:${conversationId}:${turnIndex}`
key: `delete-record:${recordId}:${requestId}`

// ❌ Changes on every retry — defeats the purpose
key: `op-${Date.now()}`
key: `op-${Math.random()}`

// ❌ Too broad — deduplicates across unrelated operations
key: `send-email`
```

---

## Why `@keelstack/guard` and not DIY?

| Approach | Duplicate protection | Budget control | Risk gate | Framework coupling | Setup time |
|---|:---:|:---:|:---:|:---:|:---:|
| **`@keelstack/guard`** | ✅ | ✅ | ✅ | None | 5 min |
| Redis `SET NX` by hand | ✅ | ❌ | ❌ | None | ~2 days |
| LangGraph HITL | ❌ | ❌ | Partial | LangGraph only | — |
| OpenAI guardrails | ❌ | ❌ | Partial | OpenAI hosted only | — |
| Helicone / Langfuse | ❌ (observe only) | ❌ | ❌ | Varies | — |
| Nothing | ❌ | ❌ | ❌ | — | — |

The gap: **framework-agnostic, TypeScript-native, wraps any `async () => T` with all three primitives.** No vendor lock-in. Works wherever your agent runs.

---

## Package quality

| Metric | Value |
|--------|-------|
| Tests | 37 passing, 0 failing |
| Statement coverage | 98.33% |
| Branch coverage | 92.04% |
| Function coverage | 94.44% |
| Runtime dependencies | **0** |
| Packed size | **15.3 KB** |
| Node.js | ≥ 20 |
| TypeScript | ≥ 5 |
| Framework examples included | Vercel AI SDK, LangGraph.js, Mastra, OpenAI Agents SDK |
| CI matrix | Node 20, 22 |

CI runs typecheck → test → coverage → build on every push. Publishes to npm on `v*.*.*` tags.

---

## Current behavior and known limits

- The default in-memory ledger is **process-local** — it resets on restart and does not deduplicate across multiple instances.
- Cross-instance deduplication requires a shared persistent ledger (e.g. Redis). See the [storage backends](#storage-backends) section.
- Simultaneous same-key calls are lock-joined within a single process.
- Cross-process race safety depends on your shared ledger implementation.
- `policy: 'log'` fires `onRisk` but does not log by itself — implement logging in the callback.
- Failed actions are rethrown and not cached by default (`failure.policy: 'retry'`).

---

## Roadmap

- [x] Idempotency gate with in-memory ledger
- [x] Budget enforcer with in-memory store
- [x] Risk gate with policy + callback hooks
- [x] Full TypeScript types shipped
- [x] 98% test coverage, Node 20/22 CI
- [ ] `@keelstack/guard-redis` — first-party Redis ledger adapter
- [ ] Hosted dashboard — visualise blocked duplicates and budget usage per user
- [ ] OpenTelemetry spans per guard call

---

## Built by a 17-year-old who kept watching agents send emails twice

I'm Siddhant. I was building an AI-enabled SaaS product and kept hitting the same problem: my agent would retry a timed-out tool call and the side effect — an email, a charge, a database write — would execute again. I looked for a drop-in fix. Nothing existed that was framework-agnostic, TypeScript-native, and small enough to audit in an afternoon.

So I built it. The source is intentionally small and readable. You can read all of it. MIT license. No magic.

If this saves you from a duplicate charge or a $200 overnight bill, please give it a ⭐ — it genuinely helps.

→ [guard.keelstack.me](https://guard.keelstack.me) · [@KeelStack-me](https://github.com/KeelStack-me)

---

## Contributing

Issues and PRs are welcome.

**To contribute:**

1. Fork the repo and create a branch: `git checkout -b feature/your-feature`
2. Install deps: `npm install`
3. Run tests: `npm test` — all 37 must pass before submitting
4. Run coverage: `npm run test:coverage` — branch coverage must stay ≥ 90%
5. Open a PR with a clear description of the change and why

Please open an issue before starting a large PR so we can align on approach.

**Good first issues:** look for the [`good first issue`](https://github.com/KeelStack-me/guard/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label.

---

## License

MIT © [Siddhant Jain](https://github.com/siddhant-jain-18)