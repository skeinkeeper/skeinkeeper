# Architecture

This document gives a high-level overview of how Skeinkeeper fits together. For deeper rationale on specific decisions, see the [Architecture Decision Records](./adr/).

## The big picture

Skeinkeeper is a single-process application that an operator runs on one machine. It orchestrates:

1. **Discord** — voice and text I/O for players
2. **Foundry VTT** — the visual layer (maps, tokens, combat tracker)
3. **An LLM provider** — generates narration, NPC dialogue, and tool-call decisions
4. **Voice providers** — STT (incoming player voice → text) and TTS (outgoing AI narration → audio)
5. **Local persistence** — campaign state, episodic memory, audit log

```
                       ┌──────────────────────────────────┐
                       │         Orchestrator             │
                       │  (memory, state, tool dispatch,  │
                       │   prompt assembly, audit log)    │
                       └──────────────────────────────────┘
                              │            │            │
                  ┌───────────┘            │            └───────────┐
                  │                        │                        │
            ┌─────▼──────┐           ┌─────▼─────┐            ┌─────▼──────┐
            │ LLMProvider│           │FoundryClient│          │  VoiceIO   │
            │  (Claude,  │           │ (Foundry  │            │ (Discord + │
            │   GPT, …)  │           │  via OSS  │            │ Deepgram + │
            │            │           │   MCP)    │            │ElevenLabs) │
            └────────────┘           └─────┬─────┘            └─────┬──────┘
                                           │                        │
                                  ┌────────▼──────────┐      ┌──────▼──────┐
                                  │   Foundry VTT     │      │   Players   │
                                  │  (authoritative   │      │  (Discord)  │
                                  │  mechanical state │      └─────────────┘
                                  │  per ADR-0011 +   │
                                  │  TDD 0007)        │
                                  └───────────────────┘
              │
      ┌───────▼────────┐
      │  Local State   │
      │ (SQLite +      │   AI-DM-side state only — campaign metadata,
      │  LanceDB +     │   sessions, audit log, consents, quest flags,
      │  audit log)    │   intake findings (TDD 0031), cold + episodic memory (LanceDB, TDD 0019)
      └────────────────┘
```

## Core principles

These guide most of the architectural decisions:

1. **Separate determinism from creativity.** All dice, math, and state mutations are deterministic code. The LLM narrates over the deterministic outcome. See [ADR-0003](./adr/0003-tool-call-only-state-mutation.md).

2. **State lives in the database, not in the prompt.** The LLM reads state via retrieval; never trusts its own prior outputs as source of truth. The four-tier memory model in [ADR-0002](./adr/0002-four-tier-memory-model.md) makes this concrete.

3. **Tool calls are the only way the world changes.** No free-text "the goblin takes damage and dies"; the model calls `apply_damage(goblin_03, 7)` and then narrates. [ADR-0003](./adr/0003-tool-call-only-state-mutation.md).

4. **Behavior is data, not code.** How the AI DM behaves lives in [`/behavior/default.md`](../behavior/default.md), loaded as the system prompt. Iterates separately from the engine. [ADR-0006](./adr/0006-behavior-spec-separate-doc.md).

5. **Modular boundaries are real.** Plugin interfaces (`LLMProvider`, `FoundryClient`, `VoiceIO`) keep the orchestrator vendor-independent. [ADR-0004](./adr/0004-plugin-interface-pattern.md), with the `Ruleset` interface dropped per [ADR-0012](./adr/0012-drop-ruleset-plugin-interface.md) — Foundry's per-system data models replace it.

6. **Audit everything.** Every state mutation, tool call, and AI decision is logged. The operator can answer "why did the AI do that?" for any session.

7. **The operator is sovereign.** Local web UI can override any state, prompt, or AI decision.

8. **Privacy is structural.** Type-marked PII, deletion paths, audit logs, voice ephemerality. See [ADR-0010](./adr/0010-privacy-as-architecture.md).

## The four-tier memory model

The LLM's "memory" across sessions is split into four tiers with different mechanisms ([ADR-0002](./adr/0002-four-tier-memory-model.md), revised by [ADR-0013](./adr/0013-warm-tier-after-foundry-source-of-truth.md)):

| Tier         | Contents                                                                                                                                                                                                    | Mechanism                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hot**      | Current scene, last ~20 turns, party, active NPCs, active rules                                                                                                                                             | In-prompt, sliding window                                                                                                                       |
| **Warm**     | _From Foundry:_ character sheets, NPCs on scene, active scene — whatever the active Foundry system module exposes. _From Skeinkeeper SQLite:_ campaign metadata, sessions, audit log, consents, quest flags | Per-turn read from `FoundryClient` + `TenantDb`; mutations always via typed tool calls                                                          |
| **Cold**     | Campaign content, SRD rules, monster stat blocks                                                                                                                                                            | LanceDB vector store, retrieved per turn (TDD 0019; on-box embeddings by default)                                                               |
| **Episodic** | Per-session summaries, key beats, NPC deltas                                                                                                                                                                | Generated post-session; embedded + retrieved; campaign-scoped shared memory ([ADR-0014](./adr/0014-episodic-memory-campaign-scoped-erasure.md)) |

The classic mistake is stuffing everything into the context window. This four-tier split keeps prompts small, costs predictable, and state authoritative.

## Tenant scoping

Every persistent record carries a `tenant_id`. The default tenant for a fresh install is `"default"`; operators running multiple isolated campaign groups create additional tenants. The query layer enforces scoping — queries without `tenant_id` don't compile. See [ADR-0008](./adr/0008-tenant-scoping.md).

## Plugin interfaces

Three pluggable surfaces, each with a stable interface and one default implementation:

| Interface       | Default                                                         | Purpose                                                         |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `LLMProvider`   | `AnthropicProvider`                                             | Generate narration and tool calls                               |
| `FoundryClient` | `McpFoundryClient` (via the OSS Foundry MCP bridge of ADR-0011) | Operate the visual tabletop; authoritative for mechanical state |
| `VoiceIO`       | `DiscordVoiceIO`                                                | Bridge to players (STT + TTS + Discord transport)               |

A `Ruleset` interface was originally planned in [ADR-0004](./adr/0004-plugin-interface-pattern.md) but dropped per [ADR-0012](./adr/0012-drop-ruleset-plugin-interface.md). Foundry's per-system data models (`actor.system`) already provide that abstraction; per-system formatting lives in `orchestrator/src/foundry/render.ts`. Per-system mutation tools are planned to be registered by the Foundry plugin at session start, but are not yet wired (see "How a turn works" below and the mutation gap in [TDD 0014](./tdd/0014-mcp-foundry-client.md)). See [TDD 0007](./tdd/0007-foundry-as-source-of-truth.md).

See [ADR-0011](./adr/0011-prefer-oss-foundry-mcp-bridges.md) for the Foundry MCP bridge choice (supersedes [ADR-0001](./adr/0001-use-foundry-mcp-for-vtt.md)) and [ADR-0004](./adr/0004-plugin-interface-pattern.md) for the interface pattern.

## Session intake

On Start the orchestrator runs a deterministic **minimum intake** pass (TDD 0031) against `FoundryClient` + warm state: identify the Foundry system, enumerate party-actor candidates, and classify critical gaps. Unresolved criticals block the onboarding "I'm ready" announcement. **Extended intake** (modules, scenes, packs, ownership, recommendations) is kicked off in parallel with onboarding and does not block the first turn. Findings are delivered as one structured `notify_operator` message (Critical / I need a decision / For your info). The operator resolves them on the web console via `SessionManager.resolveIntakeFinding` (Foundry chat-command parity lands in TDD 0040).

After extended intake, **autonomous pre-game setup** (TDD 0032) runs without blocking onboarding: activate an unambiguous starting scene, incrementally index world journals/scenes/creatures/actor-items into the cold tier (`coldIndexReady` flips when that finishes), and pre-load party-required compendium actors into the world without placing tokens. Ownership writes are operator-side (TDD 0036). Silence is success — the intake report's "I did the following" footer is the after-the-fact note.

**Live perception** (TDD 0033) is a push `FoundryEventStream` subscribed at session start (events queue until the session is ready). Production v0.5 wires a no-op stream; `MockFoundryEventStream` covers tests. Triggered in-play actions (hidden tokens, journal share, loot) are typed tools over `FoundryClient` — policy for when to fire them lives in the behavior spec.

## How a turn works

A simplified flow:

1. **Player speaks** in Discord voice channel.
2. **VoiceIO** transcribes via STT, attributes to player by Discord user ID.
3. **Orchestrator** assembles hot context: warm-state snapshot (Foundry read + Skeinkeeper SQLite read) + retrieved cold knowledge + dialogue window + behavior spec.
4. **LLM call** with tools available. Core tools (system-agnostic): `roll`, `set_quest_flag`, `move_party`, `advance_time`, `whisper`, `fudge_roll`, `record_player_character` (session-start identity mapping), `notify_operator` (private operator notes — including the session-intake report), plus TDD 0033 triggered actions `reveal_token`, `hide_token`, `place_hidden_token`, `share_journal_to_audience`, `distribute_loot`. System-specific _mutation_ tools (apply-damage, heal, set-condition, …) are **planned, not yet registered** — the current OSS bridge can't do a direct HP-set or a server-side roll, so those routes throw today; see the "mutation gap" in [TDD 0014](./tdd/0014-mcp-foundry-client.md).
5. **Tool calls dispatched** to deterministic code. Skeinkeeper-owned tools mutate the local SQLite; Foundry-routed tools translate to MCP calls (reads + scene activation today; broader mutation as the bridge gains it). Either way, the dispatcher writes an audit-log row and returns results to the model.
6. **Model narrates** over the deterministic outcome.
7. **VoiceIO** streams TTS back to Discord. Foundry's chat log reflects any actor/scene changes that routed through MCP.

Every step is logged; the operator can replay any session from the audit log.

## Privacy and data handling

Skeinkeeper is software the operator runs on their own infrastructure. Architectural commitments are in [ADR-0010](./adr/0010-privacy-as-architecture.md); the user-facing explanation is in [`PRIVACY.md`](./PRIVACY.md).

Key points:

- No phone-home by default ([ADR-0009](./adr/0009-telemetry-opt-in.md))
- Voice audio is strictly ephemeral (transcribed, never stored)
- Every persistent store has a documented deletion path
- All secrets encrypted at rest; PII columns encrypted at rest per column when a passphrase is set, with deletion/audit kept key-free via salted-hash companions ([ADR-0022](./adr/0022-pii-encryption-node-crypto.md))

## Where to go next

- **For contributors:** [`/CONTRIBUTING.md`](../CONTRIBUTING.md) for the dev workflow
- **For deep architectural rationale:** [`/docs/adr/`](./adr/) for the full decision records
- **For understanding the AI DM's behavior:** [`/behavior/default.md`](../behavior/default.md)
- **For privacy questions:** [`/docs/PRIVACY.md`](./PRIVACY.md)
