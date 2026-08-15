# TDD 0037: MCP Bridge Dependencies — Surface-Model v0.5 Critical Batch

Status: superseded by [0041](./0041-first-party-foundry-addon.md)
PRD refs: 4.2, 5.5, 8 (v0.5 roadmap)
PRD-rev: 59a0fda
ADR constraints: 0011, 0017, 0018, 0023, 0025
Supersedes: [TDD 0027](./0027-mcp-bridge-gap-reaudit-upstream-proposal.md)
Author: maintainers
Date: 2026-05-26
Related TDDs: [0014 (McpFoundryClient)](./0014-mcp-foundry-client.md), [0022 (DM-action coverage audit)](./0022-dm-action-coverage-audit.md), [0034 (surface routing & I/O abstraction)](./0034-surface-routing-and-io-abstraction.md), [0035 (side-channels via Foundry whisper)](./0035-side-channels-via-foundry-whisper.md), [0036 (onboarding + Foundry-user pre-flight)](./0036-onboarding-and-foundry-user-preflight.md), [0038 (per-audience erasure cascade)](./0038-per-audience-erasure-cascade-to-foundry.md)

## Carries forward / supersedes (read first)

This TDD supersedes [TDD 0027](./0027-mcp-bridge-gap-reaudit-upstream-proposal.md) because the PRD revision named in `PRD-rev` makes the bridge surface load-bearing in ways 0027 didn't contemplate. The append-only discipline (TDD 0027 was `implemented`) requires a new document; this is it.

**Carried forward from TDD 0027 unchanged:**

- The five 0022-vintage gaps (combat tracker, GM/secret/blind roll, apply damage / set HP / heal, fog-of-war, spawn token at coordinates) — all still missing on the current `adambdooley/foundry-vtt-mcp` bridge surface.
- The "per-player content reveal" requirement introduced by TDD 0026 / TDD 0035.
- The recommendation to stay on `adambdooley` as the recommended bridge (no superseding [ADR-0011](../adr/0011-prefer-oss-foundry-mcp-bridges.md)).
- The fork-as-Plan-B clause from ADR-0011 (`github.com/skeinkeeper/foundry-mcp-bridge`).

**New in this TDD:**

- **Five v0.5-blocking bridge capabilities** that the PRD's new Surface model (§4) makes load-bearing — and the explicit decision (taken in this design pass) to **block v0.5 ship on these landing**.
- A re-prioritized, single-source-of-truth proposal that fuses 0022's surface-coverage list with the new surface-model batch, ordered by what blocks v0.5 vs. what blocks general v0.5+ DM coverage.
- A named **upstream-vs-fork timeline** with checkpoints and a fork-trigger criterion, since the v0.5-blocking semantics shorten the patience window the fork-as-Plan-B clause assumed.
- Alternative analysis (own-Foundry-module path) considered and declined this pass, recorded so the option remains visible if upstream stalls.

## Approach

The PRD revision relocates every player- and operator-facing text path from Discord onto Foundry chat (§4 Surface model). The bridge today exposes ~44 tools — none of them lets Skeinkeeper post a chat message with audience targeting, none lets it observe Foundry chat events, none lets it server-side-roll dice with a roll mode, none lets it filter-delete chat messages, and none lets it enumerate Foundry users. **The surface-model TDDs (0034 / 0035 / 0036 / 0038 / 0040) are non-functional without these.** The PRD §4.2 "Critical bridge dependencies (v0.5)" subsection names four of the five; the fifth (`list-users`) is added here as a consequence of the defense-in-depth pre-flight choice in TDD 0036.

The design decision taken this pass: **v0.5 ships only after all five capabilities are available on the bridge** — whether by upstream merge, by Skeinkeeper-maintained fork, or by some combination. The alternative ("ship v0.5 with Discord text fallback / operator-console-only operator controls until upstream lands") was considered and rejected because it would require designing, implementing, and testing a temporary architecture that the surface model is explicitly abandoning; the throwaway cost exceeds the bridge-fork cost.

This is a real consequence: Skeinkeeper's v0.5 schedule is now dependent on a bridge maintainer's decisions (or, failing that, on the maintenance burden of a Skeinkeeper-owned fork). The fork-as-Plan-B clause in ADR-0011 was previously framed as a contingency; under this TDD's surface-model batch it is materially likely. §"Upstream-vs-fork timeline" below names the checkpoint that triggers the fork.

### The bridge capabilities, in two priority bands

**Band A: v0.5-blocking (the new surface-model batch).** These five capabilities are load-bearing for the PRD §4 Surface model. Skeinkeeper cannot ship v0.5 without them.

1. **`post-chat-message`** with audience targeting.
   - **Args:** `{ content: string, mode: "public" | "gm" | "whisper", whisperTo?: ReadonlyArray<FoundryUserId>, speaker?: { actor?: ActorId, alias?: string } }`.
   - **Foundry surface:** `ChatMessage.create({ content, whisper, type })` with `CONST.CHAT_MESSAGE_TYPES.WHISPER` / `OOC` / etc.
   - **Used by:** `FoundryPublicChatSurface`, `FoundryWhisperSurface`, `FoundryGmChatSurface` (TDD 0034 §6). Without it, no AI text output reaches Foundry — the entire table-text surface collapses.

2. **Server-side `roll-dice` with roll modes.**
   - **Args:** `{ formula: string, mode?: "public" | "gm" | "blind" | "whisperTo", whisperTo?: ReadonlyArray<FoundryUserId>, flavor?: string }`. Returns `{ total, formula, breakdown }` and posts the roll result to chat with the requested mode.
   - **Foundry surface:** `new Roll(formula).toMessage({ rollMode: CONST.DICE_ROLL_MODES.GMROLL | BLINDROLL | PUBLICROLL | PRIVATEROLL, whisper })`.
   - **Used by:** AI/GM rolls landing in Foundry chat with audience semantics (PRD §4.2); private-action secret rolls in TDD 0035 §5 (the "not leak into Foundry's shared chat log before it lands" guarantee). Without it, AI-side rolls stay in Skeinkeeper's local roller and don't land in Foundry chat — breaking auditability and the table-text consolidation.

3. **`delete-chat-messages` filtered.**
   - **Args:** `{ scope: "by-author" | "by-recipient" | "by-time-range", authorFoundryUserId?: FoundryUserId, recipientFoundryUserId?: FoundryUserId, since?: ISO8601, until?: ISO8601 }`. Returns count deleted.
   - **Foundry surface:** query `game.messages.contents`, filter by `author` / `whisper` / `timestamp`, call `ChatMessage.deleteDocuments(ids)`.
   - **Used by:** TDD 0038's per-player erasure cascade to Foundry whisper history (PRD §5.5 "Per-player erasure deletes both the Skeinkeeper-side dialogue store _and_ the corresponding Foundry whisper history"). Without it, the per-audience erasure guarantee under [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md) is _operational_ (operator manually deletes via Foundry GM UI), not _architectural_. Under the partial-success failure-mode policy chosen this pass (TDD 0038), the cascade gap is _named_ in the deletion report rather than silently dropped — but the cap remains v0.5-blocking because the deletion report's non-zero exit on operator-managed remainder is itself a UX surface.

4. **`chat-command` listener / chat-event subscription.**
   - **Args:** `subscribeChatEvents(handler: (event: { foundryUserId, text, isWhisper, recipients?, timestamp }) => void) → Unsubscribe`. Delivers ALL Foundry public-chat + whisper events to Skeinkeeper (not only `/`-prefixed messages); Skeinkeeper's bridge driver distinguishes operator commands from player text input by prefix match.
   - **Foundry surface:** `Hooks.on('createChatMessage', (message) => { ...forward over MCP/WebSocket... })`.
   - **Used by:** `FoundryPublicChatSurface` inbound (player text input → orchestrator), `FoundryWhisperSurface` inbound (player side-channel utterances), `FoundryChatCommandSurface` inbound (operator commands) — all in TDD 0034. Without it, **no operator-command input surface exists** (TDD 0040 cannot ship its second surface) and **no player text input surface exists** (PRD §4.1's relocation of text input from Discord to Foundry doesn't function). Two whole TDDs in this set are non-functional without this cap.

5. **`list-users`** returning `{ id: FoundryUserId, name: string, role: "GAMEMASTER" | "ASSISTANT" | "TRUSTED" | "PLAYER", isActive: boolean, ownedActorIds: ReadonlyArray<ActorId> }`.
   - **Args:** none.
   - **Foundry surface:** `game.users.contents.map(u => ({ id: u.id, name: u.name, role: u.role, isActive: u.active, ownedActorIds: <derived from actor ownership> }))`.
   - **Used by:** TDD 0036's 3-way identity mapping (Discord ID ↔ Foundry user ↔ character actor) and the defense-in-depth pre-flight check (Start + voice-join). Without authoritative enumeration, pre-flight degrades to the brittle indirect path documented in TDD 0032 (deriving the user set from `get-world-info` + per-actor `list-actor-ownership`); per the design-pass decision to make pre-flight authoritative, that's not acceptable for v0.5.

**Band B: surface-coverage carried forward from TDD 0027 + 0022.** Closes the in-play DM-action coverage gap that PRD §4.2 requires. NOT v0.5-blocking individually (TDD 0014's option-(a) graceful-degradation path applies); each lands when upstream accepts or when a fork-batch ships these alongside Band A.

6. **Combat tracker tools** — `start-combat`, `end-combat`, `add-to-combat`, `roll-initiative`, `next-turn` / `previous-turn` (carried from TDD 0027 §"Consolidated upstream proposal" item 1).
7. **Apply damage / healing / set HP** — `apply-damage { actorOrToken, amount }` with system-aware routing (dnd5e `Actor#applyDamage` fallback to `actor.update`) (carried from TDD 0027 item 3).
8. **Per-player content reveal** — `show-to-players { journalRef | journalPageRef | imageRef, playerUserIds }` (carried from TDD 0027 item 4 — originally added by TDD 0026 / TDD 0035).
9. **Fog-of-war control** — `reveal-fog` / `reset-fog` / reveal-area (carried from TDD 0027 item 5).
10. **Spawn token on scene** — `create-token { actorId | compendiumRef, x, y, hidden? }` (carried from TDD 0027 item 6).

**Lower priority (mention, don't block; carried from TDD 0027):** arbitrary active effects/buffs, door/wall/secret-passage state, ambient lighting / time-of-day. Plus a small **`list-items` / `search-items` over world-level items** (added by TDD 0032's open question §"PRD conflicts surfaced #2").

### Upstream-vs-fork timeline

The fork-as-Plan-B clause in ADR-0011 doesn't say _when_ to invoke it. Under TDD 0027's framing (no v0.5-blocking deps), patience was open-ended — "wait for upstream, fork if maintainer goes inactive." Under THIS TDD's framing (five v0.5-blocking deps), the patience window has to be bounded by the v0.5 schedule. The bounded timeline:

- **Week 0 (this design pass):** open one consolidated upstream issue + PR series on `adambdooley/foundry-vtt-mcp` covering Band A (#1–#5). The PR series should be split per capability (one PR per cap, not one mega-PR) so the maintainer can merge incrementally.
- **Week 2 checkpoint:** if no maintainer engagement at all (no review comments, no labels, no triage), open a polite ping; clarify upstream willingness.
- **Week 4 checkpoint:** if the maintainer has signaled "I'll get to it but not soon" OR "I'm not going to take this," fork. Branch `skeinkeeper-fork` from upstream; cherry-pick Band A PRs onto the fork; publish under `github.com/skeinkeeper/foundry-mcp-bridge` with a clear "fork of `adambdooley/foundry-vtt-mcp`, maintained for Skeinkeeper" preamble in the README; pin Skeinkeeper's bridge dep to the fork.
- **Week 4 checkpoint, alternative outcome:** if the maintainer has merged ≥3 of 5 caps and committed to the remaining two, keep on upstream + continue PRs.
- **Ongoing post-fork:** track upstream and forward-merge non-conflicting changes into the fork; offer the Band A capabilities back to upstream as PRs in case the maintainer's posture changes. Skeinkeeper bridges back to upstream when (and if) the maintainer absorbs the work.

The **fork trigger** is intentionally early — week 4 not week 12 — because Skeinkeeper's v0.5 ship is on the line. ADR-0011's clause was correct that the bridge codebase is small and the fork cost is bounded; this TDD operationalizes that with a concrete trigger.

### Alternative analysis — Skeinkeeper Foundry module (considered and declined this pass)

Before authoring this batch, the design pass considered whether the right answer is to abandon the MCP-bridge architecture entirely and ship a **Skeinkeeper-owned Foundry module** instead — one .js bundle Foundry loads, with direct access to `game.users`, `game.messages`, `ChatMessage.create`, `Roll`, `Hooks.on('createChatMessage')`, etc. All five Band A capabilities become one-liners against Foundry's native JS API; no upstream PR series, no fork to maintain, no MCP-server intermediate process for the operator to install.

The trade-offs (recorded so the option remains visible):

| Dimension                                                | MCP bridge (this TDD's path)                                                                                                                                    | Skeinkeeper Foundry module (alternative)                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Code we maintain                                         | Skeinkeeper's `McpFoundryClient` adapter (TDD 0014); the Band A PR series (upstream OR a fork)                                                                  | A Skeinkeeper Foundry module (~25–30 commands focused on Skeinkeeper's actual surface)          |
| Code we don't control                                    | The bridge MCP server + the bridge's Foundry-side module (whether upstream or our own fork)                                                                     | None — Foundry itself, but no intermediate                                                      |
| Operator install steps                                   | Foundry module (bridge's) + bridge MCP server (Node) + Skeinkeeper                                                                                              | Foundry module (ours) + Skeinkeeper                                                             |
| Foundry-native UX (chat buttons, dialogs, hotbar macros) | Hard to deliver — bridge would need a generic interactive-prompt cap that doesn't exist                                                                         | Trivial — direct Foundry UI API access                                                          |
| The five Band A caps                                     | Upstream-or-fork (weeks of work + bridge-maintainer dependency)                                                                                                 | One-liners against Foundry's JS API; no negotiation                                             |
| Foundry version compat (v11→v14)                         | Borne by the bridge maintainer (today) OR by us if forked                                                                                                       | Borne by us; one version axis instead of two                                                    |
| MCP-as-protocol homogeneity                              | LLM-callable tools are already wrapped through Skeinkeeper's tool dispatcher (TDD 0006); the LLM never sees MCP directly, so the "homogeneity" benefit is small | Same — LLM still sees Skeinkeeper's typed tool registry, not the underlying transport           |
| Multi-VTT abstraction value                              | `FoundryClient` abstracts; could swap to non-MCP later                                                                                                          | Same `FoundryClient` interface; implementation swaps `McpFoundryClient` → `FoundryModuleClient` |
| Time cost to v0.5                                        | Bounded by Band A upstream/fork timeline (~weeks)                                                                                                               | Bounded by module implementation (~1–2 weeks for the focused surface)                           |

**Decision (this design pass):** stay on the MCP bridge path. The decision was made with awareness of the trade-off above; the maintainer overhead of an MCP-bridge fork is judged acceptable, the MCP-protocol pattern is preserved, and the Plan-B trigger above provides a clear exit if upstream stalls. Recorded here so a future designer (or this designer at a future date) can re-evaluate cheaply: if the Band A workstream stalls during Phase 3-live + integration, the Foundry-module path is the next supersession to consider.

## Components & interfaces

### Bridge-side surface contract (the upstream PR series shape)

Each Band A capability is one bridge tool (or one new pair). The MCP tool signatures are intentionally close to Foundry's native API so the bridge's Foundry-side module is a thin pass-through. The Skeinkeeper-side counterpart is one new `FoundryClient` method per cap; `McpFoundryClient` (TDD 0014) is extended with the corresponding `McpToolCaller.callTool` invocations.

Method additions on `FoundryClient` (interface owned by TDD 0007; extension this TDD):

```ts
// orchestrator/interfaces/foundry-client.ts (additive)
export interface FoundryClient {
  // ... existing methods (TDD 0007 / 0014) ...

  // Band A — new in this TDD; non-functional until the bridge cap lands
  postChatMessage(args: {
    content: string;
    mode: "public" | "gm" | "whisper";
    whisperTo?: ReadonlyArray<FoundryUserId>;
    speaker?: { actor?: ActorId; alias?: string };
  }): Promise<{ messageId: string }>;

  rollDice(args: {
    formula: string;
    mode?: "public" | "gm" | "blind" | "whisperTo";
    whisperTo?: ReadonlyArray<FoundryUserId>;
    flavor?: string;
  }): Promise<{ total: number; formula: string; breakdown: string; messageId: string }>;

  deleteChatMessages(args: {
    scope: "by-author" | "by-recipient" | "by-time-range";
    authorFoundryUserId?: FoundryUserId;
    recipientFoundryUserId?: FoundryUserId;
    since?: string; // ISO8601
    until?: string;
  }): Promise<{ deletedCount: number }>;

  subscribeChatEvents(
    handler: (event: {
      foundryUserId: FoundryUserId;
      text: string;
      isWhisper: boolean;
      recipients?: ReadonlyArray<FoundryUserId>;
      timestamp: string; // ISO8601
    }) => void,
  ): Unsubscribe;

  listUsers(): Promise<
    ReadonlyArray<{
      id: FoundryUserId;
      name: string;
      role: "GAMEMASTER" | "ASSISTANT" | "TRUSTED" | "PLAYER";
      isActive: boolean;
      ownedActorIds: ReadonlyArray<ActorId>;
    }>
  >;
}
```

### Capabilities probe (carried forward from TDD 0022 / 0027 open question)

Skeinkeeper does a one-time `list-tools` probe on bridge connect (already a Phase-3-live step in TDD 0014) and matches the returned tool names against the Band A + Band B sets. Result feeds into:

- Operator app: an explicit "Bridge capability check" pane that lists which v0.5-blocking caps are present and which are missing, with a one-line "build status: ready / blocked / partial" verdict.
- Session start: refuses to start a v0.5 session when any Band A cap is missing, with an actionable error pointing the operator at the capability-check pane and at the upstream/fork pinning instructions.

The probe is unit-testable (mock `list-tools` returns various capability subsets) and operator-validated against a real Foundry + bridge.

### The bridge driver's chat-event consumer

`McpFoundryClient.subscribeChatEvents` wires the bridge's `chat-command` listener through MCP's notification surface (or, if the bridge implements it as a long-poll, through that). Skeinkeeper's three Foundry-chat inbound surface adapters (TDD 0034 §5–§6) consume the same subscription via a fan-out helper:

```ts
// plugins/vtt-foundry/chat-event-fanout.ts
export function fanoutChatEvents(
  client: FoundryClient,
  ctx: {
    dmFoundryUserId: FoundryUserId; // the DM's Foundry user (the bot identity in Foundry)
    operatorFoundryUserId?: FoundryUserId; // the operator's Foundry user (TDD 0024 designation;
    //   absent only during the brief pre-designation window)
  },
  onPublic: (e) => void,
  onWhisperToDm: (e) => void, // whisper whose `recipients` includes `ctx.dmFoundryUserId`
  //   AND does NOT include `ctx.operatorFoundryUserId`
  //   (whispers to the operator are not consumed here —
  //    they're operator-facing chat, not player→DM
  //    side-channel input)
  onCommand: (e) => void, // chat message whose body starts with `/skeinkeeper `
  //   AND whose `senderFoundryUserId === ctx.operatorFoundryUserId`
  //   (commands authored by a non-operator are dropped
  //    silently; the GM-role authorization in TDD 0040
  //    is the second check)
): Unsubscribe;
```

The fan-out is the bridge driver's responsibility (per the design-pass decision "chat-command parser lives in the bridge driver"); the orchestrator-side surfaces receive already-classified events. The classification rules above are deterministic functions of `ChatEvent` + the `ctx` IDs; they are unit-testable against the `FakeFoundryClient` chat-event stream without live MCP traffic.

**Why `dmFoundryUserId` is on `ctx`, not derived per event.** The DM identity is constant for the session's duration (set at session start from operator config); putting it on `ctx` avoids per-event lookups against `FoundryClient.listUsers()` and ensures the classification rule is pure. The operator Foundry user ID is also constant once the operator has self-designated (TDD 0024) and is left optional only to handle the pre-designation window — chat events that arrive before designation cannot be classified as commands (the `onCommand` branch is suppressed), which matches the existing TDD 0024 contract.

## Data & state

No new persistent state in Skeinkeeper for this TDD. The bridge capability probe result is held on a per-session `BridgeCapabilities` object in `SessionRunState` (introduced by TDD 0032); the capability check + the refuse-to-start gate read from it.

Foundry-side state (chat messages, rolls, etc.) lives in Foundry per [ADR-0018](../adr/0018-foundry-source-of-truth.md). The bridge does not introduce Skeinkeeper-side mirrors of Foundry state.

## Sequencing / implementation plan

This is a TDD about an upstream proposal + a fork-trigger plan + the Skeinkeeper-side wiring once the caps exist. The build sequence:

1. **Open the upstream PR series** (5 PRs, one per Band A cap) on `adambdooley/foundry-vtt-mcp`. PR descriptions reference Skeinkeeper's PRD §4.2 / TDD 0034 as motivation; offer to iterate on review feedback. (Week 0.)
2. **Add the capability-probe pane** to the operator app (TDD 0020 surface). Renders the live `list-tools` diff against Band A + Band B. Skeinkeeper-side only; no bridge dep. (Parallel to PRs.)
3. **Wire `McpFoundryClient` to each Band A cap, behind a feature flag, as the cap lands.** The Skeinkeeper-side adapter for each cap is independent; we wire each as it becomes available (whether upstream merges or the fork lands them). Mocked unit tests cover the adapter logic without requiring the bridge cap to be live.
4. **Week 4 checkpoint per §Upstream-vs-fork timeline.** Either continue on upstream OR cut the `skeinkeeper-fork` branch + retarget the PRs onto the fork + ship the bridge tags.
5. **Phase 3-live integration:** validate the full chain (Skeinkeeper → MCP → bridge → Foundry) against a real Foundry world. Each Band A cap gets a live integration test (operator-validated, gated like TDD 0014 / TDD 0021's existing live tests).
6. **Refuse-to-start gate flipped on** once all five Band A caps are validated. Until then, `pnpm dev` against a bridge missing any Band A cap fails at session-start with the actionable error.
7. **Re-prioritize Band B upstream PRs** post-v0.5 ship. Band B is not v0.5-blocking; PRs roll out over v0.5+.

## Failure modes & edge cases

- **Upstream maintainer review is positive but slow.** Acceptable — track per-PR ETA against the week-4 trigger; if any cap hasn't merged by week 4, evaluate the fork (the trigger is whether v0.5 is realistically reachable on upstream, not whether some PRs merged).
- **Upstream maintainer requests substantive design changes** (e.g., different tool name shape, different argument semantics). Accommodate within reason — the maintainer owns their bridge's shape; Skeinkeeper's `McpFoundryClient` mapping is cheap to adjust. Only if the requested change would degrade Skeinkeeper's correctness (e.g., dropping `whisperTo` from `post-chat-message`) is fork preferable.
- **Upstream maintainer refuses a cap on principle** (e.g., "I don't want a generic chat-event subscription in the bridge — it's a footgun for poorly-isolated operator instances"). Fork. The cap is load-bearing for Skeinkeeper's PRD scope; refusal is the fork trigger.
- **A bridge cap is shipped but the live behavior differs from the proposed contract** (e.g., `roll-dice` returns total but doesn't actually post a chat message in `gm` mode). Phase 3-live integration testing catches this; Skeinkeeper either files a bug against the cap (if upstream) or fixes in-fork. Refuse-to-start gate doesn't flip on until the live behavior matches.
- **Foundry-version regression on the bridge** (a Foundry minor release breaks one or more caps). Pin the bridge dep to a known-good Foundry version range; operator-visible warning when the operator's Foundry version is outside the range; bridge dep bump tracked.
- **Forked bridge drifts from upstream and upstream evolves.** Quarterly forward-merge cadence on the fork; track upstream commits; merge non-conflicting changes. The fork README's "what we maintain over upstream" diff stays current.
- **Operator running on a `laurigates/foundryvtt-mcp` install** (the secondary OSS bridge from ADR-0011). The Band A workstream is targeted at `adambdooley`; `laurigates` users see the refuse-to-start gate fail until either (a) the same caps are added to `laurigates` upstream or (b) `laurigates` is dropped as a supported configuration in a future ADR. v0.5 ships only against the bridge that has Band A; ADR-0011's "supported alternative" status of `laurigates` becomes "supported for v0.4 and earlier; not v0.5+ until cap-parity exists." Capture this in the v0.5 INSTALL.md as a known limitation.

## Verification plan

The capabilities probe + the refuse-to-start gate + the per-cap Skeinkeeper-side mapping:

- **Capability probe reads bridge tool names correctly.** _Observable surface:_ the `BridgeCapabilities` object on `SessionRunState` after `client.connect()`. _Observation point:_ unit test — feed `FakeMcpToolCaller` a `list-tools` response with a known tool name list; verify the probe classifies each tool into Band A / Band B / unknown buckets. _Expected:_ exact bucket assignment per the tool-name table; a tool not in either band classifies as unknown.
- **Refuse-to-start gate fires when a Band A cap is missing.** _Observable surface:_ `SessionManager.start` rejected error + operator-app capability-check pane status. _Observation point:_ integration test — register a `FakeMcpToolCaller` whose probe response omits `post-chat-message`; call `SessionManager.start`. _Expected:_ start rejects with an error naming the missing cap; pane status is "blocked"; no Coordinator is constructed.
- **Refuse-to-start gate passes when all Band A caps are present.** _Observation point:_ integration test — probe response includes all five Band A names; start succeeds; pane status is "ready". _Expected:_ start returns normally; Coordinator + surface router constructed.
- **Each Band A cap's `FoundryClient` method maps correctly.** _Observable surface:_ the `McpToolCaller` recorded calls. _Observation point:_ per-cap unit tests — call `client.postChatMessage({ content: "x", mode: "whisper", whisperTo: ["u1"] })`; verify `FakeMcpToolCaller` recorded `{ tool: "post-chat-message", args: { content: "x", mode: "whisper", whisperTo: ["u1"] } }`. Similar for each of the other four caps. _Expected:_ argument shape matches the upstream PR's contract exactly; Skeinkeeper-side does not silently transform args.
- **`chat-command` listener delivers events.** _Observable surface:_ events received by the registered handler. _Observation point:_ unit test — register a handler via `client.subscribeChatEvents(h)`; have the fake transport emit two notifications (one public message, one whisper); assert handler received both with correct fields. _Expected:_ handler called twice with the exact field shapes.
- **`list-users` returns the documented shape.** _Observable surface:_ method return value. _Observation point:_ unit test — fake returns a known user list; assert mapped shape matches `{ id, name, role, isActive, ownedActorIds }` and `role` enum values are preserved.
- **Live: capability probe against a real bridge with all Band A merged/forked-and-deployed** _Observable surface:_ the capability-check pane in the operator app reads "ready." _Observation point:_ start the bridge with the Band A merged-or-forked tag; connect Skeinkeeper. _Expected:_ pane shows all five caps green; refuse-to-start gate does not fire.
- **Live: each Band A cap end-to-end against a real Foundry** (one live integration test per cap). _Observation points + expected:_ `post-chat-message public` writes a public Foundry chat entry; `post-chat-message whisper` writes a whisper visible only to recipient; `post-chat-message gm` writes a GM-chat entry visible only to GM-role users; `roll-dice mode:gm` produces a result whose ChatMessage's `whisper` field includes only GM users; `delete-chat-messages by-recipient` removes the expected entries (and only those); `subscribeChatEvents` fires the handler when a Foundry user types in chat; `list-users` returns the world's actual user list including the operator's own GM user.

The capability probe + refuse-to-start logic is CI-testable. The end-to-end live tests are operator-validated against a real Foundry + bridge (same pattern as TDD 0014 / TDD 0021 today).

## Requirement traceability

| PRD ref                            | Requirement                                                                                                                                                                                                                                                    | Satisfied by                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.2 (Critical bridge dep #1)       | `post-chat-message` with audience targeting (`table` → public; `whisperTo: [userId]` → whisper; `gm` → GM-only)                                                                                                                                                | Band A cap #1; PR series item 1; `FoundryClient.postChatMessage` method addition                                                                                             |
| 4.2 (Critical bridge dep #2)       | Server-side `roll-dice` with roll modes (`public` / `gm` / `blind` / `whisperTo`)                                                                                                                                                                              | Band A cap #2; PR series item 2; `FoundryClient.rollDice` method addition                                                                                                    |
| 4.2 (Critical bridge dep #3)       | `delete-chat-messages` filtered by author / recipient / time-range                                                                                                                                                                                             | Band A cap #3; PR series item 3; `FoundryClient.deleteChatMessages` method addition; TDD 0038's cascade caller                                                               |
| 4.2 (Critical bridge dep #4)       | `chat-command` listener (a way to surface operator-typed Foundry chat commands to the bridge)                                                                                                                                                                  | Band A cap #4 — broadened to a general chat-event subscription delivering both `/`-prefixed and plain text events; PR series item 4; `FoundryClient.subscribeChatEvents`     |
| 4.2 (defense-in-depth pre-flight)  | The 3-way identity pre-flight in TDD 0036 (Start + voice-join) requires Foundry-user enumeration                                                                                                                                                               | Band A cap #5 (`list-users`); PR series item 5; `FoundryClient.listUsers` method addition. Promoted from open-question status to v0.5-blocking this pass per design decision |
| 4.2 (in-play DM action coverage)   | "AI performs every in-play DM table action; gaps are tracked and a closure plan exists" (carried from TDD 0027 / TDD 0022)                                                                                                                                     | Band B caps #6–#10 carry forward from TDD 0027's consolidated proposal unchanged; this TDD inherits 0027's traceability                                                      |
| 5.5 (per-audience erasure cascade) | "Per-player erasure deletes both the Skeinkeeper-side dialogue store _and_ the corresponding Foundry whisper history for that player"                                                                                                                          | Band A cap #3 enables the cascade; TDD 0038 implements the caller; the partial-success policy lives in TDD 0038                                                              |
| 8 (v0.5 roadmap)                   | "Foundry write integration (AI moves tokens, runs combat tracker, reveals fog, **posts to Foundry chat per the audience model, performs server-side rolls, and erases per-player whisper history on player-erasure** — see §4.2 Critical bridge dependencies)" | Band A is the v0.5 critical-path batch; refuse-to-start gate enforces "v0.5 ships only with Band A complete"                                                                 |

## Dependencies considered

The bridge itself (`adambdooley/foundry-vtt-mcp`) is a pre-existing dependency consumed via ADR-0011 / TDD 0014; this TDD does not _add_ a dependency, it _changes the scope_ of what we're asking from an existing one.

Alternative-bridge analysis: `laurigates/foundryvtt-mcp` (the secondary OSS bridge from ADR-0011) — same gap profile as `adambdooley` on Band A (the surface-model caps are novel to Skeinkeeper's PRD and not present on either bridge); selecting `laurigates` would just shift the upstream-or-fork target without reducing the work. `alexivenkov` ruled out by ADR-0011's Patreon-gating posture. Decision: stay on `adambdooley` as the recommended bridge; the same Band A PR series targets it; fork target is `github.com/skeinkeeper/foundry-mcp-bridge` (per ADR-0011) if upstream stalls.

Alternative-architecture analysis: Skeinkeeper Foundry module (own-module path) — fully tabled above in §"Alternative analysis." Recorded for revisit if Band A upstream stalls during build; not pursued this pass.

No new third-party Skeinkeeper-side dependencies. The PR series ships against `adambdooley`'s existing toolchain.

## PRD conflicts surfaced (and resolution)

1. **PRD §4.2's "Optional but desirable: interactive-prompt support (clickable buttons in chat messages)."** The PRD frames this as desirable, not load-bearing. Buttons would require an interactive-message capability on the bridge that doesn't exist and isn't in the Band A batch. **Resolution:** not included in Band A; tracked as a Band C+ aspiration (post-v0.5). Typed `/skeinkeeper <verb> <args>` commands cover the operator-resolution surface for v0.5; buttons would be a UX upgrade later. This is the trade-off the bridge architecture imposes that a Foundry-module path would have collapsed; recorded in §"Alternative analysis."

2. **The PRD's framing of `chat-command` listener narrowly** (operator-typed Foundry chat commands). The cap as proposed here delivers ALL chat events (public + whisper, prefixed or not), broader than the PRD's wording. **Resolution:** the broader scope is _required_ to also deliver player text input under PRD §4.1's relocation to Foundry chat; narrowing to `/`-prefixed messages would leave player text input unbuildable. Cap #4's scope is one capability serving two PRD requirements; the bridge driver fans out to the three inbound surface adapters in TDD 0034.

3. **The PRD's `list-users` cap is implicit, not stated.** PRD §4.8's "Discord-user → Foundry-user → actor ownership confirmation" requires enumeration; §5.5's two-layer anti-leak requires authoritative user identity. Neither §4.2's Critical bridge dependencies list nor anywhere else explicitly names `list-users`. **Resolution:** promote `list-users` to Band A (this TDD's contribution to the requirements list); update PRD §4.2's Critical bridge dependencies list in the next PRD revision to make this explicit. Tracked as a documentation follow-up; design is unblocked.

## Decisions to promote (ADR candidates)

The week-4 fork-trigger plan in §"Upstream-vs-fork timeline" is a durable, cross-cutting operationalization of ADR-0011's fork-as-Plan-B clause. Promotable to a refining or superseding ADR if the team wants the trigger criterion as a binding constraint rather than a TDD-local plan.

Recommendation: **defer promotion until the trigger fires or it's clear it won't.** ADR-0011's clause is already accepted; the timeline here is plan-level, not decision-level. If the fork lands, that supersession is the natural place to record the trigger as the precedent. If upstream merges Band A on schedule, the timeline is a one-shot artifact.

The own-Foundry-module alternative analysis (§"Alternative analysis") is recorded here for future reference and is _not_ a promotable decision — the decision this pass was to stay on the bridge; promoting it would require a superseding ADR to ADR-0011, which is out of scope for this design pass.

## Telemetry implications

| Event                       | Payload                                                                                  | Description                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `bridge.capability.probe`   | `{ bandAPresent: number, bandATotal: number, bandBPresent: number, bandBTotal: number }` | Capability probe result on session connect; counts only                                        |
| `bridge.capability.missing` | `{ band: "A" \| "B", capability }`                                                       | Per-missing-cap entry on session connect                                                       |
| `bridge.refused-start`      | `{ missingCount }`                                                                       | Refuse-to-start gate fired; v0.5 cannot begin                                                  |
| `bridge.tool.unsupported`   | `{ tool, reason }`                                                                       | A Band A or Band B tool was called on a bridge that doesn't expose it (defensive double-check) |

All PII-free per [ADR-0010](../adr/0010-privacy-as-architecture.md). Capability names are tool-name strings (`post-chat-message`, etc.) — not personal data.

## Privacy implications

No new personal-data processing. The bridge caps themselves operate on Foundry-side identifiers (`FoundryUserId`, `ActorId`) which are opaque to PII classification; nothing in this TDD persists user content beyond what the existing dialogue store + TDD 0038's cascade already cover.

Cap #3 (`delete-chat-messages`) is the privacy-positive cap — it _enables_ the per-audience erasure cascade under PRD §5.5 / ADR-0017 that this design pass needs. Without it, the cascade gap (Skeinkeeper erases its store; Foundry whisper history persists) is an operational privacy regression — surfaced honestly in TDD 0038's deletion-report rather than silently dropped, but a real gap. Cap #3's v0.5-blocking status is what closes it architecturally.

## Eval implications

No new behavior-spec fixtures from this TDD itself — it's mechanical infrastructure. The Band A caps' end-to-end live tests are operator-validated against a real Foundry + bridge (per §Verification plan). Cap #3's privacy semantics + cap #5's pre-flight semantics drive TDD 0038's and TDD 0036's `eval:live` fixtures respectively; this TDD just provides the transport.

## Open questions

- **Bridge maintainer's preferred upstream PR structure** — one mega-PR per band vs. five small PRs vs. an RFC issue first. The TDD recommends five small PRs (per cap) for incremental merge ability, but the maintainer's preference governs. Resolved on first contact with the maintainer (week 0 of §Upstream-vs-fork timeline).
- **Capability-probe granularity** — does the bridge expose tool _names_ via `list-tools` reliably, or do we need to call each tool with a known-no-op arg and check for "method not found" responses? Bridge-side detail; resolve at Phase 3-live.
- **`laurigates/foundryvtt-mcp` users on v0.5** — formal supported / not-supported posture. Recommend documenting the limitation in v0.5 INSTALL.md; if a `laurigates` user demand emerges, a future ADR can revisit (cap-parity-on-laurigates is its own workstream).
