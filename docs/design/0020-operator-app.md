# Design Doc 0020: Operator App (Phase 5)

> Status: Accepted
> Author: maintainers
> Date: 2026-05-19
> Related ADRs: [ADR-0004 (plugin interface pattern)](../adr/0004-plugin-interface-pattern.md), [ADR-0008 (tenant scoping)](../adr/0008-tenant-scoping.md), [ADR-0009 (telemetry opt-in)](../adr/0009-telemetry-opt-in.md), [ADR-0010 (privacy as architecture)](../adr/0010-privacy-as-architecture.md), [ADR-0011 (OSS Foundry MCP bridge)](../adr/0011-prefer-oss-foundry-mcp-bridges.md)
> Related design docs: [0011 (turn loop)](./0011-orchestrator-turn-loop.md), [0012 (voice IO)](./0012-voice-io.md), [0013 (session lifecycle)](./0013-dialogue-persistence-session-lifecycle.md), [0014 (McpFoundryClient)](./0014-mcp-foundry-client.md), [0015 (always-listening loop)](./0015-always-listening-voice-loop.md), [0016 (identity mapping)](./0016-player-character-identity-mapping.md), [0017 (voice assignment)](./0017-voice-assignment.md), [0018 (streaming STT)](./0018-streaming-stt.md)

## Context

Live validation proved the whole voice stack works (Layers 0–3 + streaming
STT). But it ran via throwaway `scripts/check-*.ts`: in-memory DB,
`MockFoundryClient`, **auto-granted consent**, CLI-driven, `.env` secrets, and a
composition root duplicated in each script. Phase 5 turns that into the real
**operator app** — the thing a friend group actually runs.

It is the *composition root* the design docs have referred to ("the operator
app / Phase 5 owns joining the channel…"). No new orchestrator concepts; it
wires the existing pieces, adds the consent flow + UI + auth + persistence the
scripts stubbed.

## Decision

### 1. One service, two faces

A single Node service ("`@skeinkeeper/app`") that runs both:
- the **Discord gateway client + voice loop** (the part the `voice-discord`
  plugin deliberately omits), and
- a **local web server** for the operator UI.

One process keeps `docker compose up` simple and lets the UI and bot share one
`TenantDb` + config. The session-manager and web layers are kept separable so a
future split (bot worker + web) is mechanical. *Alternative: separate processes
now* — rejected as premature for a single-operator alpha.

### 2. Voice composition root

The app owns the `discord.js` `Client`, and on session start:
- joins the configured voice channel with **`selfDeaf: false`** (doc 0018
  lesson), producing the `VoiceConnection`;
- builds `DiscordVoiceIO` + `DeepgramStreamingSTT` + `ElevenLabsTTS` +
  `ElevenLabsVoiceLibrary`;
- builds the `Session` — `AnthropicProvider`, `ToolDispatcher`
  (`createDefaultRegistry`), **`McpFoundryClient`** (doc 0014, real Foundry via
  the OSS bridge, ADR-0011), persistent `TenantDb`;
- runs `runAlwaysListeningSession` with `voiceRouting` (DM persona +
  AI-assigned/persisted NPC voices, docs 0016/0017).

### 3. Consent flow (closes the gate the scripts stubbed)

Per ADR-0010, capture is gated on consent *before* STT. The transport throws
from `requestConsent` by design; the app owns delivery:
- On a `consent_needed` event, the app DMs the player the versioned consent text
  (`VOICE_CONSENT_TEXT`).
- The player grants/withdraws via a **Discord slash command**
  (`/skeinkeeper consent grant|withdraw voice`) or a DM button → recorded in
  `tenantDb.consents`.
- The loop's `isConsented` reads `tenantDb.consents.isGranted(...)`. No
  auto-consent.

### 4. Web UI (localhost:3000)

Operator-only controls — the operator never sees provider internals:
- **Campaigns/sessions** — create a campaign (point at a Foundry world),
  start/stop a session.
- **DM voice** — pick a curated **persona** (doc 0017; ElevenLabs hidden), with
  preview; persisted to `voice_assignment` (`subjectKind:"dm"`).
- **Eagerness dial** — Reserved/Balanced/Eager, changeable mid-session (doc
  0015 §2a); written to campaign/session config.
- **Live view** — transcript, respond/skip decisions + reasons, current turn,
  tool calls.
- **Overrides** — correct player↔character mappings (doc 0016) and NPC→voice
  assignments (doc 0017).
- **Privacy ops** — per-player export/erasure (wired to the existing
  `ExportService`/`ErasureService`), consent status.
- **Telemetry** — opt-in toggles, off by default (ADR-0009).

### 5. Control plane: DB-as-bus

The UI changes behavior by **writing config the running loop already reads**,
avoiding IPC:
- Eagerness → the loop's `getEagerness` callback reads campaign/session config
  each cycle (already supported).
- DM persona / NPC / mapping overrides → the `voice_assignment` and
  `player_character_map` tables the loop already consults.
- Start/stop session → an in-process session-manager call (single process), with
  a control row for auditability.

### 6. Auth & secrets

- **Auth** (CLAUDE.md): local password + optional WebAuthn passkey, no remote
  auth; localhost-bound by default.
- **Secrets** (hard rule #7): production loads provider keys from the **OS
  keyring or a libsodium-sealed config file**, captured by a first-run setup
  wizard — not `.env` (which stays dev-only). CI already rejects secret-shaped
  strings.

### 7. Persistence & deployment

- Real on-disk SQLite under `SKEINKEEPER_DATA_DIR` + LanceDB (Phase 4), not
  `:memory:`.
- `docker compose up` runs the app (web on `localhost:3000`); the Foundry MCP
  bridge runs as a documented companion (compose service or operator-run).

### 8. Phasing

- **5a — headless app**: the composition root as a long-running service (config
  from a file), persistent DB, real Foundry, consent flow. Replaces the
  `check-discord-session` script. Runnable end-to-end without a UI.
- **5b — web UI**: controls, live view, overrides, privacy ops.
- **5c — hardening**: auth, sealed secrets + setup wizard, docker compose
  packaging.

## Alternatives considered

- **Web framework: none — Node's standard library** (settled in review). A
  localhost operator panel is a handful of forms plus a live view; in an
  already-Node system the simplest, lowest-dependency option is the built-in
  `http` server serving static HTML/JS with a few JSON endpoints, and
  **Server-Sent Events** (also built-in) for the live transcript/decision feed.
  No SPA framework, no Next.js, no separate API framework — **zero new web
  dependencies**. Earlier drafts floated Vite+Fastify or Next.js; both add
  dependencies for no benefit at this scale and were rejected — keep it simple.
  Revisit only if the UI outgrows hand-rolled HTML. (CLAUDE.md's "Next.js or
  similar" tech-stack line gets updated to this when 5b lands, per hard rule
  #15.)
- **Separate bot and web processes** — cleaner isolation, more ops overhead;
  deferred (§1).
- **Keep CLI-only (no web UI)** — the operator was explicitly promised a
  non-CLI interface; rejected. A CLI remains for headless 5a + privacy ops.
- **IPC/event bus between UI and bot** — unnecessary in one process; the
  DB-as-bus approach (§5) is simpler and already half-built.

## Telemetry implications

Opt-in only (ADR-0009): `session.started/ended` already exist; the app may add
`operator.session_controlled` / `consent.recorded { action }` (no PII). All
behind the off-by-default toggle.

## Privacy implications

This phase *implements* the privacy guarantees the scripts bypassed: real
consent gating before STT, the deletion/export UI, sealed secrets. No new data
categories beyond what ADR-0010 + PRIVACY.md already cover; the consent flow
matches the documented wording/versioning. PRIVACY.md/INSTALL.md get an
operator-setup pass (hard rule #15) when this lands.

## Eval implications

The orchestration is already covered by orchestrator/voice unit tests; the app
is wiring + UI. New testable pieces: the consent state machine
(grant/withdraw/gate) as a pure reducer over `tenantDb.consents`; the
session-manager start/stop lifecycle. The Discord/UI surface stays operator
live-validated, like the rest of the transport.

## Open questions

- **Multi-session / multi-campaign concurrency** — one active session at a time
  for alpha? Or several? Affects the session-manager shape.
- **Setup wizard scope** — how much first-run config (keys, Foundry URL, Discord
  token, channel) the UI captures vs. a config file.
- **Foundry MCP bridge packaging** — bundled compose service vs. operator-run;
  ties into INSTALL.md.
- **Web auth for remote access** — localhost-only for alpha; if operators want
  to reach it off-box, that needs a deliberate auth/TLS story (out of scope).
