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
                          │     │      │       │
              ┌───────────┘     │      │       └───────────┐
              │                 │      │                   │
        ┌─────▼─────┐    ┌─────▼──┐ ┌─▼─────┐      ┌──────▼──────┐
        │ LLMProvider│    │Ruleset │ │VTTDriver│    │  VoiceIO    │
        │  (Claude,  │    │(D&D 5e)│ │(Foundry)│   │ (Discord +  │
        │   GPT, …)  │    │        │ │         │   │ Deepgram +  │
        └────────────┘    └────────┘ └─────────┘   │ ElevenLabs) │
                                                   └─────────────┘
                          │                              │
                  ┌───────▼────────┐              ┌──────▼────────┐
                  │  Local State   │              │   Players     │
                  │ (SQLite,       │              │   (Discord)   │
                  │  LanceDB,      │              └───────────────┘
                  │  audit log)    │
                  └────────────────┘
```

## Core principles

These guide most of the architectural decisions:

1. **Separate determinism from creativity.** All dice, math, and state mutations are deterministic code. The LLM narrates over the deterministic outcome. See [ADR-0003](./adr/0003-tool-call-only-state-mutation.md).

2. **State lives in the database, not in the prompt.** The LLM reads state via retrieval; never trusts its own prior outputs as source of truth. The four-tier memory model in [ADR-0002](./adr/0002-four-tier-memory-model.md) makes this concrete.

3. **Tool calls are the only way the world changes.** No free-text "the goblin takes damage and dies"; the model calls `apply_damage(goblin_03, 7)` and then narrates. [ADR-0003](./adr/0003-tool-call-only-state-mutation.md).

4. **Behavior is data, not code.** How the AI DM behaves lives in [`/behavior/default.md`](../behavior/default.md), loaded as the system prompt. Iterates separately from the engine. [ADR-0006](./adr/0006-behavior-spec-separate-doc.md).

5. **Modular boundaries are real.** Plugin interfaces (`LLMProvider`, `Ruleset`, `VTTDriver`, `VoiceIO`) keep the orchestrator vendor-independent. [ADR-0004](./adr/0004-plugin-interface-pattern.md).

6. **Audit everything.** Every state mutation, tool call, and AI decision is logged. The operator can answer "why did the AI do that?" for any session.

7. **The operator is sovereign.** Local web UI can override any state, prompt, or AI decision.

8. **Privacy is structural.** Type-marked PII, deletion paths, audit logs, voice ephemerality. See [ADR-0010](./adr/0010-privacy-as-architecture.md).

## The four-tier memory model

The LLM's "memory" across sessions is split into four tiers with different mechanisms ([ADR-0002](./adr/0002-four-tier-memory-model.md)):

| Tier | Contents | Mechanism |
|---|---|---|
| **Hot** | Current scene, last ~20 turns, active NPCs, active rules | In-prompt, sliding window |
| **Warm** | HP, slots, inventory, conditions, location, quest flags, faction reputation | SQLite, mutated only via tool calls |
| **Cold** | Campaign content, SRD rules, monster stat blocks | LanceDB vector store, retrieved per turn |
| **Episodic** | Per-session summaries, key beats, NPC deltas | Generated post-session; consolidated over time |

The classic mistake is stuffing everything into the context window. This four-tier split keeps prompts small, costs predictable, and state authoritative.

## Tenant scoping

Every persistent record carries a `tenant_id`. The default tenant for a fresh install is `"default"`; operators running multiple isolated campaign groups create additional tenants. The query layer enforces scoping — queries without `tenant_id` don't compile. See [ADR-0008](./adr/0008-tenant-scoping.md).

## Plugin interfaces

Four pluggable surfaces, each with a stable interface and one default implementation:

| Interface | Default | Purpose |
|---|---|---|
| `LLMProvider` | `AnthropicProvider` | Generate narration and tool calls |
| `Ruleset` | `DnD5eRuleset` | Skills, dice mechanics, character schema, encounter scaling |
| `VTTDriver` | `FoundryDriver` (via Foundry MCP) | Operate the visual tabletop |
| `VoiceIO` | `DiscordVoiceIO` | Bridge to players |

See [ADR-0001](./adr/0001-use-foundry-mcp-for-vtt.md) for the Foundry choice, [ADR-0004](./adr/0004-plugin-interface-pattern.md) for the interface pattern.

## How a turn works

A simplified flow:

1. **Player speaks** in Discord voice channel.
2. **VoiceIO** transcribes via STT, attributes to player by Discord user ID.
3. **Orchestrator** assembles hot context: warm state snapshot + retrieved cold knowledge + dialogue window + behavior spec.
4. **LLM call** with tools available (`roll`, `apply_damage`, `set_quest_flag`, `whisper`, etc.).
5. **Tool calls dispatched** to deterministic code. Each one mutates state, writes audit log, and returns results to the model.
6. **Model narrates** over the deterministic outcome.
7. **VoiceIO** streams TTS back to Discord. **VTTDriver** mirrors relevant changes to Foundry.

Every step is logged; the operator can replay any session from the audit log.

## Privacy and data handling

Skeinkeeper is software the operator runs on their own infrastructure. Architectural commitments are in [ADR-0010](./adr/0010-privacy-as-architecture.md); the user-facing explanation is in [`PRIVACY.md`](./PRIVACY.md).

Key points:
- No phone-home by default ([ADR-0009](./adr/0009-telemetry-opt-in.md))
- Voice audio is strictly ephemeral (transcribed, never stored)
- Every persistent store has a documented deletion path
- All secrets encrypted at rest

## Where to go next

- **For contributors:** [`/CONTRIBUTING.md`](../CONTRIBUTING.md) for the dev workflow
- **For deep architectural rationale:** [`/docs/adr/`](./adr/) for the full decision records
- **For understanding the AI DM's behavior:** [`/behavior/default.md`](../behavior/default.md)
- **For privacy questions:** [`/docs/PRIVACY.md`](./PRIVACY.md)
