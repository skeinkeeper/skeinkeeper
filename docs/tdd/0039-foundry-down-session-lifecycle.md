# TDD 0039: Foundry-Down Session Lifecycle

Status: implemented
PRD refs: 5.8
PRD-rev: 5c3a198
ADR constraints: 0003, 0008, 0016, 0018, 0023, 0024, 0025, 0027, 0029, 0030
Supersedes: [TDD 0011](./0011-orchestrator-turn-loop.md) (narrowly — failure-mode model only; `runTurn` design carries forward unchanged)
Author: maintainers
Date: 2026-05-26
Related TDDs: [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0041 (first-party Foundry add-on)](./0041-first-party-foundry-addon.md), [0020 (operator app)](./0020-operator-app.md), [0025 (operator control parity)](./0025-operator-control-parity.md), [0028 (real-time voice latency)](./0028-real-time-voice-latency.md), [0034 (surface routing & I/O abstraction)](./0034-surface-routing-and-io-abstraction.md), [0036 (onboarding + Foundry-user pre-flight)](./0036-onboarding-and-foundry-user-preflight.md), [0040 (operator control parity — Foundry chat commands)](./0040-operator-control-parity-foundry-chat-commands.md)

**Prerequisite:** [TDD 0041](./0041-first-party-foundry-addon.md). Foundry-down is
add-on `evt gone` plus `FoundryClient` heartbeat. Do not implement a
`startBridgeHeartbeat` or any MCP stdio disconnect detector. There is no
third-party connector to watch.

## Carries forward / supersedes (read first)

This TDD supersedes [TDD 0011](./0011-orchestrator-turn-loop.md) **narrowly — only its failure-mode model for VTT-disconnect**. TDD 0011's `runTurn` design + `Session` shape + Phase-2a integration + hot-context assembly + audit-log writes + all other substantive sections carry forward unchanged. The append-only discipline (TDD 0011 was `implemented`) requires a new document for the substantive change; this document is intentionally narrow and references TDD 0011 for everything outside its scope.

**The single substantive change.** PRD §5.8's graceful-degradation model used to read:

> If VTT disconnects, fall back to chat-only narration with state preserved.

It now reads:

> If Foundry becomes unreachable (add-on `evt gone`, TDD 0041), the session pauses with state preserved — there is no "voice-only" continuation mode, because under the Surface model the player text surface lives in Foundry; the operator restarts the session when Foundry is back.

That's the entire substantive delta. This TDD codifies the new behavior, names the lifecycle transitions and the operator-visible signals, and explicitly **deletes the prior chat-only-narration fallback path.**

**Carried forward from TDD 0011 unchanged:**

- The `Session` config + `runTurn` signature.
- Hot-context assembly + warm-state assembly.
- The tool-dispatch iteration cap + the dispatcher's single-writer serialization.
- Audit-log writes + telemetry per turn.
- Dialogue persistence (TDD 0013).
- Voice + Foundry happy-path behavior.
- Everything else.

**New / substantively changed in this TDD:**

- A `SessionLifecycleState` machine (`active` → `paused-foundry-down` → `active`) the Coordinator owns; replaces the implicit always-on state.
- A Foundry-down detector: TDD 0041 `evt gone`, TDD 0034 `EmitReport` failures, and a periodic heartbeat against `FoundryClient.listUsers()`; transitions the state on detection.
- An explicit pause behavior: the turn loop drains in-flight work, the always-listening loop continues to consume voice audio to a paused buffer (no LLM calls), and emit attempts to Foundry-side surfaces are short-circuited (no retries, no error spam).
- An operator notification at the transition: the web console + Discord voice (a single TTS announce, voice surface is up) + the audit log all carry the pause event with the cause.
- An operator-driven resume: explicit `/skeinkeeper session action:resume` (TDD 0040 surface) or the equivalent web console action; both go through TDD 0025's `SessionManager` write path. Auto-resume on add-on reconnect is NOT in scope at v0.5 (see §"Open questions").
- The prior "voice-only / chat-only narration" fallback code path is **deleted** — its absence is a code-level reflection of the PRD's surface-model decision that text now lives in Foundry.

## Approach

The PRD revision narrows the supported configuration to "every player has Foundry," which removes voice-only continuation as a meaningful degraded mode: if the table-text surface (Foundry public chat) is unavailable, the players can no longer read narration mirror, IC/OOC convention markers, dice receipts, or scene-change notifications; the orchestrator can't deliver to half its audience model. **Continuing voice-only would be misleading — it would look like things were working when they aren't.** Pausing is the honest behavior.

The shape of the lifecycle state machine is small (two states + the transitions) and the operator-facing signals are unsurprising; the implementation depth is mostly in correctly handling the in-flight turn at pause-time so no half-applied tool calls land on Foundry-side state when the add-on comes back.

### 1. The lifecycle states

```ts
// orchestrator/sessions/lifecycle.ts
export type SessionLifecycleState =
  | { kind: "active" }
  | {
      kind: "paused-foundry-down";
      since: ISO8601;
      cause: "addon-gone" | "emit-failure" | "heartbeat-failure";
      lastError: string;
    };
```

The Coordinator owns the state. Transitions:

- **`active` → `paused-foundry-down`** on detection (§2). The transition is one-shot per session-pause-episode; subsequent failures while paused are absorbed (no event-spam).
- **`paused-foundry-down` → `active`** on operator-issued resume (§3). Re-runs the pre-flight verifier (TDD 0036 §3a) — if the add-on is genuinely back (`hello-ok`), verifier returns `ok`; if not, the transition fails with the verifier's findings + the state stays `paused-foundry-down`.

There is intentionally no `paused-foundry-down → paused-foundry-down` self-transition; once paused, additional Foundry errors don't change state.

### 2. The Foundry-down detector

Three signals, fused, drive the transition to `paused-foundry-down`:

**(a) TDD 0041 `evt gone`.** The add-on socket closed (GM closed Foundry, network drop, add-on disabled). One `gone` is enough; do not wait for emit storms.

**(b) `surface.emit.failed` storms.** When TDD 0034's router reports an emit failure to ANY Foundry-side surface (`FoundryPublicChatSurface`, `FoundryWhisperSurface`, `FoundryGmChatSurface`), the detector counts it. **Threshold:** ≥3 consecutive emit failures (any combination of Foundry surfaces) within a 30-second window. A single transient failure doesn't trigger; a sustained failure does.

**(c) Periodic heartbeat.** A background timer calls `FoundryClient.listUsers()` (TDD 0041) every 30 seconds. On consecutive heartbeat failure (≥2 in a row, ~60s of Foundry unreachability), transitions immediately.

Signal (a) is the load-bearing transport signal. (b) catches active-traffic failures if `gone` was missed. (c) catches silent failures during a quiet session (the operator has stepped away; no traffic is being attempted; the add-on died; we'd otherwise not notice until traffic resumed).

### 3. The pause behavior

Entering `paused-foundry-down`:

1. **The current in-flight turn drains.** Any LLM call in flight at transition-time completes; any pending tool-dispatch step against Foundry that hasn't yet been called is skipped (the dispatcher checks `lifecycleState.kind` before each tool call and aborts the turn with an `aborted-foundry-down` reason if non-`active`). The dialogue store records the turn as aborted with the cause; audit log captures it.
2. **The turn loop stops accepting new inputs.** Voice utterances and Foundry-chat inputs (when they were arriving — under the pause cause, Foundry-chat inputs aren't arriving anyway) are buffered to a bounded queue (max 100 events; older events dropped with a counter-event); the always-listening loop continues consuming voice audio (so the per-speaker STT doesn't lose the latest words from the moment the operator restored Foundry); no LLM call happens against the buffer until resume.
3. **The Discord voice surface emits a single TTS pause announcement** (the announcement is generated by the LLM at session-setup time and cached, so no LLM call is needed at pause-time — the cached string is the only thing TTS'd). Example phrasing: "I'm pausing the session — looks like Foundry's lost contact. We'll resume when the operator's restored it." The announcement bypasses the lifecycle state's input-buffer (it's TTS-only, not a turn).
4. **`notify_operator` is NOT used for pause notification.** `notify_operator` writes to Foundry GM chat (TDD 0036) — exactly the surface that's unavailable. The pause notification routes to the web console's escalation pane via the existing SSE bus (TDD 0025 / TDD 0020), AND a Discord DM to the operator IF the operator has consented to DM contact (a separate one-time consent from player consent; tracked by operator-self-designation flow per TDD 0024). The Discord DM is operator-only and is the SECOND of two narrow exceptions to "Discord DM = one-time consent only" (the first is the courtesy redirect from TDD 0034); rationale: the operator's primary Foundry-side surface is the very surface that's down — they need an out-of-band signal that they can act on.
5. **Audit-log entry.** A `session.paused { cause, lastError }` row in the audit log; existing audit-log infrastructure (TDD 0011).

While paused:

- **Voice continues.** Players on the Discord voice channel can still talk to each other; the bot remains in the channel but emits no TTS narration; STT continues (so utterances are captured to the buffer for post-resume context).
- **No Foundry emits are attempted.** The router's surface adapters check the lifecycle state and short-circuit Foundry-side emits to a no-op + a single `surface.emit.skipped` telemetry event per attempt (not per call — coalesced via a circuit-breaker pattern; the audit log records one summary entry, not N).
- **No tool dispatches against Foundry happen.** The dispatcher's `lifecycleState !== active` short-circuit catches them.

### 4. The resume behavior

Operator issues `/skeinkeeper session action:resume` (Foundry chat command, TDD 0040) OR clicks Resume in the web console. Both paths go through TDD 0025's `SessionManager.resume()` single-write-path method.

`resume()` does:

1. **Re-run the pre-flight verifier** (TDD 0036 §3a) — confirms the add-on is back (`hello-ok` / `listUsers` works), the operator-Foundry-user is still designated, the campaign actors exist, identity map is still consistent. If the verifier returns `critical-gaps`, transition fails; the state stays `paused-foundry-down`; the operator sees the findings inline (Foundry GM chat if it's back; web console if not).
2. **Transition to `active`.** Audit-log entry `session.resumed { pausedDurationMs, bufferedInputs }`.
3. **Emit a resume TTS announcement** on Discord voice (cached similarly): "We're back. Picking up where we left off."
4. **Drain the buffered inputs.** Voice utterances captured during the pause are dispatched in order, each producing a normal turn. Foundry-chat inputs (typically zero, since Foundry was down) are similarly drained.
5. **Resume the turn loop normally.**

A `paused-foundry-down → active` transition is intentionally explicit (operator action only at v0.5). Auto-resume on add-on reconnect was considered and deferred (see §"Open questions"); the operator-as-host model (ADR-0023) puts these gates on the operator deliberately — the operator chooses when the table picks up.

### 5. What we explicitly delete

The prior TDD 0011-era "if Foundry disconnects, fall back to chat-only narration" code path:

- Any conditional in the turn loop or surface adapters that routes around a missing Foundry connection by emitting only to Discord text (which itself is being deleted per TDD 0034 sequencing).
- Any "degraded mode" indicator the operator console used to surface — replaced by the `paused-foundry-down` lifecycle state.
- PRD §5.8's prior wording's text is replaced verbatim in the same PRD revision (already merged); the code-level deletion happens here.

This isn't a code change of its own — the prior fallback never actually shipped, per the TDD 0011 file (which deferred live Foundry to a later phase). What ships is the new lifecycle state machine, INSTEAD of the prior fallback's design intent. Code-archaeology pass: grep for "voice-only," "chat-only," "fallback narration" in `orchestrator/` and `app/` to confirm no orphaned fallback code; delete what's found.

## Components & interfaces

```ts
// orchestrator/sessions/lifecycle.ts
export type SessionLifecycleState =
  | { kind: "active" }
  | {
      kind: "paused-foundry-down";
      since: ISO8601;
      cause: "addon-gone" | "emit-failure" | "heartbeat-failure";
      lastError: string;
    };

export interface LifecycleController {
  current(): SessionLifecycleState;
  onTransition(
    handler: (next: SessionLifecycleState, prev: SessionLifecycleState) => void,
  ): Unsubscribe;
  // Called by detectors; internal
  reportEmitFailure(surface: string, error: string): void;
  reportHeartbeatFailure(error: string): void;
  // Called by SessionManager.resume() (TDD 0025 write path)
  requestResume(): Promise<ResumeResult>;
}

export type ResumeResult =
  | { kind: "ok" }
  | { kind: "preflight-failed"; findings: ReadonlyArray<IdentityPreflightFinding> }
  | { kind: "already-active" };
```

The `LifecycleController` is owned by the Coordinator (constructed alongside it; one per session). The dispatcher reads its state via `controller.current()` before each tool call. Surface adapters read it before each Foundry-side emit.

`SessionManager.resume()` (TDD 0025 surface, extended) calls `controller.requestResume()`. The web console + Foundry chat command both route there; per ADR-0016 the same write path serves both surfaces.

### Heartbeat task

```ts
// orchestrator/sessions/foundry-heartbeat.ts
export function startFoundryHeartbeat(args: {
  client: FoundryClient;
  intervalMs: number; // default 30000
  lifecycle: LifecycleController;
}): { stop(): void };
```

Runs `FoundryClient.listUsers()` on the interval; reports failure to the lifecycle controller; tracks consecutive-failure count internally; transitions on threshold.

### Cached pause/resume TTS strings

```ts
// orchestrator/sessions/cached-announcements.ts
export interface CachedAnnouncement {
  audio: Buffer; // pre-rendered TTS
  text: string; // for fallback if voice is down too (impossible per current scope but defensive)
}

export async function prepareLifecycleAnnouncements(args: {
  llm: LLMProvider; // for one-shot text generation at session start
  tts: TtsProvider; // for pre-rendering
  config: SessionConfig;
}): Promise<{ pauseFoundryDown: CachedAnnouncement; resumeOk: CachedAnnouncement }>;
```

Generated once at session-start; cached in `SessionRunState` (TDD 0032). Re-generated if the campaign's TTS voice config changes mid-session (rare; on change, regenerate next time it's needed).

## Data & state

Lifecycle state is per-session in-memory; not persisted (a session pause that survives a Skeinkeeper restart is the same as a session that wasn't running — the operator restarts via `/skeinkeeper session action:start`). The audit-log entries (`session.paused`, `session.resumed`) ARE persisted via the existing audit-log adapter; they're the durable record.

No new SQL tables; no new columns. The audit-log row format is rich enough already (TDD 0011 § audit-log).

## Sequencing / implementation plan

1. **`LifecycleController` + `SessionLifecycleState`** types in `orchestrator/sessions/lifecycle.ts`. Pure state machine + emit-failure / heartbeat-failure inputs; unit-tested.
2. **`SessionManager.resume()`** method on the existing manager (TDD 0025 extension); calls `controller.requestResume()`.
3. **Coordinator wiring:** construct `LifecycleController` per session; subscribe TDD 0034's `surface.emit.failed` events to `controller.reportEmitFailure`; start the heartbeat task.
4. **Dispatcher short-circuit:** `ToolDispatcher` (existing per TDD 0006) checks `lifecycleController.current()` before each tool call; aborts the turn with `aborted-foundry-down` if non-`active`.
5. **Surface-adapter short-circuit:** Foundry-side `OutboundSurface.emit` implementations check lifecycle before calling `FoundryClient.postChatMessage`; short-circuit with a coalesced `surface.emit.skipped` telemetry event.
6. **Cached announcements:** `prepareLifecycleAnnouncements` runs at session-start; results stashed on `SessionRunState`.
7. **TDD 0040 command:** `/skeinkeeper session action:resume` parser entry + dispatch to `SessionManager.resume()`.
8. **Web console UI:** Resume button appears when SSE-bus event `lifecycleStateChanged { kind: "paused-foundry-down" }` arrives; clicking calls `POST /api/session/resume`; same path as TDD 0025's other operator controls.
9. **Discord DM operator pause notification:** new code path in the operator-self-designation module (TDD 0024) that, when the operator has DM-consent on file AND a lifecycle pause-transition event fires, sends one DM. Rate-limited (one DM per pause episode; not per emit failure within a paused session). **Consent storage:** TDD 0024's existing `operator_designation` row (Discord ID + designation timestamp) is extended additively with `dm_consented_at?: timestamp | null` (nullable; null = no consent on file; populated by the first-run setup flow per INSTALL.md updates in step 11). The field follows ADR-0010's PII handling (operator's Discord ID is already PII on this row); no new erasure path beyond the existing operator-designation erasure.
10. **Code-archaeology pass:** grep for voice-only / chat-only / degraded-narration code paths; delete if any exist (preserving turn-loop & dispatcher core untouched).
11. **PRIVACY.md, ARCHITECTURE.md, INSTALL.md updates:** the operator DM pause-notification needs a new operator-side consent (one-time opt-in at first run); documented per the docs-update-alongside-code rule.
12. **Eval / live verification** per §Verification plan.

## Failure modes & edge cases

- **Heartbeat fails but emits succeed (mixed signals).** Unusual but possible — e.g., a transient `listUsers` failure while chat still writes. Per the design, the heartbeat threshold is consecutive failures; a single heartbeat failure doesn't transition; the emit signal would also need to fire. If both succeed and fail in alternation, the session stays active (correct: `evt gone` and emits are the load-bearing signals; heartbeat is the safety net).
- **Heartbeat succeeds but emits fail consistently (also mixed).** The emit-failure threshold (≥3 in 30s) transitions; the heartbeat is a safety net, not the primary signal. Correct behavior.
- **Operator restarts Foundry but the add-on still cannot `hello-ok`.** Operator issues `resume`; pre-flight verifier runs `listUsers()`; the call fails again; verifier returns the failure as a finding; `requestResume` returns `preflight-failed`; state stays `paused-foundry-down`. Operator sees the failing finding and addresses the underlying issue.
- **Operator issues `resume` while session is already active.** `requestResume` returns `{ kind: "already-active" }`; no transition; no announcement; idempotent.
- **Two `/skeinkeeper session action:resume` commands fired near-simultaneously** (operator + their cousin both clicked). TDD 0025's SessionManager serializes writes; the first wins (transitions to active); the second sees `already-active`. No race.
- **A LLM call is in-flight when transition fires** (per §3 step 1). The LLM call completes; the resulting tool-call attempt against Foundry is skipped (dispatcher short-circuits); the dialogue store records the turn as `aborted-foundry-down`. The operator's audit log captures the abort. No half-completed Foundry-side state.
- **Skeinkeeper restart while paused.** The session state is in-memory; on restart, the session needs to be re-started by the operator (existing behavior). The audit log retains the pause + abort records; no new failure mode.
- **Voice channel is also down concurrently** (Discord outage + Foundry outage at once). The pause TTS announcement fails to deliver; logged; cached; nothing else to do. When voice returns, the operator presumably restarts.
- **Buffered voice utterances on resume — out-of-date.** If the pause lasted minutes, the buffered utterances are stale; replaying them as turns could land actions out of context. Recommendation: at resume-time, the AI is prompted to acknowledge the pause ("We paused; here's what I'm taking forward from before…") — handled in the behavior spec (this is a behavior concern, not a routing concern). The mechanical buffer-drain is per §4; the AI's framing of stale inputs is behavior-spec.
- **Operator hasn't DM-consented but is unavailable in Foundry.** Pause notification reaches only the web console; if the operator isn't watching the console either, the pause is undiscovered until they check. INSTALL.md recommends operator-DM consent at first run.
- **Auto-resume considered and rejected for v0.5.** The add-on might "come back" briefly while Foundry is still mid-restore; an auto-resume could fail mid-turn. Operator-controlled resume is the safer default; revisit if operator UX feedback asks.

## Verification plan

- **Lifecycle state machine — emit-failure threshold transition.** _Observable surface:_ `controller.current()` after a sequence of failures. _Observation point:_ unit test — start in `active`; report two emit failures (no transition); third within 30s (transition). _Expected:_ state becomes `paused-foundry-down` with `cause: "emit-failure"` after the third; transitions back to `active` only on `requestResume`.
- **Lifecycle state machine — heartbeat threshold transition.** _Observation point:_ unit test — report one heartbeat failure (no transition); second consecutive failure (transition). _Expected:_ state becomes `paused-foundry-down` with `cause: "heartbeat-failure"`.
- **Dispatcher short-circuits on non-active state.** _Observable surface:_ recorded `FoundryClient` calls + dialogue-store row's audit reason. _Observation point:_ integration test — set lifecycle to `paused-foundry-down`; run a turn that would otherwise call `postChatMessage`. _Expected:_ no `FoundryClient` calls recorded; dialogue row recorded with `aborted-foundry-down` reason; audit-log entry matches.
- **Surface adapters short-circuit emit when paused.** _Observation point:_ unit test — set state to paused; call `FoundryPublicChatSurface.emit({ audience: table, text: "x" })`. _Expected:_ no `FoundryClient` call; one `surface.emit.skipped` telemetry event; emit returns success (no-op, not failure — the surface is correctly behaving for the lifecycle state).
- **`requestResume` re-runs pre-flight verifier.** _Observation point:_ integration test — set state to paused; call `controller.requestResume()`. _Expected:_ a single call to `verifyIdentityPreflight` recorded; on `ok` the state transitions; on `critical-gaps` the resume returns `preflight-failed { findings }` and state stays paused.
- **Resume drains buffered inputs.** _Observation point:_ integration test — pause; feed three voice utterances via the always-listening loop's buffer; resume. _Expected:_ three turn-dispatches recorded post-resume, in order.
- **Discord DM operator pause notification.** _Observable surface:_ `FakeDiscordBot.dmUser` recorded calls. _Observation point:_ integration test — set operator with DM-consent on file; trigger a lifecycle transition. _Expected:_ one DM recorded to the operator's Discord ID with the pause cause; no DM if consent is absent.
- **TTS pause announcement plays exactly once per pause episode.** _Observable surface:_ TTS stream emits. _Observation point:_ integration test — trigger a pause; let two additional emit failures fire while paused; check TTS emit count. _Expected:_ exactly one TTS announce emit per pause-to-resume cycle.
- **Audit-log carries `session.paused` and `session.resumed` rows with timing.** _Observation point:_ integration test — pause; wait 100ms; resume; query the audit log. _Expected:_ two rows: `session.paused` then `session.resumed`; the resumed row's `pausedDurationMs` field is ≥100.
- **Live: pause-resume against a real Foundry.** Operator deliberately disconnects Foundry mid-session; observes pause announcement on Discord voice + pause indicator in web console + Discord DM (if consented); reconnects Foundry; clicks Resume; observes resume announcement; turn loop returns to normal. Operator-validated.

## Requirement traceability

| PRD ref            | Requirement                                                                                                                                                                                                                                                    | Satisfied by                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.8                | "If Foundry becomes unreachable, the session pauses with state preserved — there is no 'voice-only' continuation mode, because under the Surface model the player text surface lives in Foundry; the operator restarts the session when Foundry is back" | §1 lifecycle states + §3 pause behavior + §4 resume behavior; §5 deletes the prior chat-only-narration fallback; the dispatcher + surface-adapter short-circuits guarantee no Foundry-side state is mutated while paused                                                                          |
| 5.8 (graceful TTS) | "if TTS provider fails, fall back to text-only narration in Foundry chat" (the OTHER graceful-degradation path in §5.8; orthogonal to Foundry-down)                                                                                                            | Out of scope of this TDD; carried forward as-is from existing voice-IO design (TDD 0012); referenced for completeness                                                                                                                                                                             |
| 5.8 (graceful LLM) | "If primary LLM fails, surface a warning + pause"                                                                                                                                                                                                              | Out of scope of this TDD; carried forward as-is from TDD 0008's LLM-provider failure handling; referenced for completeness. The same `paused-*` lifecycle pattern COULD be extended to LLM-down in a future TDD (the LifecycleController's design admits other pause causes); not pursued at v0.5 |

## Dependencies considered

No new third-party Skeinkeeper-side dependencies. Reuses:

- `FoundryClient` (TDD 0041) — heartbeat call + `evt gone`.
- `SessionManager` (TDD 0025) — extended with `resume()` method.
- TDD 0034's surface router for the `surface.emit.failed` signal source.
- TDD 0036's pre-flight verifier for resume-side checking.
- TDD 0024's operator DM-consent mechanism (or its extension to operator-side DM consent — a small additive).

Alternatives considered:

- **Auto-resume on add-on reconnect (no operator action).** Considered. Rejected for v0.5 (see §"Failure modes"); operator-controlled is safer.
- **Continue voice-only with the prior chat-only narration design.** Rejected categorically — that's the PRD §5.8 change this TDD codifies, not an option.
- **More aggressive emit-failure threshold (e.g., 1 failure → pause).** Considered. Rejected: transient single-failure cases (add-on reload, single network blip) shouldn't trigger; the threshold of 3-in-30s catches sustained problems without flapping.
- **Persist lifecycle state across Skeinkeeper restart.** Rejected: a Skeinkeeper restart already requires operator re-start; layering another resume gate is redundant.

## PRD conflicts surfaced (and resolution)

1. **PRD §5.8's wording leaves "what pauses" ambiguous.** "The session pauses" could mean voice goes silent / no STT / no LLM calls / Discord bot leaves / some combination. **Resolution:** this TDD's §3 specifies: voice continues (Discord channel intact, STT continues, audio buffered); LLM calls stop; tool dispatches stop; Foundry-side emits stop; TTS pause announce plays once. The bot does NOT leave the voice channel — leave/rejoin would surprise the table.

2. **The pause-notification DM to the operator is a second exception to "Discord DM = consent only."** PRD-conflict #2 of TDD 0034 already named the courtesy-redirect as the first exception. The pause DM is the second. **Resolution:** §3 step 4 names it as an explicit narrow exception, gated by operator DM-consent (separate from player DM-consent); INSTALL.md captures the consent surface. If the design-PR reviewer thinks two exceptions is one too many, the alternative is web-console-only pause notification (relying on operator to be watching) — accept the discovery latency cost. Recommendation: keep the DM exception; the operator needs an out-of-band signal precisely BECAUSE their primary surface is down.

3. **The PRD doesn't say whether buffered voice utterances during a pause should be replayed as turns or discarded.** **Resolution:** §4 step 4 replays them as turns; behavior-spec adjusts the AI to acknowledge the pause-and-resume rather than rolling on as if no pause happened. Captured here as a behavior-spec follow-up.

## Decisions to promote (ADR candidates)

None new from this TDD. The decisions are:

- **Pause-on-Foundry-down (vs. voice-only fallback)** — operational consequence of [ADR-0025](../adr/0025-foundry-as-table-text-and-operator-surface.md) (Foundry as table-text + operator surface), promoted from TDD 0034's design pass; not a separate ADR.
- **Operator-controlled resume (no auto-resume)** — operational consequence of [ADR-0023](../adr/0023-operator-as-host-model.md)'s operator-as-host model; not a separate ADR.
- **The `LifecycleController` admits other pause causes** (LLM-down, voice-down) — a future design extension, not a decision this TDD makes.

## Telemetry implications

| Event                     | Payload                                                                     | Description                                                                  |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `session.paused`          | `{ cause: "addon-gone" \| "emit-failure" \| "heartbeat-failure", consecutiveFailureCount }` | Lifecycle transition to paused                                               |
| `session.resumed`         | `{ pausedDurationMs, bufferedInputs, preflightStatus }`                     | Lifecycle transition back to active                                          |
| `session.resume-failed`   | `{ pausedDurationMs, preflightCriticalCount }`                              | Operator requested resume but pre-flight verifier returned critical findings |
| `surface.emit.skipped`    | `{ surface, audienceKind, lifecycleState }`                                 | Coalesced — fires once per pause episode per surface, NOT per emit attempt   |
| `foundry.heartbeat.failed` | `{ consecutiveFailures, reason }`                                          | A heartbeat call failed; consecutiveFailures is the run length               |

All PII-free per [ADR-0010](../adr/0010-privacy-as-architecture.md).

## Privacy implications

Lifecycle data is operational, not personal. Audit-log entries (`session.paused` / `session.resumed`) carry no player content; they're operator-relevant timeline markers. The operator DM pause notification reveals operational status (pause cause) but not player content; gated by operator-specific DM-consent.

The TDD does not change the existing erasure paths (TDD 0038); pause state is per-session in-memory and not erasure-relevant.

## Eval implications

- **Unit-testable (the bulk):** state machine transitions; dispatcher + surface-adapter short-circuits; heartbeat + emit-failure threshold counters; buffered-input drain ordering.
- **`eval:live` (behavior interplay):** the AI's pause + resume narration phrasing (the cached TTS announcement generation at session-start uses the model once; behavior-spec gives it a consistent voice). One fixture confirms the AI's pause announcement is generic-and-non-spoilery; one confirms the resume announcement acknowledges the gap.
- **Operator-validated live:** end-to-end disconnect → pause → operator-action → resume cycle.

## Open questions

- **Auto-resume on add-on reconnect.** Deferred to v0.5+. Revisit if operator UX feedback asks for it; the LifecycleController's design admits a third transition path (`paused-foundry-down → active` on automatic add-on-restored / `hello-ok` detection) without restructuring.
- **Operator DM consent UX at first run.** The pause-notification DM requires a separate operator consent (vs. player consent). Recommendation: at first session-start (or operator-first-claim per TDD 0024), surface a one-time prompt: "Do you want pause notifications via Discord DM (operator-only, on Foundry/add-on disconnect)?" Y/N persists per-installation; CONTRIBUTING.md captures.
- **LLM-down case** (PRD §5.8 "If primary LLM fails, surface a warning + pause"). Could the same lifecycle machine extend to `paused-llm-down`? Yes, additively (`SessionLifecycleState`'s discriminated union extends; detectors extend; same operator-resume path). Not in scope for this TDD; tracked as a future enhancement.
- **Voice-down case.** If Discord voice disconnects, what's the lifecycle response? Currently: not pause-causing; voice-IO has its own reconnect logic; STT just stops capturing during the gap. If voice-down should also pause (parity with Foundry-down), that's a future extension — same LifecycleController design.

## Evaluation rubric

| Criterion | High-quality | Acceptable | Failing |
| --- | --- | --- | --- |
| Requirement traceability | Every in-scope FR/NFR maps to a named interface, type, or step | One mapping is slightly coarse but still findable | An in-scope FR has no row, or the row is "handled in code" |
| Interface concreteness | Method names, args, return types, and error cases are specified | Types are named; one edge payload is implied | "the module talks to Skeinkeeper" with no message or method shape |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason | No new dep, and the section says why | New dep with empty or "none considered" analysis |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named | Observable but one scenario is console-only | Non-actionable plan (no surface, no observation point) |
| Scope-bound adherence | Touched files ≤8, body ≤500, per-file estimates present | One justified exception marker | Silent over-bound or missing Touched files / Expected diff |
| Naming consistency | FoundryClient methods, gateway messages, and add-on id match across 0041, 0042, and revised drafts | One leftover "bridge" in a revised draft, clearly historical | 0041 and 0034 disagree on a method or event name |
