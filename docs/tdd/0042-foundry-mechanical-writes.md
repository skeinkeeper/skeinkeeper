# TDD 0042: Foundry mechanical writes (combat, damage, fog, tokens)

Status: draft
PRD refs: 4.2 (functional surface: combat, damage/heal, fog, token spawn), 4.3, 4.8
PRD-rev: 5c3a198
ADR constraints: 0003, 0012, 0018, 0023, 0029, 0030
Author: maintainers
Date: 2026-08-15
Related TDDs: [0006](./0006-tool-registry.md), [0007](./0007-foundry-as-source-of-truth.md), [0022](./0022-dm-action-coverage-audit.md), [0032](./0032-autonomous-pre-game-setup-actions.md), [0033](./0033-live-state-perception-and-triggered-actions.md), [0041](./0041-first-party-foundry-addon.md)

## Approach

[TDD 0022](./0022-dm-action-coverage-audit.md) listed five in-play actions
Foundry can do and the third-party connector could not: combat tracker, GM
rolls, apply damage/heal, fog reveal, spawn token at coordinates. GM rolls
moved to [TDD 0041](./0041-first-party-foundry-addon.md) with table-text.
This TDD implements the other four on the first-party add-on.

These are `FoundryClient` methods. Tool-registry handlers (TDD 0006) call
them; the LLM never names Foundry APIs. dnd5e is the validated system
(ADR-0012): damage prefers `Actor#applyDamage` when present and falls back
to `system.attributes.hp.value` only when it is not.

Lighting, doors, and arbitrary active effects stay out.

## Components & interfaces

Additive on `FoundryClient` (TDD 0007 / 0041):

```ts
manageCombat(args: {
  action: "start" | "end" | "add" | "roll-initiative" | "next-turn" | "previous-turn";
  combatantIds?: ReadonlyArray<string>; // token or actor ids; required for add
}): Promise<{
  combatId: string | null;
  round: number;
  turn: number;
  currentCombatantId: string | null;
}>;

applyDamage(args: {
  actorId: string;
  amount: number; // negative heals
}): Promise<{ hp: number; tempHp?: number }>;

manageFog(args: {
  action: "reveal-scene" | "reset";
  sceneId?: string; // default: active scene
}): Promise<{ sceneId: string }>;

createToken(args: {
  actorId?: string;
  compendiumRef?: string; // "pack.entry" when the actor is not in the world yet
  sceneId?: string;       // default: active scene
  x: number;
  y: number;
  hidden?: boolean;
}): Promise<{ tokenId: string; actorId: string }>;
```

`MockFoundryClient` implements all four so orchestrator tests do not need a
live world.

### Add-on dispatch (extends TDD 0041 `main.mjs`)

| `method` | Foundry call |
| --- | --- |
| `manageCombat` / `start` | `Combat.create` + `combat.startCombat` on the active scene's tokens if none specified |
| `manageCombat` / `end` | `combat.endCombat` |
| `manageCombat` / `add` | `combat.createEmbeddedDocuments("Combatant", …)` |
| `manageCombat` / `roll-initiative` | `combat.rollInitiative(ids \| "all")` |
| `manageCombat` / `next-turn` / `previous-turn` | `combat.nextTurn` / `combat.previousTurn` |
| `applyDamage` | `actor.applyDamage(amount)` if function; else `actor.update` on `system.attributes.hp.value` (floor 0) |
| `manageFog` / `reveal-scene` | reset fog exploration for all users on that scene (core fog, not Simple Fog) |
| `manageFog` / `reset` | `scene.resetFog` |
| `createToken` | if `compendiumRef`, import actor first; `scene.createEmbeddedDocuments("Token", [{ actorId, x, y, hidden }])` |

A missing combat on `end` / `next-turn` returns `{ combatId: null, round: 0, turn: 0, currentCombatantId: null }`
and `ok: true` (idempotent), not an error. `add` without `combatantIds` is
`ok: false, error.code = "bad-args"`. `createToken` without `actorId` or
`compendiumRef` is `bad-args`. `applyDamage` on an unknown actor is
`not-found`.

Tool handlers (registered at session start once `client.system` is known):

- `apply_damage` / `heal` → `applyDamage` (heal sends a negative amount)
- `start_combat` / `end_combat` / `next_turn` → `manageCombat`
- `spawn_token` → `createToken`
- `reveal_fog` / `reset_fog` → `manageFog`

Exact tool Zod schemas live in `plugins/vtt-foundry` and register through
TDD 0006's registry. They do not land in core.

## Data & state

No new Skeinkeeper tables. Combat, HP, fog, and tokens stay in Foundry
(ADR-0018). The client returns the post-write snapshot the prompt needs
(current combatant, remaining HP, new token id).

## Sequencing / implementation plan

1. Extend `FoundryClient` + `MockFoundryClient` with the four methods.
2. Route the four methods in `FoundryGateway` / `ModuleFoundryClient`.
3. Implement dispatch in `modules/skeinkeeper/scripts/main.mjs`.
4. Register dnd5e tool wrappers in `plugins/vtt-foundry` at session start.
5. Unit tests: fake-socket for client mapping; mock actor/combat for handler errors.

## Failure modes & edge cases

**Real risks**

- `applyDamage` on a dying PC must go through `Actor#applyDamage` on dnd5e
  so death saves fire. The generic HP fallback is only for systems without
  that method.
- `createToken` from compendium can fail if the pack is not loaded. Return
  `error.code = "not-found"` with the pack id; intake (TDD 0031) already
  treats missing content as a critical gap.
- Fog API names differ between v13 and v14. Shim next to TDD 0041's chat
  style shim; one fixture per major.
- Starting combat twice. Second `start` returns the existing combat
  (idempotent), does not create a second encounter.

**Overblown risks**

- "Need a generic actor.update for every system." HP is the session-blocking
  write; other sheet fields stay on `applyActorUpdate` (TDD 0041).
- "Need Simple Fog." PRD targets core Foundry fog.

**Unspoken risks**

- Token coordinates are in scene pixels, not grid squares. The tool
  description must say pixels so the model does not pass grid indexes.
  `createToken` rejects non-finite `x`/`y`.

## Verification plan

Observable surface: Foundry combat tracker, actor HP, fog, scene tokens,
and `FoundryClient` return values.

| Observation point | PASS |
| --- | --- |
| `manageCombat({ action:"start" })` on a scene with tokens | tracker is active; `currentCombatantId` is a token/actor id |
| `manageCombat({ action:"next-turn" })` | `turn` or `currentCombatantId` changes |
| `manageCombat({ action:"end" })` twice | both succeed; second returns `combatId: null` |
| `applyDamage({ actorId, amount: 7 })` on a dnd5e actor at 12 HP | sheet HP is 5; return `{ hp: 5 }` |
| `applyDamage({ actorId, amount: -4 })` | HP increases by 4, capped at max |
| `applyDamage` on unknown id | `ok: false`, `error.code = "not-found"` |
| `manageFog({ action:"reveal-scene" })` | player fog on that scene is cleared |
| `createToken({ actorId, x: 400, y: 300 })` | a token for that actor exists at (400, 300) |
| `createToken({ x: 1, y: 1 })` (no actor) | `error.code = "bad-args"` |

## Evaluation rubric

| Criterion | High-quality | Acceptable | Failing |
| --- | --- | --- | --- |
| Requirement traceability | Every in-scope FR/NFR maps to a named interface, type, or step | One mapping is slightly coarse but still findable | An in-scope FR has no row, or the row is "handled in code" |
| Interface concreteness | Method names, args, return types, and error cases are specified | Types are named; one edge payload is implied | "the module talks to Skeinkeeper" with no message or method shape |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason | No new dep, and the section says why | New dep with empty or "none considered" analysis |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named | Observable but one scenario is console-only | Non-actionable plan (no surface, no observation point) |
| Scope-bound adherence | Touched files ≤8, body ≤500, per-file estimates present | One justified exception marker | Silent over-bound or missing Touched files / Expected diff |
| Naming consistency | FoundryClient methods, gateway messages, and add-on id match across 0041, 0042, and revised drafts | One leftover "bridge" in a revised draft, clearly historical | 0041 and 0034 disagree on a method or event name |

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
| --- | --- | --- |
| 4.2 combat tracker | start/end, add, initiative, turn advance | `manageCombat` |
| 4.2 apply damage / heal | HP changes on the actor sheet | `applyDamage` |
| 4.2 fog of war | reveal / reset on a scene | `manageFog` |
| 4.2 token spawn | place an actor at coordinates | `createToken` |
| 4.3 action capabilities | tools mutate only via typed calls | TDD 0006 wrappers around these methods |
| 4.8 triggered actions | hidden token place + reveal | `createToken({ hidden:true })` + existing `applyActorUpdate` |

## Dependencies considered

None. This TDD uses the gateway and add-on from TDD 0041 and Foundry's own
API. No new library.

Rejected alternative: keep waiting for a third-party connector to grow these
methods — withdrawn by ADR-0029.

## PRD conflicts surfaced (and resolution)

PRD §4.2 still lists lighting in the functional surface. This TDD does not
implement lighting or doors (YAGNI; not session-blocking per TDD 0022).
**Resolution:** lighting/doors are out of 0042 and not a v0.5 ship gate;
a later TDD may add them. Combat, damage, fog, and token spawn are the
session-blocking writes.

## Decisions to promote (ADR candidates)

None. ADR-0029 already covers first-party Foundry support.

## Telemetry implications

None. Tool-call telemetry already fires from TDD 0006 (tool name, success,
latency bucket; no args).

## Privacy implications

None. No new PII. Actor ids and HP are Foundry mechanical state (ADR-0018).

## Eval implications

None for the happy path. One eval fixture later may assert the AI calls
`apply_damage` rather than narrating HP; that is behavior-spec work, not
this TDD.

## Touched files

- `orchestrator/src/foundry/client.ts` — add the four methods
- `orchestrator/src/foundry/mock.ts` — mock implementations
- `plugins/vtt-foundry/src/foundry_gateway.ts` — route the four methods
- `plugins/vtt-foundry/src/module_foundry_client.ts` — client wrappers
- `plugins/vtt-foundry/src/module_foundry_client.test.ts` — fake-socket tests
- `modules/skeinkeeper/scripts/main.mjs` — Foundry API dispatch
- `plugins/vtt-foundry/src/tools.ts` — dnd5e tool wrappers registered at session start
- `plugins/vtt-foundry/src/tools.test.ts` — wrapper unit tests

## Expected diff size

- `orchestrator/src/foundry/client.ts` — 50 lines
- `orchestrator/src/foundry/mock.ts` — 80 lines
- `plugins/vtt-foundry/src/foundry_gateway.ts` — 40 lines
- `plugins/vtt-foundry/src/module_foundry_client.ts` — 90 lines
- `plugins/vtt-foundry/src/module_foundry_client.test.ts` — 160 lines (×1.6 test pad)
- `modules/skeinkeeper/scripts/main.mjs` — 180 lines
- `plugins/vtt-foundry/src/tools.ts` — 140 lines
- `plugins/vtt-foundry/src/tools.test.ts` — 130 lines (×1.6 test pad)

Total expected diff: 870 lines across 8 files.
