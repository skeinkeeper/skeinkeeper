# TDD 0014: McpFoundryClient (Phase 3)
Status: implemented
PRD refs: 4.2
PRD-rev: 10391ba
ADR constraints: 0004, 0011, 0012
Author: maintainers
Date: 2026-05-19
Related TDDs: [0007 (Foundry-as-source-of-truth)](./0007-foundry-as-source-of-truth.md), [0008 (LLM provider interface)](./0008-llm-provider-interface.md)

## Approach

Design doc 0007 made Foundry authoritative for mechanical state, accessed through the `FoundryClient` interface, with `MockFoundryClient` for tests and a real MCP-backed client deferred to Phase 3. ADR-0011 chose the `adambdooley/foundry-vtt-mcp` bridge. This phase builds the real `McpFoundryClient`.

Doc 0007 left an explicit open question: *"Will the chosen MCP bridge cover everything we need? ... If gaps exist, we contribute upstream or fork."* Phase 3 answers it by inventorying the bridge's actual 44-tool surface (read from its source, `packages/mcp-server/src/`).

## The bridge's tool surface

**Reads (map cleanly to FoundryClient):**
- `list-characters` → `listPartyActors()`
- `get-character` / `get-character-entity` → `getActor()`
- `get-current-scene` → `getActiveScene()`
- `get-token-details` → `listSceneActors()`
- `list-scenes`, `get-world-info`, `get-available-conditions` → supporting reads

**Mutations (partial):**
- `toggle-token-condition` → conditions (frightened, prone, etc.)
- `move-token` / `update-token` → token position
- `add-actor-items`, `use-item` → inventory + item activation
- `switch-scene`, `delete-tokens`, `create-actor-from-compendium` → scene/actor management
- `assign-actor-ownership` / `remove-actor-ownership` → permissions
- `request-player-rolls` → **interactive** rolls (prompts a human in Foundry)

**Content/quests:** `create-quest-journal`, `search-compendium`, `list-creatures-by-criteria`, etc.

## The mutation gap (the doc-0007 finding)

The bridge has **no generic actor-update tool and no direct HP/damage-set tool, and no server-side dice roll.** This is a deliberate bridge design: it favors *driving Foundry's own mechanics* (cast a spell via `use-item`, which makes Foundry apply the damage) over *poking raw values* (set `hp.value = 5`). Two consequences for Skeinkeeper:

1. **`FoundryClient.applyActorUpdate` can't generically set HP.** The `McpFoundryClient` maps the updates the bridge *does* support (conditions → `toggle-token-condition`, position → `update-token`) and throws an explicit, actionable error for unsupported updates (notably direct HP). The D&D-5e-routed `apply_damage` tool (from doc 0007 §"Tool-call dispatch") therefore can't be a single bridge call — it must either drive `use-item`, or be applied operator-side, or the bridge must be forked to add an `update-actor` tool.

2. **`FoundryClient.rollDice` has no server-side counterpart.** The bridge's only roll tool is interactive (`request-player-rolls`). `McpFoundryClient.rollDice` throws; the orchestrator's `roll` tool keeps using its local `crypto.randomInt` roller (already the Phase-1 behavior) rather than routing through Foundry. Rolls don't land in Foundry's chat log this way — a UX trade-off, not a correctness one.

**This is a decision point for the operator/maintainer**, surfaced not silently worked around:
- **(a)** Accept the gap for alpha: conditions/tokens/scenes via the bridge; damage via `use-item` or operator; rolls local. Lowest effort; some Foundry-native niceties lost.
- **(b)** Fork the bridge to `skeinkeeper/foundry-mcp-bridge` and add `update-actor` + `roll-dice` tools. The fork-as-Plan-B clause in ADR-0011 covers this; bounded effort.
- **(c)** Evaluate whether `laurigates/foundryvtt-mcp` (the alternative bridge from ADR-0011) has a server-side roll + actor-update surface; if so, switch.

The recommendation is **(a) for the alpha** — get a session working end-to-end with the read-heavy + conditions/tokens mutation surface, then decide (b)/(c) once real play reveals which gaps actually bite.

## Components & interfaces

### Injectable `McpToolCaller`

```ts
export interface McpToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
```

`McpFoundryClient` depends only on this one-method interface, so it's fully unit-testable without spawning a subprocess or pulling in the MCP SDK. `FakeMcpToolCaller` (scripted responses) drives the tests.

### `McpFoundryClient implements FoundryClient`

Read methods call the bridge's read tools and parse the responses into `FoundryActor`/`FoundryScene`. The parsers are defensive (try multiple field names: `id`/`_id`, `system`/`sheet`, `characters`/`actors`/`data`) because the bridge's exact payload shape must be validated against a live Foundry (Phase 3-live) — the unit tests prove the parsers map a given shape correctly; live testing confirms the shape.

`McpFoundryClient.connect(caller)` derives the active system from `get-world-info`.

### Deferred to Phase 3-live

The real `McpToolCaller` that spawns the bridge MCP server (`node ~/foundry-vtt-mcp/packages/mcp-server/dist/index.js`) and speaks MCP over stdio via `@modelcontextprotocol/sdk`. This adds a dependency and can only be validated against a live Foundry + bridge + the bridge's Foundry-side module installed. The injectable design means dropping it in later is additive — `new McpFoundryClient(realCaller, system)` — with zero changes to the read/parse logic.

Also deferred: confirming the bridge's exact response field names against live data (and adjusting the parsers if they differ from the assumed shape).

## Data & state

No new persistent state in Skeinkeeper. Foundry data stays on the operator's Foundry instance; `McpFoundryClient` reads it per turn and never persists actor sheets in Skeinkeeper's store (per doc 0007). No PII enters Skeinkeeper's DB via this client.

## Sequencing / implementation plan

Covered under Approach and Components & interfaces. Phase 3-live (real `McpToolCaller` + live Foundry validation) follows this commit.

## Failure modes & edge cases

- **`applyActorUpdate` for unsupported field (e.g., direct HP):** throws explicit, actionable error — not a silent drop. Operator sees the rejection and can override.
- **`rollDice`:** throws explicitly; orchestrator's `roll` tool uses local `crypto.randomInt`. Rolls don't land in Foundry's chat log (UX trade-off, not a correctness issue).
- **Bridge payload field names differ from assumed shape:** parsers are defensive (try multiple field names); confirmed against live Foundry in Phase 3-live.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.2 | Scene activation, token management, combat tracker, dice, compendium access, chat | `McpFoundryClient` maps bridge's 44-tool surface to `FoundryClient`; reads and condition/token/scene mutations covered; gaps (direct HP, server-side roll) explicitly surfaced with actionable errors |
| 4.2 | Foundry integration via self-hosted OSS MCP bridge (ADR-0011) | `McpFoundryClient` consumes `adambdooley/foundry-vtt-mcp` bridge via `McpToolCaller` interface; real transport deferred to Phase 3-live |
| 4.2 | Skeinkeeper connects to operator's own Foundry instance | `McpFoundryClient.connect(caller)` receives the caller from outside; no Foundry URL baked in; operator configures the bridge path |

## Dependencies considered

- **`@modelcontextprotocol/sdk`** — the real MCP transport (stdio over subprocess). Deferred to Phase 3-live to avoid coupling the testable mapping logic to an un-mockable subprocess transport. The `McpToolCaller` seam keeps them separate.
- **`adambdooley/foundry-vtt-mcp` (chosen, ADR-0011) vs. `laurigates/foundryvtt-mcp` (alternative).** ADR-0011 chose `adambdooley`; option (c) above revisits `laurigates` if live play reveals the mutation gaps are unacceptable.

## PRD conflicts surfaced (and resolution)

None — the mutation gap (no generic actor-update, no server-side dice roll) is a bridge limitation surfaced by this phase and presented as a decision point (a/b/c), not a PRD conflict. PRD §4.2 requires the functional surface; the bridge's approach to providing it differs from what was assumed, but the alpha recommendation (option a) is a valid starting point.

## Decisions to promote (ADR candidates)

None — the mutation-gap decision (a/b/c) is presented as a choice for the operator/maintainer after live play; if (b) or (c) is chosen, a superseding ADR to ADR-0011 would be the right vehicle.

## Alternatives considered

- **Depend on `@modelcontextprotocol/sdk` directly in McpFoundryClient.** Rejected — couples the testable mapping logic to an un-mockable subprocess transport. The `McpToolCaller` seam keeps them separate.
- **Skip McpFoundryClient until live Foundry is wired.** Rejected — the FoundryClient mapping + the bridge-gap finding are valuable now and shouldn't wait on live hardware. The mock-driven tests cover the mapping; the gap finding informs the fork/no-fork decision.
- **Generically `applyActorUpdate` by writing raw Foundry document paths.** Rejected — the bridge doesn't expose a raw-update tool; there's nothing to call.

## Telemetry implications

None new this phase. When Phase 3-live wires the real transport, `error.captured` will cover bridge connection/transport failures, and tool-call latency to the bridge flows into the existing `tool.called` bucket per doc 0007.

## Privacy implications

None new. Foundry data stays on the operator's Foundry instance; `McpFoundryClient` reads it per turn and never persists actor sheets in Skeinkeeper's store (per doc 0007). No PII enters Skeinkeeper's DB via this client.

## Eval implications

`McpFoundryClient` is unit-tested (12 tests) via `FakeMcpToolCaller`: system discovery, party/actor/scene reads with multiple response shapes, the condition-update mapping, and the two mutation-gap rejections (direct HP, server-side roll). A live-Foundry integration test is Phase 3-live and runs against the operator's instance, not CI.

## Open questions

- **Exact bridge payload shapes.** The parsers assume reasonable field names; live validation may require adjustment. Tracked in Phase 3-live.
- **The mutation-gap decision (a/b/c above).** Needs an operator call after a first live session reveals which gaps actually matter.
- **`listSceneActors` mapping.** Currently calls `get-token-details`; whether that returns full actor records or just token stubs (requiring a follow-up `get-character` per token) needs live confirmation.
