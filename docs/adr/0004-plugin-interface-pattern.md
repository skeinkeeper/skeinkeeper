# ADR-0004: Plugin Interfaces for LLM / Ruleset / VTT / Voice

## Status
Proposed (2026-05-17)

## Context

The platform must be modular: the operator should be able to swap LLM providers (Claude → GPT → Grok → Gemini), rule systems (D&D 5e → Pathfinder 2e → Call of Cthulhu), VTTs (Foundry → Owlbear → Roll20), and voice stacks (Deepgram+ElevenLabs → Whisper+OpenAI TTS) without rewriting the orchestrator.

The AI DM space is moving fast. Locking the architecture to any single LLM, ruleset, or VTT would force a major rewrite within months. We need the seams in place from day one.

## Decision

**We define four plugin interfaces, each with a single canonical implementation in v1.** All orchestrator-level code talks only to the interfaces.

```
┌──────────────────────────────────────────────────────┐
│                    Orchestrator                      │
│  (state, memory, tool dispatch, prompts, behavior)   │
└──────────────────────────────────────────────────────┘
       │            │            │            │
       ▼            ▼            ▼            ▼
  ┌────────┐  ┌─────────┐  ┌────────┐  ┌──────────┐
  │ LLM    │  │ Ruleset │  │  VTT   │  │ Voice    │
  │Provider│  │         │  │ Driver │  │ I/O      │
  └────────┘  └─────────┘  └────────┘  └──────────┘
```

The four interfaces:

- **`LLMProvider`** — `complete(messages, tools, stream) → response`. Anthropic Messages API shape used as the lowest-common-denominator. Implementations: `AnthropicProvider` (v1), `OpenAIProvider`, `GrokProvider`, `GeminiProvider`.
- **`Ruleset`** — declares: skills, ability scores, dice mechanics, character schema, condition types, encounter scaling, tool set. Rules-as-data where possible; rules-as-code only where data is insufficient. Implementations: `DnD5eRuleset` (v1), `Pathfinder2eRuleset`, `CallOfCthulhuRuleset`.
- **`VTTDriver`** — `set_scene`, `move_token`, `roll_dice`, `apply_damage`, `set_condition`, `whisper`, etc. Implementations: `FoundryDriver` (v1, over Foundry MCP per [ADR-0001](./0001-use-foundry-mcp-for-vtt.md)), `OwlbearDriver`, `Roll20Driver`.
- **`VoiceIO`** — `listen() → stream<utterance{speaker, text}>`, `speak(text, voice_id) → stream<audio>`. Combines transport (Discord) with STT and TTS providers, each independently swappable internally. Implementations: `DiscordVoiceIO` (v1) wrapping `DeepgramSTT` + `ElevenLabsTTS`.

Plugins are loaded at startup based on operator configuration. No conditional logic in the orchestrator branches on plugin identity; if it would, the abstraction is wrong and the interface needs to grow.

## Consequences

**Positive**
- Adding a new LLM provider, ruleset, or VTT becomes a contained PR: one new module that implements the interface, plus tests against a standard conformance suite.
- The OSS contribution surface is well-defined and discoverable. "Want to add Pathfinder 2e? Implement the `Ruleset` interface and submit."
- We can run multi-implementation evals (does Phandelver play better under Claude or GPT?) without forking code paths.
- Single implementations in v1 means we don't pay full abstraction tax until we have a second implementation to validate against.

**Negative**
- The "rule of three" risk: we're designing interfaces with only one implementation in mind. The first time a second implementation needs something the interface doesn't expose, the interface has to change.
- Discipline cost: every new feature gets asked "where does this go — orchestrator, interface, or implementation?" That's a tax even when the answer is obvious.
- We will get this wrong somewhere. Interfaces will need breaking changes before v1.0 — that's why plugin API stability is promised only from v1.0 forward.

**Neutral**
- Interfaces live in `/orchestrator/interfaces/{name}.ts`. Implementations live in `/plugins/{kind}-{name}/`.
- Each plugin ships its own tests. CI runs the conformance suite against each.
- A reference "fake" implementation per interface (`FakeLLMProvider`, etc.) supports orchestrator-only testing without external dependencies.

## What this ADR does NOT decide
- The exact method signatures of each interface (those live in the code; this ADR is the architectural commitment).
- Which second implementation to build first (deferred to v2 planning).
- Whether plugins can be loaded dynamically vs. compiled in (start with compile-time; revisit if it becomes a contributor pain point).
