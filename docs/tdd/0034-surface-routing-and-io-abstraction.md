# TDD 0034: Surface Routing & I/O Abstraction

Status: draft
PRD refs: 4 (Surface model preamble), 4.1, 4.2, 4.3, 4.7, 4.8, 5.8
PRD-rev: 59a0fda
ADR constraints: 0003, 0008, 0010, 0011, 0016, 0017, 0018, 0021, 0023, 0024, 0025, 0026, 0027
Author: maintainers
Date: 2026-05-26
Related TDDs: [0006 (tool registry)](./0006-tool-registry.md), [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0012 (voice IO)](./0012-voice-io.md), [0014 (McpFoundryClient)](./0014-mcp-foundry-client.md), [0015 (always-listening loop)](./0015-always-listening-voice-loop.md), [0020 (operator app)](./0020-operator-app.md), [0035 (side-channels via Foundry whisper)](./0035-side-channels-via-foundry-whisper.md), [0036 (onboarding + Foundry-user pre-flight)](./0036-onboarding-and-foundry-user-preflight.md), [0037 (bridge dependencies — surface-model critical batch)](./0037-bridge-dependencies-surface-model-critical-batch.md), [0040 (operator control parity — Foundry chat commands)](./0040-operator-control-parity-foundry-chat-commands.md)

## Approach

The PRD's new §4 _Surface model_ collapses what was previously a mixed Discord+Foundry+console surface set into a deliberate, non-overlapping split: **voice on Discord; one-time consent on Discord DM; everything else player- or operator-facing on Foundry; operator-only configuration on the localhost web console.** This is a cross-cutting routing decision that touches the side-channel design (TDD 0035), the onboarding/operator-escalation design (TDD 0036), the erasure adapter (TDD 0038), the operator-control surface (TDD 0040), and at least three v0.5-blocking bridge dependencies (TDD 0037).

Today the orchestrator's outbound paths are ad-hoc: `notify_operator` writes Discord DMs (TDD 0023); the `whisper` tool writes Discord DMs (TDD 0026); the always-listening loop's narration writes Discord voice + (historically) a Discord text channel mirror (TDD 0015). Each path embeds its surface choice in its caller. Under the new surface model, every audience-tagged output and every inbound event needs to route through one place that knows the new mapping, so the surface decisions live in one design instead of being smeared across the orchestrator, the side-channel module, the onboarding module, and the operator-channel module.

This TDD introduces a **`SurfaceRouter`** — the single orchestrator-side abstraction over the surfaces — plus the **`OutboundSurface` / `InboundSurface` adapter interfaces** that each concrete surface implements. Downstream TDDs (0035 / 0036 / 0038 / 0040) author against the router, not against the specific transports. The router is also where the audience model from PRD §4.7 / [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md) gets enforced on _delivery_ — the orchestrator emits an `Audience`-tagged output and the router picks the surfaces; nothing in the orchestrator names "Foundry whisper" or "Discord voice" directly.

This TDD is the spine; it deliberately does not redesign the things it routes between. The Coordinator concurrency model (TDD 0026 §3, carried forward by TDD 0035 §3) and the orchestrator turn loop (TDD 0011) keep their existing shapes; the router substitutes for the ad-hoc surface writes those modules previously made.

### 1. The surface set, by what each owns

The PRD's §4 Surface table is the contract; this TDD names the routing-layer counterparts:

| Surface (logical)             | Adapter (concrete)          | Owns (outbound)                                                                                  | Owns (inbound)                                                 |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Discord voice                 | `DiscordVoiceSurface`       | TTS narration to the voice channel; per-NPC voice profiles; presence-driven greetings on lulls   | Per-speaker STT utterances; voice-presence events              |
| Discord consent DM            | `DiscordConsentSurface`     | One-time consent prompt on first voice-join; nothing else                                        | Player consent response (accept / decline)                     |
| Foundry public chat           | `FoundryPublicChatSurface`  | Table-audience text mirror; IC/OOC convention markers; scene-change notifications; dice receipts | Player text input (IC and OOC); IC/OOC convention parsing      |
| Foundry whisper (per player)  | `FoundryWhisperSurface`     | `player:<id>`-audience text and per-player handout reveals                                       | Player-initiated side-channel utterances (text)                |
| Foundry GM chat               | `FoundryGmChatSurface`      | `gm`-audience content; operator escalations (`notify_operator`)                                  | (none — operator command input is `FoundryChatCommandSurface`) |
| Foundry chat-command listener | `FoundryChatCommandSurface` | (none — outputs reuse `FoundryGmChatSurface`)                                                    | Operator-typed `/skeinkeeper <verb> <args>` commands           |
| Operator web console          | `WebConsoleSurface`         | Operator-only state echo via SSE; live-session view                                              | Operator-only control invocations via the existing console API |

The web console remains outside the player-facing routing layer (its job is config + observability for one user, the operator) but is named here because it participates in the parity invariant — every operator-control inbound event arriving via `FoundryChatCommandSurface` MUST be reproducible via `WebConsoleSurface`, and vice versa (TDD 0040).

### 2. The audience → surface map

Every orchestrator output carries an explicit `Audience` from [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md). The router fans an output across the surfaces that own that audience, in parallel:

| Audience                       | Outbound surfaces fanned to                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ kind: "table" }`            | `DiscordVoiceSurface` (TTS audio) **and** `FoundryPublicChatSurface` (mirrored text transcript)                                                                                          |
| `{ kind: "player", playerId }` | `FoundryWhisperSurface` (whisper to that player's Foundry user); _additive future:_ async whispered audio attachment via `DiscordVoiceSurface` (out of v0.5, per TDD 0026 §8 → TDD 0035) |
| `{ kind: "gm" }`               | `FoundryGmChatSurface` (GM-only chat, visible to operator's Foundry user in their GM view)                                                                                               |

**Operator escalations** (`notify_operator`, intake findings, hard-gap warnings) are a special case of `gm`-audience content: they emit `{ kind: "gm" }` with a `meta.escalation: true` flag the router uses to also _whisper to the operator's Foundry user_ when one is known (TDD 0036's 3-way identity supplies it). If the operator's Foundry user is unknown, GM-chat broadcast is the fallback — every GM-role Foundry user sees it, which is operationally fine (a single-operator instance per the PRD).

**Hard rule (enforced in code).** The router rejects an output whose `audience.kind` is not handled by any registered outbound surface. There is no silent drop. A missing surface registration in development is a hard error at first emit, not a privacy regression on day forty.

### 3. The inbound model

Each `InboundSurface` exposes a typed event stream. The orchestrator's Coordinator (TDD 0026 §3 / TDD 0035 §3) subscribes to all registered inbound streams and dispatches:

```ts
export type SurfaceInputEvent =
  | {
      kind: "voice.utterance";
      surface: "discord-voice";
      speakerDiscordId: string;
      text: string;
      convention?: "ic" | "ooc";
    }
  | {
      kind: "voice.presence";
      surface: "discord-voice";
      members: ReadonlyArray<{ discordId: string; displayName?: string }>;
    }
  | {
      kind: "consent.response";
      surface: "discord-consent";
      discordId: string;
      decision: "accept" | "decline";
    }
  | {
      kind: "chat.public";
      surface: "foundry-public";
      foundryUserId: string;
      text: string;
      convention?: "ic" | "ooc";
    }
  | {
      kind: "chat.whisper.player-to-dm";
      surface: "foundry-whisper";
      foundryUserId: string;
      text: string;
    }
  | {
      kind: "chat.command";
      surface: "foundry-chat-command";
      foundryUserId: string;
      verb: string;
      args: ReadonlyArray<string>;
      raw: string;
    }
  | {
      kind: "console.control";
      surface: "web-console";
      operatorActorId: string;
      control: ConsoleControl;
    };
```

`foundryUserId` is opaque at this layer; the orchestrator resolves it to a Discord user via the 3-way identity map from TDD 0036 before applying tenant-scoped logic.

**IC/OOC convention parsing** is the surface adapter's job, not the orchestrator's — Discord voice has voice-side conventions (the wake-phrase pattern from TDD 0015), Foundry public chat has Foundry-side conventions (`!ooc` slash, `((parens))`). Both adapters normalize to the same `convention` field on the event, so the orchestrator sees one shape.

### 4. The router itself

```ts
// orchestrator/surfaces/router.ts
export interface SurfaceOutput {
  audience: Audience;
  text?: string; // table mirror, whisper text, GM chat
  audio?: TtsStream; // narration; voice surface only consumes it
  meta?: {
    escalation?: boolean; // true = operator-targeted gm-audience content (routes
    //   whisper-to-operator + gm chat);
    // false = inline error / non-escalating gm output
    //   (gm chat only; do NOT also whisper-to-operator).
    //   Absent is treated as false at the router boundary.
    sceneChange?: { fromSceneId: string; toSceneId: string }; // FoundryPublicChat formats
    diceReceipt?: {
      formula: string;
      result: number;
      rollMode?: "public" | "gm" | "blind" | "whisperTo";
      whisperTo?: ReadonlyArray<string>;
    };
    handout?: { journalRef: string; recipients: ReadonlyArray<string> }; // whisper-surface formats
  };
}

export class SurfaceRouter {
  register(surface: OutboundSurface | InboundSurface): void;
  async emit(output: SurfaceOutput): Promise<EmitReport>;
  events(): AsyncIterable<SurfaceInputEvent>; // multiplexed inbound
}

export interface EmitReport {
  perSurface: ReadonlyArray<{ surface: string; status: "ok" | "failed"; error?: string }>;
  totalSurfaces: number;
}
```

Emit is **fan-out parallel** (table audience writes voice _and_ public chat simultaneously). Per-surface failures don't abort the others — the report names which failed. The orchestrator decides what to do with a partial-failure report (TDD 0035's audience invariant is structural at composition time, not at delivery; a Foundry whisper failure for a `player:<id>` output is logged + counted, the Skeinkeeper-side dialogue record is still written, and the operator sees a `surface.emit.failed` telemetry event — it doesn't crash the turn).

**Audience composition is not the router's job.** Hot-context assembly (TDD 0026 §3, carried by TDD 0035) builds `player:<id>` contexts that exclude other players' private content and any `gm` content — this is the FIRST anti-leak layer and lives _above_ the router. The router enforces only the second layer: emit-time, the audience-tagged content lands on the surface(s) that own that audience, never another. Two layers, both load-bearing (PRD §5.5).

### 5. Foundry public chat — the new player text input

PRD §4.1's relocation of player text input from a parallel Discord text channel to Foundry public chat lives in `FoundryPublicChatSurface`'s inbound adapter. The chat-event subscription comes from the bridge (TDD 0037 §`chat-command` listener delivers ALL public-chat events to Skeinkeeper, not only `/`-prefixed commands; the bridge driver distinguishes operator commands from player text input by prefix match).

Inbound event shape (`chat.public`, above): the bridge delivers `{ foundryUserId, text }`; the adapter parses the IC/OOC convention markers (`!ooc`, `((parens))`, or the per-campaign-configured wake phrase) and emits the typed event. The orchestrator turn loop (TDD 0011) treats `chat.public` events identically to `voice.utterance` events except for the transport — both produce `TurnInput` rows; the speaker is the resolved Discord user (via TDD 0036's 3-way identity).

### 6. Foundry chat-command surface — operator command input

The bridge driver (`/plugins/vtt-foundry/`) parses operator commands out of the Foundry public-chat stream by **`/skeinkeeper`-prefix match** (the verbatim verb taxonomy from TDD 0025 is retained, per the design decision in this design pass — see §4.2 of the PRD on operator commands). Commands the bridge driver recognizes:

```
/skeinkeeper session action:<start|stop|pause|resume>
/skeinkeeper eagerness level:<low|medium|high>
/skeinkeeper voice action:<list|set> [persona:<name>]
/skeinkeeper operator action:claim
/skeinkeeper intake resolve <id> <option>
/skeinkeeper consent <accept|decline>            # player self-action, not operator-control
/skeinkeeper map @<discord-user> <character>     # operator override of TDD 0016/0036's player↔character map
/skeinkeeper pvp <on|off>                        # operator-controlled PvP toggle (TDD 0026 §6 / TDD 0035)
```

`/skeinkeeper`-prefix match is deterministic; the parser rejects malformed args with an inline error chat message back to the invoker (`FoundryGmChatSurface` whisper to that Foundry user). The verb-to-`ConsoleControl` mapping is a small pure table; unit-tested. Other Foundry chat messages (no prefix or different prefix) are emitted as `chat.public` events; the parser never silently consumes a message that wasn't `/skeinkeeper`-prefixed.

**Why the prefix and not the bridge's native command-registration surface (when it lands).** Foundry's top-level slash namespace (`/r`, `/w`, `/gm`, `/em`, …) is globally first-come-first-served across all installed modules. `/skeinkeeper` is our pseudo-namespace inside the global slash space and collision-safe against Foundry core and other modules. It also preserves the verb taxonomy from TDD 0025 verbatim, so an operator who learned the Discord-slash surface doesn't relearn — they just type the same string in Foundry chat instead. Operator chat surfacing details and parity discipline are TDD 0040's job; this TDD provides the inbound adapter that surfaces `chat.command` events with parsed verb + args.

**v0.5 dependency: `chat-command` listener bridge capability.** The bridge today has no first-class chat-event subscription tool. This TDD's inbound adapter is **buildable only after** TDD 0037's critical batch lands the `chat-command` listener (the design pass's `/loop` decision: block v0.5 on this bridge dep landing rather than ship a Discord-only operator surface or rely on a brittle full-chat-stream poll). The design above is what the adapter looks like once the dep is available; without it, the entire operator-command surface in 0040 is non-functional and the operator-escalation flow in 0036 has no resolution path.

### 7. The web console as a surface (operator-only)

The console retains its existing API + SSE-bus design (TDD 0020, TDD 0025). It is exposed to the router only as an _inbound_ `console.control` event source and as the SSE echo of `AppEvent`s. The router does NOT route player-facing outputs to the console — the console renders state for the operator from the same `SessionManager` writes that the player surfaces produce, via the existing SSE bus. Web console is operator-only by construction.

### 8. Telemetry events

Per-surface emit + receive observability:

| Event                    | Payload                                                       | Description                                                                             |
| ------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `surface.emit`           | `{ surface, audience: { kind, player?: hashed }, latencyMs }` | Successful outbound emission; player IDs hashed via the existing salt (TDD 0003 / 0038) |
| `surface.emit.failed`    | `{ surface, audience: { kind, player?: hashed }, reason }`    | Per-surface emit failure                                                                |
| `surface.input`          | `{ surface, kind }`                                           | Inbound event received (no content; kind only)                                          |
| `surface.command.parsed` | `{ verb, ok: boolean }`                                       | Operator command parsed (verb only; no args — args can contain player Discord IDs)      |

All PII-free per [ADR-0010](../adr/0010-privacy-as-architecture.md). `player` ID is the existing salted hash.

## Components & interfaces

```ts
// orchestrator/surfaces/audience.ts
export type Audience =
  | { kind: "table" }
  | { kind: "player"; playerId: string } // playerId = Discord user ID, resolved to Foundry user at the surface adapter
  | { kind: "gm" };

// orchestrator/surfaces/surface.ts
export interface OutboundSurface {
  readonly name: string;
  readonly handles: ReadonlyArray<Audience["kind"]>;
  emit(output: SurfaceOutput): Promise<void>;
}

export interface InboundSurface {
  readonly name: string;
  events(): AsyncIterable<SurfaceInputEvent>;
}

// orchestrator/surfaces/router.ts
export class SurfaceRouter {
  register(surface: OutboundSurface | InboundSurface): void;
  emit(output: SurfaceOutput): Promise<EmitReport>;
  events(): AsyncIterable<SurfaceInputEvent>;
}
```

The router is constructed once per `Session` (TDD 0011) and shared across turns. The Coordinator (TDD 0026 §3 / TDD 0035 §3) owns the router and the inbound multiplexer; the turn loop (TDD 0011's `runTurn`) emits outputs through `router.emit` instead of writing surfaces directly.

### Surface adapter file layout

| Adapter                     | Lives in                 | Owned by                                                                                                                                                       |
| --------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiscordVoiceSurface`       | `plugins/voice-discord/` | TDD 0012 + 0015 + 0018; extended to implement the OutboundSurface/InboundSurface shapes here                                                                   |
| `DiscordConsentSurface`     | `plugins/voice-discord/` | TDD 0012; narrowed to consent-only per the PRD's surface model                                                                                                 |
| `FoundryPublicChatSurface`  | `plugins/vtt-foundry/`   | This TDD; consumes the bridge's `post-chat-message` (TDD 0037) and chat-event subscription (TDD 0037 `chat-command` listener — also delivers non-`/` messages) |
| `FoundryWhisperSurface`     | `plugins/vtt-foundry/`   | This TDD; consumes the bridge's `post-chat-message` with `whisperTo` and chat-event subscription                                                               |
| `FoundryGmChatSurface`      | `plugins/vtt-foundry/`   | This TDD; consumes the bridge's `post-chat-message` with `gm` mode                                                                                             |
| `FoundryChatCommandSurface` | `plugins/vtt-foundry/`   | This TDD; parses `/skeinkeeper`-prefixed messages from the chat-event subscription                                                                             |
| `WebConsoleSurface`         | `app/web/`               | TDD 0020 + 0025; extended to implement InboundSurface for `console.control`                                                                                    |

The Foundry-side adapters all depend on `FoundryClient` (TDD 0014) for transport. The chat-event subscription is a new `FoundryClient` method (`subscribeChatEvents(handler)`) wired through `McpFoundryClient` to the bridge's chat-listener capability (TDD 0037).

## Data & state

No new persistent state on the Skeinkeeper side. The router is in-process; the surface adapters are stateless wrappers around the existing transports.

Foundry-side state writes (chat messages, whispers, GM chat) are mechanical state and live in Foundry per [ADR-0018](../adr/0018-foundry-source-of-truth.md). The router does not store a copy of what it emitted; the audience-tagged dialogue persistence layer (TDD 0013 + TDD 0035) is the system-of-record for what was said, by whom, to whom.

## Sequencing / implementation plan

1. **`Audience` type and the `OutboundSurface` / `InboundSurface` interfaces** in `orchestrator/surfaces/`. Pure types; no transport.
2. **`SurfaceRouter`** with in-memory fan-out + multiplexed inbound. Unit-tested with two `FakeSurface` implementations.
3. **`FoundryPublicChatSurface` (outbound)** wrapping `FoundryClient.postChatMessage`. Requires the v0.5-blocking bridge dep (TDD 0037 §1) to be available; until then, the orchestrator's table-audience text writes are a no-op behind a feature flag, blocked at session-start with an operator-visible warning.
4. **`FoundryWhisperSurface` (outbound)** with `whisperTo: [foundryUserId]`. Same bridge dep.
5. **`FoundryGmChatSurface` (outbound)** with `gm` mode. Same bridge dep. Operator-escalation routing (`meta.escalation: true` → also whisper-to-operator-Foundry-user) lands here.
6. **Chat-event subscription on `FoundryClient`** (new `subscribeChatEvents(handler)` method on the interface; `McpFoundryClient` implementation wired to TDD 0037's `chat-command` listener bridge capability). Buildable only after that bridge cap exists.
7. **`FoundryPublicChatSurface` (inbound)** consuming the subscription; parses IC/OOC convention markers; emits `chat.public` events.
8. **`FoundryWhisperSurface` (inbound)** filtering whisper-to-AI events from the same subscription.
9. **`FoundryChatCommandSurface` (inbound)** parsing `/skeinkeeper <verb> <args>` from the same subscription; verb-to-`ConsoleControl` table; inline error responses via `FoundryGmChatSurface`.
10. **Orchestrator turn-loop rewire (TDD 0011 in-place edit, not supersession — Coordinator-only wiring change).** `runTurn`'s narration write goes through `router.emit({ audience: { kind: "table" }, text, audio })` instead of writing `DiscordVoiceIO` directly. The audio path inside `DiscordVoiceSurface.emit` preserves the existing TTS streaming behavior unchanged.
11. **Per-surface telemetry emission** at the router boundary (one place, all surfaces).
12. **Discord text-channel writes deleted.** Audit the codebase (`grep -r "textChannel\|.send("`) for any remaining Discord-text writes that aren't the one-time consent DM; delete or migrate. The narrowing-to-consent-only is enforced at this step.

## Failure modes & edge cases

- **A registered surface fails to emit** (bridge timeout, Discord HTTP error). The router's fan-out continues — the report names the failed surface; the orchestrator does not retry inside `emit` (caller decides). For table-audience output, a Foundry-public-chat failure means the text mirror is missing for that turn but voice narration still happened; the operator sees `surface.emit.failed` telemetry + the failed message in the operator console's error pane (TDD 0020 surface).
- **Foundry/bridge disconnected mid-session.** All Foundry-side emits begin failing. TDD 0039 owns the session-lifecycle response (pause turn loop, preserve state, no voice-only continuation). The router itself is unchanged — it surfaces the failures; the lifecycle TDD acts on them.
- **Audience with no handling surface.** Hard error at `emit` time (defensive — surface registration is wired at session construction; a missing registration is a developer mistake, not a runtime condition). The error is logged with the audience and the registered-surface list and re-raised; the turn fails.
- **Operator command parse failure.** The parser emits a `surface.command.parsed { ok: false }` event and writes an inline error message back to the invoker via `FoundryGmChatSurface` whisper. The orchestrator does not see a `chat.command` event for malformed commands; behavior of the operator-control layer (TDD 0040) is unaffected.
- **A `/skeinkeeper`-prefixed message from a non-operator Foundry user.** The parser emits the event with the Foundry user ID; TDD 0040's control handler rejects it at the authorization layer (per ADR-0016 the operator-control write path validates the actor). Non-operator commands fail closed; the inline error explains.
- **Player whispers the bot in Discord (not Foundry) post-narrowing.** Discord DM listener for non-consent messages emits a one-time response: "Side-channels moved to Foundry — whisper the DM there." The behavior is in the `DiscordConsentSurface` adapter (it has the only Discord DM listener); it is the sole exception to "Discord DM = consent only" and is a courtesy, not a side-channel transport. Behavior-spec'd, not a routing path.
- **A chat-event subscription drop** (bridge reconnect, Foundry reload). The bridge driver re-subscribes on reconnect; events during the gap are lost but no orchestrator state is corrupted (the dialogue store is the system-of-record, written when the orchestrator processes the event — not when the surface receives it). TDD 0039 covers the lifecycle aspect.

## Verification plan

The router and adapters' observable surfaces and the scenarios that drive each:

- **Audience → outbound surfaces fan-out.** _Observable surface:_ each registered `FakeOutboundSurface`'s recorded emit log. _Observation point:_ unit test — register two fakes (one handling `["table"]`, one handling `["player"]`), call `router.emit({ audience: { kind: "table" }, text: "hi", audio: null })`, then `router.emit({ audience: { kind: "player", playerId: "p1" }, text: "psst" })`. _Expected:_ the first fake's log has one entry from the `table` emit AND one from the `player` emit if registered for both (it isn't), so only the first fake receives `"hi"`; only the second fake receives `"psst"`. `EmitReport.perSurface` lists the surfaces fanned to.
- **Unhandled audience hard-errors.** _Surface:_ `router.emit` thrown error + telemetry. _Observation point:_ unit test — register only a `gm`-handling fake, then `router.emit({ audience: { kind: "table" }, text: "..." })`. _Expected:_ `emit` rejects with an explicit "no surface for audience kind=table" error; no `surface.emit` telemetry event fires; `surface.emit.failed` does, with `reason: "no-handling-surface"`.
- **Operator command parsing — happy path.** _Surface:_ `chat.command` event emitted on the inbound stream + `surface.command.parsed { ok: true }` telemetry. _Observation point:_ unit test — feed `FoundryChatCommandSurface` a chat event with text `/skeinkeeper eagerness level:high`. _Expected:_ one `chat.command` event on the stream with `verb: "eagerness"`, `args: ["level:high"]`, `raw: "/skeinkeeper eagerness level:high"`; one parsed-ok telemetry event.
- **Operator command parsing — malformed.** _Surface:_ inline whisper response via `FoundryGmChatSurface` + `surface.command.parsed { ok: false }`. _Observation point:_ unit test — feed text `/skeinkeeper foo bar baz` (unknown verb). _Expected:_ NO `chat.command` event on the stream; one inline-whisper emit recorded on the `FoundryGmChatSurface` fake addressed to the invoker; one parsed-failed telemetry.
- **Non-`/skeinkeeper` chat passes through as `chat.public`.** _Surface:_ `chat.public` event on the stream. _Observation point:_ unit test — feed text `I look around the room.` _Expected:_ one `chat.public` event with `text: "I look around the room."`, `convention: undefined`; no `chat.command` event.
- **IC/OOC convention parsing.** _Surface:_ `convention` field on `chat.public` events. _Observation point:_ unit test cases for `!ooc let's break for snacks`, `((my player saw that))`, `I open the door`, and the configured wake-phrase variant. _Expected:_ first two yield `convention: "ooc"`; third yields `convention: undefined`; wake-phrase case yields `convention: "ic"` per the campaign config.
- **Per-surface emit failure isolates.** _Surface:_ `EmitReport` + per-surface telemetry. _Observation point:_ integration test — register one fake that throws on emit + one that succeeds; both handle `table`. Call `router.emit({ audience: { kind: "table" }, text: "x" })`. _Expected:_ report has both surfaces, one `status: "failed"` with error, one `status: "ok"`; one `surface.emit.failed` telemetry + one `surface.emit` telemetry; the call does not throw.
- **Live: operator command end-to-end** (requires bridge + live Foundry). _Surface:_ Foundry chat showing the inline ack OR the resulting state change. _Observation point:_ operator types `/skeinkeeper eagerness level:high` in Foundry chat; observe the eagerness change reflected in the web console's eagerness control (live cross-surface sync from TDD 0040). _Expected:_ console eagerness reads "high" within ~500ms; no error in the operator chat.

The router and the parser are pure-ish (input event in → output events + emits out) and CI-testable with fakes. The chat-event subscription wiring + the live bridge transport are operator-validated against a real Foundry per the existing TDD 0014 / TDD 0027 pattern.

## Requirement traceability

| PRD ref                                  | Requirement                                                                                                                         | Satisfied by                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 (Surface model preamble)               | Voice on Discord; consent on Discord DM (one-time only); text + ops on Foundry; web console operator-only                           | The `OutboundSurface`/`InboundSurface` set in §1; the audience → surface map in §2; hard rule that the router rejects audiences with no handling surface (no silent drop)                          |
| 4 (Hard rule: no Discord/Foundry mirror) | "Skeinkeeper does not maintain a parallel Discord text channel mirror."                                                             | Step 12 of the sequencing plan deletes existing Discord-text writes; the absence is enforced by the surface set (no `DiscordTextChannelSurface` is registered)                                     |
| 4 (Hard rule: consent-only Discord DM)   | "Consent stays on Discord DM (one-time exception). … the _sole_ remaining text use of Discord"                                      | `DiscordConsentSurface` is the only Discord text adapter; carries the one-time non-side-channel courtesy reply in §Failure modes (player whispers bot on Discord) and nothing else                 |
| 4.1                                      | Text input via Foundry public chat, not a parallel Discord text channel                                                             | `FoundryPublicChatSurface` inbound adapter (§5) parses Foundry chat events into `chat.public` events the orchestrator turn loop consumes                                                           |
| 4.1                                      | Mirrored text transcript in Foundry public chat                                                                                     | The audience → surface map (§2): `table`-audience outputs fan to both `DiscordVoiceSurface` (audio) AND `FoundryPublicChatSurface` (text)                                                          |
| 4.1                                      | IC vs OOC disambiguation by convention — applies to voice and Foundry-chat text alike                                               | Inbound `chat.public` and `voice.utterance` events both carry a `convention` field; per-surface parsing in §3                                                                                      |
| 4.2 (Critical bridge dep)                | `post-chat-message` with audience targeting (`table` → public; `whisperTo: [userId]` → whisper; `gm` → GM-only)                     | All three Foundry-chat outbound adapters (`FoundryPublicChatSurface`, `FoundryWhisperSurface`, `FoundryGmChatSurface`) consume the new bridge capability; TDD 0037 carries the upstream proposal   |
| 4.2 (Critical bridge dep)                | `chat-command` listener (bridge → Skeinkeeper subscription on Foundry chat events)                                                  | `FoundryClient.subscribeChatEvents` (§Components) backed by the bridge capability; consumed by `FoundryPublicChatSurface` + `FoundryWhisperSurface` + `FoundryChatCommandSurface` inbound adapters |
| 4.2 (Operator escalation channel)        | Operator escalations delivered as GM-only chat or whisper to the operator's Foundry user                                            | `FoundryGmChatSurface` consumes `meta.escalation: true` to add `whisperTo: operatorFoundryUserId` when known; falls back to broadcast GM-chat when unknown                                         |
| 4.2 (Operator commands)                  | Operator commands typed as Foundry chat commands surfaced through the bridge                                                        | `FoundryChatCommandSurface` (§6) parses `/skeinkeeper <verb> <args>` from the chat-event subscription                                                                                              |
| 4.3                                      | "Whisper — targeted private text, delivered via Foundry whisper to the target player; the same mechanism as the §4.7 side-channel"  | The `whisper` tool's outbound path emits `{ audience: { kind: "player", playerId } }`; the router routes to `FoundryWhisperSurface` per §2                                                         |
| 4.7                                      | Audience model maps directly onto Foundry's chat surfaces: `table` → public, `player:<id>` → whisper to that player, `gm` → GM-only | §2's audience-to-surface map IS this requirement, expressed in code                                                                                                                                |
| 4.8                                      | `notify_operator` content delivered as GM-only chat (or whisper to operator's Foundry user)                                         | `meta.escalation: true` flag (§2 / §4); operator-Foundry-user resolution via TDD 0036's 3-way identity                                                                                             |
| 5.8                                      | If Foundry or the bridge disconnects, the session pauses with state preserved — no "voice-only" continuation mode                   | The router surfaces emit failures via the `EmitReport`; TDD 0039 implements the session-lifecycle response. This TDD does NOT add a voice-only fallback                                            |

## Dependencies considered

No new third-party dependencies. The router is in-process TypeScript; surface adapters reuse existing transports (`discord.js`, `@discordjs/voice`, the MCP bridge via TDD 0014's `FoundryClient`).

A single load-bearing **bridge-side** dependency is added by this design: `chat-command` listener / chat-event subscription (TDD 0037). This is upstream to `adambdooley/foundry-vtt-mcp` (or, per ADR-0011's fork-as-Plan-B clause, to a Skeinkeeper fork) — see TDD 0037 for the alternative analysis (own-Foundry-module path considered and declined in this design pass; bridge-fork retained as Plan B if upstream stalls).

Two alternative routing-layer shapes were considered:

- **Per-output direct surface writes (no router).** Keep the ad-hoc style — `notify_operator`-the-tool writes directly to Foundry GM chat; the `whisper` tool writes directly to Foundry whisper; the turn loop writes directly to voice + Foundry public chat. Rejected: that's the current shape and it's exactly what made the PRD's surface-model change painful to apply — every caller embeds its surface choice. The router localizes the change to one place.
- **A pub/sub broker (e.g., a typed event bus) the orchestrator publishes to and surfaces subscribe to.** Rejected for v0.5: introduces an extra indirection without payoff (the audience set is small and known; surfaces are not pluggable by third parties). The router IS effectively a typed pub/sub for the audience kinds; a broker abstraction would be premature generalization. The existing in-process SSE-bus pattern (TDD 0025) covers the operator-side state-echo case already; we don't unify them.

## PRD conflicts surfaced (and resolution)

1. **Operator-escalation channel under "operator may also be a player at the table" (PRD §4.8 spoiler-aware escalations).** Operator escalations route to `gm`-audience surfaces (GM chat) — which, when the operator is also a player, are NOT visible to other players but ARE visible to the operator. The spoiler-aware-escalation principle from §4.8 (frame the _choice_ without leaking _context_) is a behavior-spec concern (the AI's prompt + the intake findings' text), not a routing concern: the router just delivers what the orchestrator emits. **Resolution:** noted; behavior-spec language enforces spoiler-safety on the content side; routing is content-agnostic.

2. **Discord-DM-as-courtesy reply when a player whispers the bot on Discord post-narrowing.** PRD §4 hard rule says "Consent stays on Discord DM (one-time exception)" — strictly that's one outbound message. A one-time courtesy redirect ("side-channels moved to Foundry") is technically a second use. **Resolution:** include as an explicit exception in this TDD §Failure modes; the rule is intent-preserving (one-time per-player; redirect-only; never the side-channel transport). If this becomes a privacy/scope concern at the design-PR gate, the alternative is to send no reply and rely on operator/onboarding-DM language to set expectations — accept the small UX cost.

3. **No `chat-command` listener bridge cap means no operator-command surface and no Foundry-side player text input.** The PRD names both as v0.5 capabilities. **Resolution:** TDD 0037 elevates the bridge cap to v0.5-blocking; this TDD's affected adapters (§6 + §5 inbound) are non-functional until that lands. The design pass's `/loop` decision is to accept this block rather than ship a Discord-only operator surface or a brittle full-chat-stream poll.

## Decisions to promote (ADR candidates)

Three new ADRs were promoted from this design pass and are now accepted alongside this TDD in the design PR — distinct from existing ADR-0023 (who-does-what) and ADR-0024 (escalation discipline):

1. **[ADR-0025: Foundry is the table-text + operator surface](../adr/0025-foundry-as-table-text-and-operator-surface.md).** Promotes the §1–§2 contract of this TDD to architectural status. Multiple TDDs in this design pass depend on it (0035 / 0036 / 0038 / 0040).

2. **[ADR-0026: Fully-remote, all-individual configuration](../adr/0026-fully-remote-all-individual-configuration.md).** Captures the v0.5 table configuration constraint (each player on their own Discord + Foundry session) that the surface model and identity model both presuppose.

3. **[ADR-0027: Sessions are session-bounded](../adr/0027-sessions-are-session-bounded.md).** Captures the scope constraint that state is durable only when named on the explicit durable-surface list; everything else dies at Stop.

## Telemetry implications

Listed in §8 above. Four new events: `surface.emit`, `surface.emit.failed`, `surface.input`, `surface.command.parsed`. All PII-free per [ADR-0010](../adr/0010-privacy-as-architecture.md). Player IDs in payloads use the existing salted hash from TDD 0003 / TDD 0038. Registered in `/telemetry/src/events.ts` and `/docs/telemetry-events.md` per CLAUDE.md hard rule #3.

## Privacy implications

No new persistent storage in the router. The audience model the router enforces IS the per-audience visibility guarantee from [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md), now operationalized at the delivery boundary:

- **`table` audience** is broadcast to all participating surfaces.
- **`player:<id>` audience** is delivered _only_ to that player's whisper surface; the Foundry-whisper render enforces visibility per-recipient (second anti-leak layer per PRD §5.5).
- **`gm` audience** is delivered _only_ to GM-role Foundry users; Foundry's GM-chat render enforces visibility.

Skeinkeeper-side composition (hot context excludes other players' private content and `gm` content from `player:<id>` contexts; TDD 0026 §3 / TDD 0035) is the first anti-leak layer; this TDD's emit-time routing is the second. Both are load-bearing; neither alone is sufficient.

No new personal data is processed. The router sees content that the orchestrator has already composed; PII-marked fields stay PII-marked end to end.

## Eval implications

- **Unit-testable (the bulk):** router fan-out and unhandled-audience hard-error (§Verification plan), the `/skeinkeeper` parser (verb table + argument shapes), the IC/OOC convention parsers per surface, per-surface adapter mappings to `FoundryClient.postChatMessage` calls (mocked).
- **`eval:live` fixtures (behavior-spec interplay):** the operator-escalation routing flag (`meta.escalation: true`) — that escalations land in GM chat with whisper-to-operator when known, GM-broadcast otherwise. One fixture each for the two paths.
- **Operator-validated (live):** chat-event subscription end-to-end against a real Foundry + bridge (gated on TDD 0037's `chat-command` listener cap); the operator-command-to-state-change round-trip in §Verification plan.

## Open questions

- **Whisper-from-bot-on-Discord courtesy reply UX (PRD-conflict #2 above).** Final form — a one-time reply per player on a Discord DM that isn't the consent prompt? Or strict no-reply with onboarding-DM language? Recommendation in this TDD: one-time courtesy reply, behavior-spec'd; revisit at the design-PR gate if the privacy-scope reading objects.
- **Per-surface emit timeouts vs. PRD §5.3 latency budget.** The `EmitReport` shape allows per-surface failures, but the per-emit timeout (a slow Foundry-side response stalling the table-voice path) is unspecified. PRD §5.3 sets ≤3s p95 / ≤6s p99 for voice round-trip, of which LLM inference and TTS already consume most of the budget — a per-surface emit that takes seconds would blow it. **Resolution:** per-surface emit timeout defaults to 1.5s (leaves room for the rest of the round-trip), with two exceptions: (a) the voice-narration surface itself is not timeout-bounded by the router (its budget IS the round-trip budget); (b) `gm`-audience escalations are not on the voice critical path and can tolerate the full 5s. The defaults are session-config-tunable for operators with slow Foundry instances who accept the latency cost. The router emits `surface.emit.failed` with `reason: "timeout"` distinct from other failures so operators can tune from telemetry.
