# TDD 0006: Tool Registry

Status: implemented
PRD refs: 4.3, 6
PRD-rev: 10391ba
ADR constraints: 0003, 0008, 0009, 0012, 0013
Author: maintainers
Date: 2026-05-19
Related TDDs: [0005 (state schema — superseded)](./0005-state-schema.md), [0007 (Foundry-as-source-of-truth)](./0007-foundry-as-source-of-truth.md)

**Amendment (2026-05-19):** The "Starter tools" table below was rewritten after design doc 0007 moved mechanical state to Foundry. The dispatcher mechanics (registry shape, validation, audit, telemetry, operator-gating) are unchanged. The set of _which tools ship as core in alpha_ shrank — D&D-specific mutation tools were deferred to the Foundry plugin (Phase 3, in `plugins/vtt-foundry/`) where they're registered conditionally at session start based on Foundry's active system. Skeinkeeper's core registers only system-agnostic tools.

## Approach

ADR-0003 says the LLM mutates nothing directly — every dice roll and every state change is a typed tool call. This design lands the registry + dispatcher that makes that real, plus the starter tools the alpha needs.

The dispatcher's job is to (a) validate every call against the tool's declared schema, (b) execute deterministic code, (c) write an audit log entry, (d) emit a telemetry event for the call, and (e) return the result for the model to narrate over. None of that depends on which LLM provider is wired in (Phase 1.5) — the registry just exposes "what tools exist, what they accept, what they return."

## Components & interfaces

### Registry shape

```ts
import { z } from "zod";

export interface ToolHandlerContext {
  tenantDb: TenantDb; // scoped to current operator
  sessionId: string;
  turnId: string;
}

export interface ToolDefinition<Input, Output> {
  readonly name: string; // snake_case; matches LLM tool-call name
  readonly description: string; // shown to the model in the prompt
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
  async dispatch(
    call: { name: string; input: unknown },
    ctx: ToolHandlerContext,
  ): Promise<ToolResult>;
}

export type ToolResult =
  | { ok: true; output: unknown; latencyMs: number }
  | {
      ok: false;
      error: string;
      kind: "unknown_tool" | "invalid_input" | "handler_error" | "operator_gated";
    };
```

For every dispatch the dispatcher:

1. Looks up the tool by name. Unknown → `unknown_tool` failure logged + reported.
2. Parses input against the tool's Zod schema. Failure → `invalid_input` with the Zod error.
3. Checks `operatorGated`. If set and the call isn't operator-blessed, fail with `operator_gated`.
4. Calls `handle(input, ctx)` and times it.
5. Writes an audit-log row: `actor = "tool:" + tool.name`, `eventType = "tool_called"`, `payloadJson = { input, output, durationMs }`. Per ADR-0003 every mutation is auditable.
6. Emits `tool.called { toolName, success, latencyMsBucket }` via the analytics client when present. Bucket boundaries: `<50`, `<250`, `<1000`, `<5000`, `>=5000`.

### Schemas live with the tools

Each tool file exports its `ToolDefinition`. The registry's `seedDefaults()` helper registers all of them. This keeps schemas, descriptions, and handlers co-located — when a contributor changes a tool, they change one file.

## Data & state

### Starter tools (post-Foundry-as-source-of-truth)

Two categories of tools:

**Core, system-agnostic** — registered by `createDefaultRegistry()` in `orchestrator/src/tools/index.ts`. These mutate Skeinkeeper's SQLite or signal the voice/audit layers.

| Tool             | Input                                                  | Output                                                              | Effect                                                                                                                      |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `roll`           | `{ formula: string, speaker?: string, secret?: bool }` | `{ total: number, rolls: number[], formula: string, secret: bool }` | Phase 3: delegates to `FoundryClient.rollDice()` so rolls land in Foundry's chat log. Until then, audit-only stub.          |
| `set_quest_flag` | `{ campaignId, key, value: string }`                   | `{ campaignId, key, value }`                                        | `quest_flags` upsert (Skeinkeeper-internal plot state).                                                                     |
| `move_party`     | `{ campaignId, locationId }`                           | `{ campaignId, locationId }`                                        | Records `party.location` quest flag; Phase 3 also activates the matching Foundry scene.                                     |
| `advance_time`   | `{ campaignId, minutes: int }`                         | `{ campaignId, minutesElapsed }`                                    | Accumulates `time.minutes_elapsed` quest flag for AI-side time awareness.                                                   |
| `whisper`        | `{ targetPlayerDiscordId: PII<string>, content }`      | `{ delivered: bool }`                                               | Audit entry; voice plugin consumes from audit log to DM the target player.                                                  |
| `fudge_roll`     | `{ originalTotal, newTotal, reason }`                  | `{ accepted: bool }`                                                | Operator-gated meta-mechanic; the LLM may not invoke it unless the orchestrator flips the per-session "fudge allowed" flag. |

**Foundry-routed, system-specific** — registered at session start by `plugins/vtt-foundry/` (Phase 3) once the active Foundry system is known. These translate to MCP calls and mutate state on Foundry's side. Examples:

| Foundry system  | Tools                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `dnd5e`         | `apply_damage`, `heal`, `set_condition`, `clear_condition`, `update_inventory`, `update_npc_disposition` |
| `fate-core`     | `apply_stress`, `take_consequence`, `invoke_aspect`, `compel_aspect`                                     |
| `dungeon-world` | `apply_harm`, `tick_harm_clock`, `mark_debility`, `tick_progress_clock`                                  |

The Foundry-routed tools land in Phase 3 alongside the real `McpFoundryClient` implementation. They're tested today via the orchestrator's `MockFoundryClient` (per design doc 0007).

`fudge_roll` is `operatorGated: true` — the LLM may not invoke it unless the orchestrator has flipped the per-session "fudge allowed" flag, which Phase 5 wires.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Telemetry implications

Adds no new events beyond `tool.called` and `error.captured`, both already in the registry. The dispatcher attaches no PII to events (the bucketed latency + boolean success are the entire payload).

## Privacy implications

- `whisper.targetPlayerDiscordId` is `PII<string>`. The audit-log row stores it (the operator already has access; this is local data). The audit-log `payloadJson` is now AEAD-encrypted at rest when a passphrase is set ([TDD 0030](./0030-pii-column-encryption.md)).
- All other tool inputs are operator-scoped IDs and integers; no PII concerns.

## Eval implications

The eval harness gets new expectation kinds (deferred to Phase 1.6 / first real fixture, but enumerated here for context): `tool_called(name)`, `tool_not_called(name)`, `state_change(path)`. The harness can already capture tool calls via the dispatcher's audit-log writes; the expectation parsers come later.

## Open questions

- **Idempotency.** If the LLM retries a tool call (network blip), do we deduplicate? For alpha: no, every dispatch is independent. Add a per-turn dedupe key if real cases emerge.
- **Tool-call timeouts.** Defer; for alpha all tools are local-DB writes and complete in milliseconds.
- **Cross-tool transactions.** If a tool needs to mutate multiple tables atomically, wrap in `db.transaction(...)`. Currently no starter tool needs this; the API is available when one does.

## Requirement traceability

| PRD ref | Requirement                                                                          | Satisfied by                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.3     | All LLM state mutations via typed tool calls (per ADR-0003)                          | `ToolRegistry` + `ToolDispatcher` — every call validated against Zod schema, audited, and telemetry-emitted; LLM cannot mutate state via free text |
| 4.3     | Tool inputs are schema-validated                                                     | `ToolDefinition.inputSchema: z.ZodType<Input>` enforced by dispatcher step 2; defense-in-depth against malformed LLM args                          |
| 6       | Starter tool set for alpha (roll, quest flags, party movement, time, whisper, fudge) | Core system-agnostic tools in `createDefaultRegistry()`; Foundry-routed system-specific tools deferred to Phase 3 plugin                           |
| 6       | Operator-gated tools (fudge_roll cannot be invoked by LLM without operator consent)  | `operatorGated?: boolean` flag on `ToolDefinition`; dispatcher enforces at step 3                                                                  |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this design directly implements ADR-0003 (tool-call-only mutation) and ADR-0009 (telemetry opt-in); no PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the durable decisions here are already captured in ADR-0003 (tool-call-only mutation) and ADR-0009 (telemetry opt-in).

## Alternatives considered

- **Make tools class-based with method handlers.** Plain objects + Zod are simpler to test and keep the surface boring.
- **Skip Zod, hand-validate.** Rejected: every tool would need duplicate validation code; the LLM can hand us malformed args at any time.
- **Run handlers in a sandbox.** Premature; the handlers are first-party code. Sandboxing matters when we accept user-authored tools, deferred to v2.
