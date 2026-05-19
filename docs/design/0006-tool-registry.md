# Design Doc 0006: Tool Registry

> Status: Accepted
> Author: maintainers
> Date: 2026-05-19
> Related ADRs: [ADR-0003 (tool-call-only mutation)](../adr/0003-tool-call-only-state-mutation.md), [ADR-0008 (tenant scoping)](../adr/0008-tenant-scoping.md), [ADR-0009 (telemetry opt-in)](../adr/0009-telemetry-opt-in.md)
> Related design docs: [0005 (state schema)](./0005-state-schema.md)

## Context

ADR-0003 says the LLM mutates nothing directly — every dice roll and every state change is a typed tool call. This design lands the registry + dispatcher that makes that real, plus the starter tools the alpha needs.

The dispatcher's job is to (a) validate every call against the tool's declared schema, (b) execute deterministic code, (c) write an audit log entry, (d) emit a telemetry event for the call, and (e) return the result for the model to narrate over. None of that depends on which LLM provider is wired in (Phase 1.5) — the registry just exposes "what tools exist, what they accept, what they return."

## Decision

### Registry shape

```ts
import { z } from "zod";

export interface ToolHandlerContext {
  tenantDb: TenantDb;          // scoped to current operator
  sessionId: string;
  turnId: string;
}

export interface ToolDefinition<Input, Output> {
  readonly name: string;            // snake_case; matches LLM tool-call name
  readonly description: string;     // shown to the model in the prompt
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  /** Set true for tools the LLM may not invoke without operator confirmation
   *  (e.g., fudge_roll). The dispatcher rejects when invoked by the LLM
   *  unless the orchestrator has flipped the gate. */
  readonly operatorGated?: boolean;
  handle(input: Input, ctx: ToolHandlerContext): Promise<Output>;
}

export class ToolRegistry {
  register<I, O>(tool: ToolDefinition<I, O>): void;
  list(): ReadonlyArray<ToolDefinition<unknown, unknown>>;
  get(name: string): ToolDefinition<unknown, unknown> | undefined;
}
```

`ToolDispatcher` wraps a registry:

```ts
export class ToolDispatcher {
  constructor(opts: { registry: ToolRegistry; analytics?: AnalyticsClient });
  async dispatch(call: { name: string; input: unknown }, ctx: ToolHandlerContext): Promise<ToolResult>;
}

export type ToolResult =
  | { ok: true; output: unknown; latencyMs: number }
  | { ok: false; error: string; kind: "unknown_tool" | "invalid_input" | "handler_error" | "operator_gated" };
```

For every dispatch the dispatcher:

1. Looks up the tool by name. Unknown → `unknown_tool` failure logged + reported.
2. Parses input against the tool's Zod schema. Failure → `invalid_input` with the Zod error.
3. Checks `operatorGated`. If set and the call isn't operator-blessed, fail with `operator_gated`.
4. Calls `handle(input, ctx)` and times it.
5. Writes an audit-log row: `actor = "tool:" + tool.name`, `eventType = "tool_called"`, `payloadJson = { input, output, durationMs }`. Per ADR-0003 every mutation is auditable.
6. Emits `tool.called { toolName, success, latencyMsBucket }` via the analytics client when present. Bucket boundaries: `<50`, `<250`, `<1000`, `<5000`, `>=5000`.

### Starter tools

The alpha needs these to play. Each lives in `orchestrator/src/tools/<name>.ts`:

| Tool | Input | Output | Mutates |
|---|---|---|---|
| `roll` | `{ formula: string, advantage?: bool, secret?: bool }` | `{ total: number, dice: number[], secret: bool }` | — (audit only) |
| `apply_damage` | `{ characterId: string, amount: int, source?: string }` | `{ characterId, before: number, after: number }` | `characters.hp` |
| `heal` | symmetric to `apply_damage` | symmetric | `characters.hp` (capped at maxHp) |
| `set_condition` | `{ characterId, condition: string }` | `{ characterId, conditions: string[] }` | `characters.rulesetDataJson.conditions` |
| `clear_condition` | symmetric | symmetric | same |
| `update_inventory` | `{ characterId, item: string, delta: int }` | `{ characterId, item, before, after }` | `characters.rulesetDataJson.inventory` |
| `set_quest_flag` | `{ campaignId, key, value: string }` | `{ key, value }` | `quest_flags` upsert |
| `move_party` | `{ campaignId, locationId }` | `{ locationId }` | quest flag `"party.location" = locationId` |
| `update_npc_disposition` | `{ npcId, disposition }` | `{ npcId, disposition }` | `npcs.disposition` |
| `advance_time` | `{ minutes: int }` | `{ minutesElapsed }` | quest flag `"time.minutes_elapsed"` increment |
| `whisper` | `{ targetPlayerDiscordId: PII<string>, content }` | `{ delivered: bool }` | — (audit + stash for VoiceIO) |
| `fudge_roll` | `{ originalTotal, newTotal, reason }` | `{ accepted: bool }` | — (audit + signal to roll system) |

For alpha all twelve are real (non-stub) implementations against the SQLite store from Phase 1.1. `roll` uses Node's `crypto.randomInt` until Phase 3.2 routes it through Foundry MCP. `whisper` writes an audit entry tagged for the voice plugin to consume later. `fudge_roll` is `operatorGated: true` — the LLM may not invoke it unless the orchestrator has flipped the per-session "fudge allowed" flag, which Phase 5 wires.

### Schemas live with the tools

Each tool file exports its `ToolDefinition`. The registry's `seedDefaults()` helper registers all of them. This keeps schemas, descriptions, and handlers co-located — when a contributor changes a tool, they change one file.

### Telemetry implications

Adds no new events beyond `tool.called` and `error.captured`, both already in the registry. The dispatcher attaches no PII to events (the bucketed latency + boolean success are the entire payload).

## Alternatives considered

- **Make tools class-based with method handlers.** Plain objects + Zod are simpler to test and keep the surface boring.
- **Skip Zod, hand-validate.** Rejected: every tool would need duplicate validation code; the LLM can hand us malformed args at any time.
- **Run handlers in a sandbox.** Premature; the handlers are first-party code. Sandboxing matters when we accept user-authored tools, deferred to v2.

## Privacy implications

- `whisper.targetPlayerDiscordId` is `PII<string>`. The audit-log row stores it (the operator already has access; this is local data). When the encryption shim lands, the `payloadJson` for whisper events is a candidate for at-rest encryption.
- All other tool inputs are operator-scoped IDs and integers; no PII concerns.

## Eval implications

The eval harness gets new expectation kinds (deferred to Phase 1.6 / first real fixture, but enumerated here for context): `tool_called(name)`, `tool_not_called(name)`, `state_change(path)`. The harness can already capture tool calls via the dispatcher's audit-log writes; the expectation parsers come later.

## Open questions

- **Idempotency.** If the LLM retries a tool call (network blip), do we deduplicate? For alpha: no, every dispatch is independent. Add a per-turn dedupe key if real cases emerge.
- **Tool-call timeouts.** Defer; for alpha all tools are local-DB writes and complete in milliseconds.
- **Cross-tool transactions.** If a tool needs to mutate multiple tables atomically, wrap in `db.transaction(...)`. Currently no starter tool needs this; the API is available when one does.
