# TDD 0017: DM + NPC Voice Assignment
Status: implemented
PRD refs: 4.1
PRD-rev: 10391ba
ADR constraints: 0004, 0010
Author: maintainers
Date: 2026-05-19
Related TDDs: [0008 (LLM provider interface)](./0008-llm-provider-interface.md), [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0012 (voice IO)](./0012-voice-io.md), [0015 (always-listening loop)](./0015-always-listening-voice-loop.md)

## Approach

The AI DM speaks: as itself (the narrator/DM voice) and as NPCs. Design doc 0012 reserved a `resolveVoiceId(turn)` hook and a `voiceId` field but left two questions open: how the DM's voice is chosen, and how each NPC gets a distinct, consistent voice. The guiding principle from the design discussion: **the operator should configure as little as possible, and should never have to know we use ElevenLabs.**

### DM voice: operator picks a curated persona; ElevenLabs is hidden

Skeinkeeper ships a small **curated set of DM voice personas** — e.g., "Warm Storyteller," "Gravelly Veteran," "Theatrical Showman," "Measured Sage" — each a human-meaningful name with a one-line description and a preview sample. Each persona maps *internally* to a specific ElevenLabs voice ID (plus default stability/style settings). The operator picks a persona in the Skeinkeeper UI; they never see a voice ID or the word "ElevenLabs."

The default persona pairs with the behavior spec's default "Generous Collaborator" preset (§1.1) — a warm, present storyteller. Stored per-campaign so different campaigns can have different DM voices.

This is the only voice setting the operator must touch.

### NPC voices: AI-assigned from the available library, operator override

NPCs get voices **chosen by the AI**, not the operator. When an NPC first needs to speak (or during prep once the cast is known), the AI:

1. Reads the **available voice library** — the operator's ElevenLabs voices + the shared library — via the voices API (the `voices:read` scope we provisioned), each with a name + description (gender, age, accent, timbre).
2. Picks the best match for the NPC's character: a model call given the NPC's description (from Foundry / the behavior of the scene) + the available voice descriptions → a `providerVoiceId`. A gruff dwarf smith gets a deep gravelly voice; a nervous shopkeeper a thin reedy one.
3. **Persists** the NPC→voice assignment so the NPC sounds the same in session 7 as in session 2.

The operator can override any NPC's voice in the web UI (again shown as descriptions/previews, not raw IDs).

### Voice library access + caching

A `VoiceLibrary` abstraction queries the TTS provider for available voices and caches their descriptions (the list changes rarely). This is the only place the ElevenLabs voices API is touched; the rest of the system deals in persona IDs and assignment rows.

### How it's consumed (the TTS path)

The AI's narration carries inline voice markers per a behavior-spec convention — e.g., `[NPC:sildar] "We have to flee."` vs. plain narration (DM voice). On the TTS path:

1. The narration is split into segments by marker.
2. Each segment resolves to a `providerVoiceId`: DM segments → the campaign's DM persona; `[NPC:x]` segments → the persisted NPC assignment (assigning one on first encounter if absent).
3. Each segment is synthesized with its voice and played in order.

This is what the `resolveVoiceId` hook (doc 0012) and the eventual segment-splitting parser implement. The marker convention is a behavior-spec addition that lands with the implementation.

## Components & interfaces

```ts
interface VoicePersona {
  id: string;            // "warm-storyteller"
  label: string;         // "Warm Storyteller"
  description: string;   // "Inviting, unhurried, leans into wonder."
  // internal — never surfaced to the operator:
  providerVoiceId: string;
  providerSettings?: Record<string, unknown>;
}
```

A `TenantDb.voiceAssignments` accessor (upsert / get / listByCampaign). Not PII (NPC names + voice IDs + a persona choice) — no erasure adapter needed, though it cascades on campaign deletion via FK like other campaign-scoped tables.

## Data & state

### Storage

```ts
voice_assignment: {
  id, tenantId, campaignId,
  subjectKind,     // "dm" | "npc"
  subjectKey,      // "dm" for the DM; the NPC name/id for NPCs
  providerVoiceId,
  personaId,       // set for the DM (which curated persona); null for NPCs
  source,          // "operator" | "ai"
  assignedAt,
}
```

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.1 | Per-NPC voice profiles — each named NPC has a persistent voice identity, configured in the local web UI | `voice_assignment` table persists NPC→`providerVoiceId`; AI assigns on first encounter; operator overrides via web UI (shown as descriptions/previews) |
| 4.1 | TTS streamed to Discord voice channel | narration split by `[NPC:x]` marker; each segment resolved to `providerVoiceId` and synthesized in order; `resolveVoiceId` hook in doc 0012 |
| 4.1 | TTS providers pluggable via internal interface | `VoiceLibrary` abstraction is the sole ElevenLabs touch-point; operator never sees provider internals; provider-swap blast radius contained to this abstraction |

## Dependencies considered

None — no new third-party dependency introduced by this design. ElevenLabs is already the committed TTS provider (CLAUDE.md / ADR-0004 plugin interface); this doc designs the abstraction layer over it, not a new dependency.

## PRD conflicts surfaced (and resolution)

None — the design directly implements the per-NPC-voice and pluggable-TTS requirements from PRD §4.1; no requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — no cross-cutting durable decisions here beyond ADR-0004 (plugin interface hiding provider details) which already governs this pattern.

## Alternatives considered

- **Operator assigns every NPC voice.** Tedious — a campaign has dozens of NPCs. The AI is well-suited to match a voice to a character description; the operator overrides the few that matter. Rejected as the primary path; kept as override.
- **Expose ElevenLabs voice IDs directly to the operator.** Violates the "operator never learns the provider" principle and leaks a swappable implementation detail (we could change TTS providers per ADR-0004). The persona abstraction hides it.
- **One voice for everything (DM + all NPCs).** Cheapest, worst experience — every character sounds like the same person doing impressions. Rejected.
- **Random voice per NPC.** No consistency across sessions and no fit to character. Rejected; persisted AI assignment gives both.
- **Generate NPC voices with the LLM's own audio output.** Per the earlier multimodal discussion (doc 0010 context), current LLMs don't offer consistent per-character voice cloning; purpose-built TTS with a voice library is the better fit. Rejected.

## Telemetry implications

Optionally `voice.npc_assigned { source }` to see how often operators override AI assignments. No PII. Defer until live.

## Privacy implications

None of the voice data is PII: persona choices, NPC names, and voice IDs. The ElevenLabs voices API is queried with the operator's own key. NPC names could be campaign-content-sensitive (commercial module content) but that's an ADR-0007 content concern, not a privacy one, and the names live in the operator's data regardless. No new consent, no erasure adapter required (campaign-scoped FK cascade suffices).

## Eval implications

The AI's NPC→voice matching is unit-testable: given an NPC description + a fixed library of voice descriptions, assert the AI picks a sensible voice (e.g., a "gruff dwarf" maps to a low/gravelly voice, not a high/youthful one) via a `FakeLLMProvider`-scripted assignment. The narration-marker parser (splitting `[NPC:x]` segments) is a pure function with its own tests. The *subjective quality* of a voice fit is a human judgment, not an automated fixture.

## Open questions

- **Voice library size + cost.** Querying + previewing many voices has API cost; cache aggressively. How many personas to curate for the DM picker — 4? 8?
- **Custom/cloned voices.** Some operators may want to clone a specific voice for a signature NPC. Out of scope for alpha; the assignment table can hold any `providerVoiceId`, so it's forward-compatible.
- **Per-NPC emotional/style modulation.** ElevenLabs supports per-generation style/stability. Should an NPC marker carry a mood (`[NPC:sildar mood:fearful]`)? A behavior-spec + parser extension; deferred.
- **Marker reliability.** The AI must reliably emit `[NPC:x]` markers for this to work; that's a behavior-spec discipline question, tuned with eval fixtures.
- **Provider-swap.** If TTS moves off ElevenLabs (ADR-0004 allows it), personas remap to the new provider's voices and NPC assignments need re-resolution. The persona abstraction contains the blast radius to the `VoiceLibrary` + persona table.
