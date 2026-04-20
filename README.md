# @keelstack/guard

**Guardrails that stop repeated AI tool calls from causing duplicate actions and runaway costs.**

[![npm version](https://img.shields.io/npm/v/@keelstack/guard)](https://www.npmjs.com/package/@keelstack/guard)
[![test status](https://img.shields.io/github/actions/workflow/status/KeelStack-me/guard/ci.yml?label=tests)](https://github.com/KeelStack-me/guard/actions)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/KeelStack-me/guard)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## The problem

Your AI agent retries a tool call. The email sends twice. The charge fires twice. The record duplicates.

Every agent framework — LangGraph, Vercel AI SDK, Mastra, OpenAI Agents SDK — retries failed or timed-out tool calls. None of them prevent the duplicate side effects those retries cause.

`@keelstack/guard` wraps any tool call with three primitives:

1. **Idempotency gate** — the action runs at most once per key, even across retries
2. **Budget enforcer** — blocks the action if per-user spend is exceeded
3. **Risk gate** — logs, warns, or blocks based on action risk level

Zero config. Zero framework coupling. Works with any `async () => T`.

---

## Install

```bash
npm install @keelstack/guard
```

**Requirements:** Node.js ≥ 20, TypeScript ≥ 5 (optional but recommended)

---

## Quick start

### 1. Idempotency — stop duplicate emails, charges, records

```typescript
import { guard } from '@keelstack/guard';

// Agent calls sendWelcomeEmail(). Network blips. Agent retries.
// Without guard → email sent twice.
// With guard    → second call returns cached result. Email sent once.

const result = await guard({
  key: `send-welcome:${userId}`,          // stable, unique per operation
  action: () => resend.emails.send({
    to: user.email,
    subject: 'Welcome to the app!',
  }),
});

console.log(result.status);    // "executed" | "replayed"
console.log(result.fromCache); // false | true
```

That's it. If the agent retries with the same `key`, the action is skipped and the stored result is returned.

---

### 2. Budget enforcer — stop runaway AI costs

```typescript
const result = await guard({
  key: `ai-call:${userId}:${requestId}`,
  action: () => openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
  }),
  budget: {
    id: userId,           // per-user budget
    limitUsd: 2.00,       // hard cap: $2 per day
    warnAt: [0.5, 0.8],   // warn at 50% and 80%
    onWarn: ({ percentUsed, id }) => {
      console.warn(`User ${id} has used ${(percentUsed * 100).toFixed(0)}% of their AI budget`);
    },
  },
  extractCost: (res) => {
    // Tell the guard how much this call cost
    const tokens = res.usage?.total_tokens ?? 0;
    return (tokens / 1_000_000) * 15; // gpt-4o pricing
  },
});

if (result.status === 'blocked:budget') {
  return Response.json({
    error: 'Daily AI budget exceeded',
    spent: result.budgetInfo?.spent,
    limit: result.budgetInfo?.limit,
  }, { status: 429 });
}
```

---

### 3. Risk gate — log, warn, or block irreversible actions

```typescript
const result = await guard({
  key: `delete-account:${userId}`,
  action: () => db.users.delete({ where: { id: userId } }),
  risk: {
    level: 'irreversible',   // 'safe' | 'reversible' | 'irreversible'
    policy: 'block',         // 'allow' | 'log' | 'warn' | 'block'
    onRisk: (info) => {
      auditLog.write({ key: info.key, level: info.level, blocked: info.blocked });
    },
  },
});

if (result.status === 'blocked:risk') {
  return Response.json({ error: 'Action blocked by risk policy' }, { status: 403 });
}
```

---

## Framework examples

### Vercel AI SDK

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

### LangGraph.js

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

### Mastra

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

---

## API reference

### `guard(options)`

```typescript
async function guard<T>(options: GuardOptions<T>): Promise<GuardResult<T>>
```

#### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `key` | `string` | ✅ | Idempotency key. Unique per logical operation. |
| `action` | `() => Promise<T>` | ✅ | The async action to protect. |
| `ttlMs` | `number` | — | How long to cache the result (ms). Default: `86_400_000` (24h). |
| `budget` | `BudgetConfig` | — | Per-user spend limit. See below. |
| `extractCost` | `(result: T) => number` | — | Extract USD cost from result. Required for budget tracking. |
| `risk` | `RiskConfig` | — | Action risk classification and policy. |
| `ledger` | `Ledger` | — | Custom storage backend. Default: in-memory. |
| `budgetStore` | `BudgetStore` | — | Custom budget store. Default: in-memory. |

#### Result

```typescript
{
  status: 'executed' | 'replayed' | 'blocked:budget' | 'blocked:risk';
  value?: T;           // present when executed or replayed
  fromCache: boolean;
  replayCount: number;
  budgetInfo?: { id, spent, limit, percentUsed }; // when blocked:budget
  riskInfo?: { key, level, policy, blocked };      // when blocked:risk
}
```

#### BudgetConfig

```typescript
{
  id: string;          // budget owner (userId, agentId, tenantId)
  limitUsd: number;    // max spend per window
  warnAt?: number[];   // thresholds 0–1 to trigger onWarn. Default: [0.5, 0.8]
  onWarn?: (info: BudgetWarnInfo) => void | Promise<void>;
}
```

#### RiskConfig

```typescript
{
  level: 'safe' | 'reversible' | 'irreversible';
  policy?: 'allow' | 'log' | 'warn' | 'block';  // default per level below
  onRisk?: (info: RiskInfo) => void | Promise<void>;
}
```

Default policies by level: `safe → allow`, `reversible → log`, `irreversible → warn`.

---

## Storage backends

### Default: in-memory

Works immediately. No config. Resets when the process restarts.

```typescript
import { guard, MemoryLedger } from '@keelstack/guard';

// Uses the shared default ledger — no setup needed
const result = await guard({ key: 'my-op', action: myAction });

// Or create an isolated ledger (useful in tests)
const ledger = new MemoryLedger();
const result = await guard({ key: 'my-op', action: myAction, ledger });
```

### Production: bring your own Redis adapter

The package ships a `Ledger` interface. Implement it with any storage backend:

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
    const ttl = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
    await redis.set(`guard:${key}`, JSON.stringify(entry), { EX: ttl || undefined });
  },
  async delete(key) { await redis.del(`guard:${key}`); },
  async list() {
    const keys = await redis.keys('guard:*');
    const entries = await Promise.all(keys.map(k => redis.get(k)));
    return entries.flatMap(e => e ? [JSON.parse(e) as LedgerEntry] : []);
  },
  async prune() { return 0; }, // Redis TTL handles expiry
};

// Pass it to guard
const result = await guard({ key: 'my-op', action: myAction, ledger: redisLedger });
```

A first-party `@keelstack/guard-redis` adapter is coming. [Star the repo](https://github.com/KeelStack-me/guard) to follow progress.

---

## Key construction guide

A good idempotency key is **stable**, **unique per logical operation**, and **scoped to the right boundary**:

```typescript
// ✅ Good — stable and unique per operation
key: `send-email:${userId}:${taskId}`
key: `stripe-charge:${invoiceId}`
key: `ai-call:${userId}:${conversationId}:${turnIndex}`
key: `delete-record:${recordId}:${requestId}`

// ❌ Bad — changes on every retry
key: `op-${Date.now()}`
key: `op-${Math.random()}`

// ❌ Bad — too broad — deduplicates across different users
key: `send-email`
```

---

## Testing

```typescript
import { guard, MemoryLedger, MemoryBudgetStore } from '@keelstack/guard';

describe('my tool', () => {
  it('sends email exactly once on retry', async () => {
    // Use isolated deps so tests don't share state
    const ledger = new MemoryLedger();
    const budgetStore = new MemoryBudgetStore();
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-123' });

    const opts = { key: 'test-op', action: sendEmail, ledger, budgetStore };

    const first = await guard(opts);
    const second = await guard(opts);

    expect(sendEmail).toHaveBeenCalledOnce();   // action ran once
    expect(first.status).toBe('executed');
    expect(second.status).toBe('replayed');
    expect(second.fromCache).toBe(true);
  });
});
```

---

## Roadmap

- [x] Idempotency gate (in-memory)
- [x] Budget enforcer (in-memory)
- [x] Risk gate with HITL webhook
- [ ] `@keelstack/guard-redis` — first-party Redis ledger adapter
- [ ] Hosted dashboard — visualise blocked duplicates and budget usage per user
- [ ] OpenTelemetry spans emitted per guard call

[Follow the build →](https://github.com/KeelStack-me/guard)

---

## Contributing

Issues and PRs are welcome. Please open an issue before submitting a large PR.

---

## License

MIT © [Siddhant Jain](https://github.com/siddhant-jain-18)
