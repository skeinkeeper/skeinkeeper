# Skeinkeeper — Open-Source AI Dungeon Master

**Product Requirements Document**
**Status:** Draft · 2026-05-24

> **Skeinkeeper** — keeper of the threads of fate. An open-source, self-hosted AI Dungeon Master that runs tabletop RPG campaigns for your friend group over Discord and Foundry VTT.
>
> _Wyrd bið ful aræd._ — Old English (The Wanderer, l. 5b): "Fate remains wholly inexorable." The dice, once cast, are fixed.

---

## 1. Vision & Context

Skeinkeeper is a free, open-source tool that lets a friend group play tabletop RPGs together with an AI Dungeon Master. The DM speaks aloud over Discord voice in distinct character voices, autonomously operates Foundry VTT (maps, tokens, combat, dice), and maintains persistent campaign state across sessions.

The target user is **a technically comfortable DM-or-DM-curious friend who can run `docker compose up`** and wants to play scheduling-flexible D&D with their group. Two players in-person + two remote over Discord voice is the canonical configuration. The tool removes the prep burden and scheduling friction that kills most casual campaigns.

**Why open source:** the other AI-DM tools (Friends & Fables, AIDungeonMaster.ai, RoleForge, Voyage, MacerAI, and a dozen smaller products) are closed-source and run on the vendor's servers — you play under their model choices, with your campaign data in their database. Skeinkeeper occupies the niche none of them fills: the technically inclined group that wants to own its data, bring its own LLM and voice API keys, get the voice + Foundry combination none of the others offer, and run the whole thing on its own infrastructure.

## 2. Goals & Non-Goals

### Goals

- Deliver a fluent AI DM experience for a 4-person hybrid table running D&D 5e (Lost Mine of Phandelver as the reference campaign).
- Voice-first interaction over Discord with distinct NPC voices.
- Autonomous Foundry VTT operation — maps, tokens, combat tracker, dice, fog of war, all driven by the AI.
- Persistent state and memory across sessions.
- Pluggable internally: LLM provider, VTT, and voice stack are swappable behind stable interfaces.
- Operator runs everything locally: `docker compose up`, then access a local web UI on `localhost`.
- Apache 2.0 licensed; community contributions welcomed.

### Non-Goals (for v1)

- Replacing human DMs for groups that already have one.
- Tables larger than ~6 players in a single session.
- Native mobile clients (the Discord client provides mobile play; the web UI is desktop-first).
- Shipping or validating rulesets other than D&D 5e at MVP. The architecture is system-portable — per-system mechanics come from Foundry's system modules, not from Skeinkeeper (see [ADR-0012](adr/0012-drop-ruleset-plugin-interface.md)) — but 5e (Lost Mine of Phandelver) is the only validated target at alpha. Other systems become reachable as their Foundry module plus a small renderer exist.
- Marketplace for user-generated campaigns.
- Built-in livestreaming, recording, or content moderation.

## 3. Users & Personas

- **The Operator** — the person who installs and runs Skeinkeeper. Technical comfort: medium-to-high. Comfortable with Docker, command line, environment variables, and configuring API keys for LLM/voice providers. Typically also the DM-equivalent for their friend group; they configure the campaign, invite friends, run sessions. One operator per Skeinkeeper instance.
- **The Players** — the operator's friends. Interact only with Discord (voice + text) and Foundry (visual layer). Never touch the configuration UI. Don't need accounts; they're known to the system by Discord ID.
- **The AI DM** — a system actor. Has authority to mutate campaign state via tool calls, narrate, voice NPCs, and operate the VTT.

## 4. Functional Requirements

### 4.1 Voice & Discord Integration

**Bot model:** the operator runs the Skeinkeeper Discord bot under their own bot token, registered in their own Discord developer account. The bot joins the operator's Discord server with the operator's invited permissions.

**Inbound (players → AI):**

- Bot joins a designated Discord voice channel.
- Real-time speech-to-text per speaker with diarization (AI knows which player said what).
- **Configurable activation mode** per campaign:
  - **Wake-word** (default): players prefix utterances with a configured term ("DM", "Storyteller", or any operator-set string + aliases). STT-output prefix match with fuzzy tolerance.
  - **Always-on with VAD** — every utterance treated as directed to the AI unless flagged OOC.
  - **Push-to-talk** — Discord PTT bounds when the AI listens.
- Text input via a parallel Discord text channel always supported.
- IC vs OOC disambiguation via convention (`!ooc` slash, `((parentheticals))`, or wake-phrase "DM, OOC:").

**Outbound (AI → players):**

- TTS streamed to the same Discord voice channel.
- **Per-NPC voice profiles** — each named NPC has a persistent voice identity, configured in the local web UI.
- Mirrored text transcript in Discord text channel and in the operator's web UI.
- **Whisper** — AI can DM a single player privately (Discord DM + Foundry whisper) for secret information.

**TTS/STT providers (pluggable via internal interface):**

- TTS: ElevenLabs (recommended), OpenAI TTS, Azure Neural TTS, Cartesia. Operator brings their own API key.
- STT: Deepgram (recommended, best diarization), OpenAI Whisper API, AssemblyAI, local Whisper. Operator brings their own API key (or runs local Whisper).
- Provider selection is per-campaign in the operator's web UI.

### 4.2 Foundry VTT Integration

The operator runs their own Foundry instance. Skeinkeeper connects to it through a self-hosted, open-source Foundry MCP bridge (see [ADR-0001](adr/0001-use-foundry-mcp-for-vtt.md), superseded by [ADR-0011](adr/0011-prefer-oss-foundry-mcp-bridges.md)), which exposes the command surface we need: scenes, tokens, actors, items, combat, dice, chat, and journals.

**Functional surface:**

- Scene activation, fog of war, lighting from pre-built templates.
- Token creation, placement, movement, disposition (friendly/neutral/hostile).
- Combat tracker management: initiative, turn order, conditions, death saves.
- Server-side dice rolling so all rolls appear in the chat log and are auditable.
- Compendium access (D&D 5e default).
- Chat, journal entries, whispers.
- Read-write access to actor sheets (HP, conditions, spell slots, inventory).

### 4.3 AI DM Engine Capabilities

> Note: This section describes platform capabilities only. Behavior — when and how the AI DM uses these capabilities — is defined in the [behavior spec](../behavior/default.md).

**Roll capabilities**

- **Open rolls** visible in chat; player-initiated rolls default to open.
- **Secret rolls** computed and logged, narrative outcome surfaced only.
- **Passive check resolution** — lookup-and-compare against character passive scores; no LLM call.
- **Fudge tool** — `fudge_roll(original, new, reason)`; audit-logged; operator can disable per campaign.
- **Open-roll lock** — `open=true` rolls cannot be fudged at engine level (player rolls, death saves, final-blow rolls).

**Action capabilities**

- **Player-character mutation guard** — AI cannot mutate player sheets beyond declared-damage HP without confirmation.
- **NPC voice mapping** — persistent voice identity per NPC, configurable in web UI.
- **Whisper** — targeted private message.

**Session capabilities**

- **Recap generation** — structured + prose summary suitable for reading aloud at session start.
- **End-of-session signal** — operator flags "wrap by N min"; AI adjusts pacing toward cliffhanger.
- **Engagement tracking** — per-player turn count and lines spoken, surfaced as context and to the operator's live session view.

**Safety capabilities**

- **Pause / X-card** — `!pause` (text) or "DM, pause" (voice) interrupts AI generation immediately.
- **Lines & Veils** — operator-defined per-campaign content limits, enforced via system prompt + output classifier.
- **Hard safety limits** — non-negotiable, code-level: no sexual content involving minors, no real-world harm instructions through fictional framing. Enforced via content classifier on every AI utterance.

**Operator override**

- Pause, edit any state, rewrite the last AI turn, take the wheel and DM manually — all via the web UI's "live session view."

### 4.4 Local Web UI for Configuration

A web application served from the local Skeinkeeper process on `localhost:3000` (default port; configurable). Single-user (the operator); authentication is a local password set on first run plus optional WebAuthn passkey. There are no remote accounts.

**Capabilities:**

- **Connection config:** Discord bot token, Foundry URL + API key, LLM provider + model + key, TTS provider + key, STT provider + key. Stored encrypted using OS keyring (libsecret on Linux, Keychain on macOS, Credential Manager on Windows) with a libsodium-sealed config file fallback.
- **Campaign management:** create / archive campaigns. Upload supplemental content (notes, custom NPCs, maps). Choose ruleset (D&D 5e default; other rulesets if the matching Foundry system is installed). Choose AI personality preset. Configure Lines & Veils, custom rules, fudging policy.
- **Party management:** view/edit character sheets, HP, inventory, status. Sync to/from Foundry. Per-player Discord identity and voice mapping.
- **State inspection:** browse warm state (quest flags, NPC relationships, location, faction reputation). Edit any field; changes recorded in audit log.
- **Session management:** list past sessions with auto-generated summaries; full transcript searchable. "Live session view" during active sessions — streaming transcript, current scene, pending AI tool call, pause button.
- **Memory inspection:** view embedded chunks, retrieval logs, hot context for the most recent turn. For operators who want to understand why the AI said what it said.
- **Voice mapping:** assign TTS voice IDs to named NPCs; preview clips.

### 4.5 Local Authentication & Secrets

- **First-run setup:** operator sets a local password. Optionally registers a WebAuthn passkey for unlock.
- **Session management:** standard browser cookie session, scoped to localhost.
- **Secret storage:** all API keys and tokens encrypted at rest using the OS keyring; fallback to libsodium-sealed config file if keyring is unavailable.
- **No remote auth, no SSO, no OAuth.** The operator is the only user.

### 4.6 Player Onboarding

Players don't need Skeinkeeper accounts. The operator:

1. Adds players to the campaign by Discord ID via the web UI.
2. Sends them a brief in-Discord onboarding from the bot (consent to voice processing, campaign overview, character creation if needed).
3. They show up to play.

Player-facing surfaces are Discord (voice + text) and Foundry (visual). They never see the web UI.

## 5. Non-Functional Requirements

### 5.1 Memory Architecture

Four-tier model (see [ADR-0002](adr/0002-four-tier-memory-model.md); warm-tier contents revised by [ADR-0013](adr/0013-warm-tier-after-foundry-source-of-truth.md) once Foundry became the source of truth for mechanical state):

| Tier     | Contents                                                                                                                                                                                                                                  | Mechanism                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Hot      | Current scene, last ~20 turns, active NPCs, active rules subset                                                                                                                                                                           | In-prompt, sliding window                                                                   |
| Warm     | **Foundry-owned:** party & NPC actor sheets (HP, conditions, inventory, per-system stats), active scene, combat tracker. **Skeinkeeper-owned:** campaign metadata, sessions, quest flags (AI-DM-internal plot state), audit log, consents | Foundry read via `FoundryClient`/MCP + Skeinkeeper SQLite; both mutated via tool calls only |
| Cold     | Campaign content, SRD rules, monster stat blocks                                                                                                                                                                                          | Vector store (LanceDB), chunked + embedded                                                  |
| Episodic | Per-session summaries, key beats, NPC deltas, party choices                                                                                                                                                                               | Generated post-session; consolidated periodically                                           |

**Tenant scoping in the data model.** Every persistent record carries a `tenant_id`, and every read and write goes through a tenant-aware query layer that refuses tenant-less queries — cross-tenant access doesn't compile. A fresh install uses a single tenant (`"default"`); an operator who runs more than one campaign group in the same instance (say, a D&D group and a Pathfinder group) gets hard isolation between them, plus scoped backup and restore. See [ADR-0008](adr/0008-tenant-scoping.md).

### 5.2 Plugin Architecture

The three plugin interfaces (`LLMProvider`, `VTTDriver`, `VoiceIO`) per [ADR-0004](adr/0004-plugin-interface-pattern.md) are the orchestrator's modular boundaries. (ADR-0004 originally defined a fourth, `Ruleset`; it was dropped by [ADR-0012](adr/0012-drop-ruleset-plugin-interface.md) — Foundry's per-system data models already provide that abstraction, so per-system mechanics are not Skeinkeeper's concern.) Implementations:

- `LLMProvider`: `AnthropicProvider` (default). Other providers (`OpenAIProvider`, `GrokProvider`, `GeminiProvider`) implementable via the interface.
- `VTTDriver`: `FoundryDriver` over a Foundry MCP bridge (default). Others (`OwlbearDriver`, `Roll20Driver`) as community contributions.
- `VoiceIO`: `DiscordVoiceIO` wrapping STT/TTS providers (default).

Per-system mechanics are handled by a thin presentation layer — per-system renderers that format a Foundry actor's opaque `system` blob into a one-line summary for the prompt — plus per-system mutation tools registered at session start once the active Foundry system is known. Neither is a plugin interface (see [ADR-0012](adr/0012-drop-ruleset-plugin-interface.md)).

### 5.3 Performance & Latency

- **Voice round-trip target:** ≤ 3s p95 from player end-of-utterance to AI start-of-speech (short responses); ≤ 6s p95 for long narration (first audio chunk).
- **Streamed TTS** required. AI starts speaking before generation completes.
- **Tool call latency:** ≤ 500ms p95 for state-mutation tools against local SQLite.
- **VTT operation latency:** ≤ 1s p95 for Foundry MCP calls.
- **Session length:** must run a 4-hour session without degradation, memory leak, or context overflow.

### 5.4 Cost (Operator-Borne)

All LLM, TTS, and STT costs flow directly from the operator's own API accounts. Skeinkeeper itself is free.

- **Cost transparency.** The web UI shows per-session and cumulative cost from logged token/audio usage, computed at provider-published rates. The operator sees exactly what each session costs.
- **Model-tier routing.** Within a session, route narration to a high-quality model (Claude Opus or equivalent) and tool-call orchestration to a cheaper model (Haiku-class). Reduces per-session LLM cost ~3-5×.
- **Configurable budgets.** Operator can set per-campaign budget alerts; the AI receives the warning as context and can adjust verbosity if asked to economize.

Reference cost expectations at default settings (Claude + ElevenLabs + Deepgram, 2-hour session): ~$2–$5 per session. Operators with tight budgets can drop to Haiku-class narration and OpenAI TTS for ~$0.50–$1 per session.

### 5.5 Privacy & Security

**The privacy stance:** Skeinkeeper is a tool that the operator runs on their own infrastructure, processing their own and their friends' data. Skeinkeeper is not a data controller in the GDPR sense; the operator is. The architecture supports the operator in being a good controller.

**Architectural commitments (always-on):**

- All secrets encrypted at rest using OS keyring or libsodium-sealed config.
- TLS 1.3 on any network-facing surface (Foundry connection, LLM API calls, etc.).
- `PII<T>` type marker in code so personal-data fields are statically distinguishable. Encrypted at rest by default.
- **Every persistent data store has a documented deletion path.** Per-player deletion: when a player leaves the campaign or invokes erasure, the operator runs a CLI command (`skeinkeeper player:delete <discord-id>`) that cascades across all storage systems including the vector store and backups. Per-campaign deletion: similarly cascades.
- **Audit log of every state mutation, tool call, and AI decision.** Operator can export their own data at any time.
- **No telemetry by default** — see §5.6.
- **Tenant-scoping in the data model** so each campaign group's data is isolated by construction (see [ADR-0008](adr/0008-tenant-scoping.md)).

**Voice data:**

- Treated as sensitive but **not as GDPR Art. 9 special-category data** — biometric identification is never performed; transcription only.
- Audio is strictly ephemeral: streamed to STT, transcribed, bytes discarded immediately. No retention anywhere.
- A one-time consent flow runs when each player joins a voice channel: a Discord DM with the consent disclosure and a click-through. Consent recorded in the local `consents` table. Withdrawal via `/skeinkeeper consent withdraw voice` slash command.

**What's NOT committed (intentional):**

- No DPA negotiations with sub-processors. The operator's own API agreements with Anthropic, ElevenLabs, etc. are the operator's relationship to manage.
- No GDPR Article 28 controller-processor framework. The operator is the controller; Skeinkeeper is software they run.
- No SOC 2, ISO 27001, or other formal certifications. Skeinkeeper is software the operator runs; there is no operated service to certify.
- No centralized breach-notification process — there is no central service holding anyone's data. If a vulnerability is found in Skeinkeeper, we publish a security advisory; the operator handles disclosure to their players per their own obligations.

### 5.6 Telemetry — Off By Default, Opt-In Only

**The install phones home zero times by default.** This is non-negotiable for a self-hosted, privacy-sensitive user base.

**Architecturally** (see [ADR-0009](adr/0009-telemetry-opt-in.md)), the telemetry library exists with a two-stream design (anonymous product analytics + crash/error reporting). Both streams default to **off**. Both have explicit settings the operator can toggle on with full disclosure of what's collected and where it goes.

**What the operator gets out of the box:**

- Local-only logging to a file (debug, errors, audit log).
- A local cost dashboard derived from logged LLM/TTS/STT usage.
- Per-session metrics visible in the web UI.

**What the operator can optionally enable:**

- Anonymous product analytics (opt-in) — sends event-level data to the maintainers' PostHog project to help improve the tool. Disclosed in plain English; off by default.
- Crash and error reporting (opt-in) — sends stack traces to a Sentry project.

Both streams are explicit, opt-in, and fully disclosed; the default install never enables either.

### 5.7 Observability & Debuggability (Local)

- Structured logging to file with session/turn correlation IDs.
- Local LLM call tracing via Langfuse (operator can self-host Langfuse or use the cloud version with their own account).
- Per-turn context viewer in the web UI for the operator to debug AI behavior in their own sessions.
- Eval harness in CI: scenario fixtures replayable on every Behavior Spec change.

### 5.8 Reliability

Best-effort. There are no SLAs for self-hosted software; the operator gets what runs on their machine. We aim for:

- No crashes during a 4-hour session under normal load.
- Graceful degradation: if TTS provider fails, fall back to text-only narration. If primary LLM fails, fall back to text-only with a warning. If VTT disconnects, fall back to chat-only narration with state preserved.

## 6. Architecture Principles

1. **Separate determinism from creativity.** All dice, math, and state mutations are deterministic code. LLM narrates over the deterministic outcome.
2. **State lives in the database, not in the prompt.** The model reads state via retrieval; never trusts prior outputs as source of truth.
3. **Tool calls are the only way the world changes.** See [ADR-0003](adr/0003-tool-call-only-state-mutation.md).
4. **Behavior is spec, not code.** The Behavior Spec is loaded as system prompt; it iterates independently of the platform.
5. **Modular boundaries are real.** No Foundry-specific or Claude-specific calls outside their drivers.
6. **Audit everything.** The operator can answer "why did the AI do that?" for every session.
7. **Tenant scoping is in the data model from day one** so multiple campaign groups in one install stay isolated; cross-tenant queries don't compile (see [ADR-0008](adr/0008-tenant-scoping.md)).
8. **The operator is sovereign.** Web UI can override any state, prompt, or AI decision. The AI yields to the operator on every conflict.
9. **Telemetry is opt-in, never opt-out.** Default state is zero phone-home.
10. **Privacy is structural, not promised.** Type-marked PII, deletion paths, audit logs — these are code-level facts, not policy statements.

## 7. Phased Roadmap

### v0.1 — Friends and Family Alpha

Closed alpha with the founder's table running Lost Mine of Phandelver. Discord text + voice, BYO Foundry, Claude as sole LLM, single hard-coded personality. Manual setup; the operator is the founder. **Success criterion:** complete one Phandelver chapter (3–5 sessions) with the founding table reporting "fun and worth using."

### v0.5 — Public Beta

Public GitHub repository goes live. Documented `docker compose up` install path. Onboarding wizard in the web UI. Behavior Spec personality presets. Multi-campaign support. Memory inspector. Foundry write integration (AI moves tokens, runs combat tracker, reveals fog). NPC voice profiles. Eval harness with ≥ 10 scenario fixtures. **Success criterion:** 50+ operators running their own instances; ≥ 5 completing full Phandelver runs; documented issues fixed.

### v1.0 — Production Open Source Release

Plugin interfaces stabilized and documented. Second campaign supported alongside Phandelver to prove the abstraction. Replay/debugger. Contribution guide; first external contributors onboarded. Behavior Spec evaluation harness as a CI gate. **Success criterion:** the project is contributed to by at least 3 people outside the founder; ≥ 200 active operators.

### v2.0+ — Multi-Everything

Second validated ruleset (Pathfinder 2e or Call of Cthulhu) via its Foundry system module, a renderer, and a per-system tool set. Second VTT driver (Owlbear Rodeo is the lowest effort). Second LLM provider validated in production. Internal campaign content authoring tools.

## 8. License & Governance

- **License:** Apache License 2.0. Permissive with explicit patent grant; appropriate for an LLM-adjacent project. See [ADR-0005](adr/0005-apache-2-license.md).
- **Repository:** public GitHub from v0.5 onward (private during alpha for the founder's iteration speed).
- **Repo structure:** monorepo (`/orchestrator`, `/plugins/*`, `/app`, `/server`, `/telemetry`, `/eval`, `/docs`).
- **Docs in repo:** this PRD, the Behavior Spec, the ADRs, the eval harness fixtures, the TDDs.
- **CONTRIBUTING.md** with plugin authoring guide as the primary contributor path.
- **DCO** for commit sign-off; no formal CLA at v1.
- **Issue templates** distinguishing bug, feature, VTT-request, and LLM-provider-request.
- **CI:** lint, type-check, unit tests, eval harness, telemetry-event-registry validation. No merges without green eval.
- **Versioning:** SemVer. Plugin API stability promised from v1.0.
- **WotC IP awareness:** Phandelver content is WotC IP. The repo ships the loader and abstractions; actual Phandelver content must be supplied by the operator from their own legally-acquired copy. SRD-based rules content (CC-BY-4.0) is fine to ship — see [ADR-0007](adr/0007-phandelver-content-operator-supplied.md).

## 9. Open Questions

**9.1 Default ruleset content for free campaigns.** The free SRD content alone is rules-and-monsters, not adventures. Should we commission or curate a high-quality SRD-only beginner campaign (~5 sessions) to ship as the default reference? This is a v0.5 question, not alpha. Recommendation: yes, after v0.5 if community interest justifies it.

**9.2 Safety tooling defaults.** Ship default Lines (e.g., explicit sexual content, anything involving minors) plus operator-configurable additions. Recommendation: yes, with clear in-product documentation of the non-negotiables.

**9.3 Voice consent.** Each player consents to voice processing once on first join. Show a clear one-time consent banner in Discord. Recommendation: yes.

**9.4 LLM provider sourcing.** Build on Claude as primary (Anthropic); allow operator-configured alternates via the plugin interface. Recommendation: ship Claude only at alpha; add OpenAI provider at v0.5.

**9.5 Multi-AI-DM collaboration.** Some advanced groups use multiple AIs (narrator + combat + voice). Out of scope for v1; the `LLMProvider` interface permits it later.

---

_Companion documents: the [behavior spec](../behavior/default.md), the [ADRs](adr/), and the [TDDs](tdd/)._
