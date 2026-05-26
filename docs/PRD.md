# Skeinkeeper — Open-Source AI Dungeon Master

**Product Requirements Document**
**Status:** Draft · 2026-05-26

> **Skeinkeeper** — keeper of the threads of fate. An open-source, self-hosted AI Dungeon Master that runs tabletop RPG campaigns for your friend group over Discord and Foundry VTT.
>
> _Wyrd bið ful aræd._ — Old English (The Wanderer, l. 5b): "Fate remains wholly inexorable." The dice, once cast, are fixed.

---

## 1. Vision & Context

Skeinkeeper is a free, open-source tool that lets a friend group play tabletop RPGs together with an AI Dungeon Master. The DM speaks aloud over Discord voice in distinct character voices, autonomously operates Foundry VTT (maps, tokens, combat, dice), and maintains persistent campaign state across sessions.

The target user is **a technically comfortable DM-or-DM-curious friend who can run `docker compose up`** and wants to play scheduling-flexible D&D with their group. The canonical configuration is **fully-remote, all-individual**: every player joins from their own Discord client over voice, with their own Foundry view open in parallel — voice is Discord, visuals and table text are Foundry. The tool removes the prep burden and scheduling friction that kills most casual campaigns.

**Why open source:** the other AI-DM tools (Friends & Fables, AIDungeonMaster.ai, RoleForge, Voyage, MacerAI, and a dozen smaller products) are closed-source and run on the vendor's servers — you play under their model choices, with your campaign data in their database. Skeinkeeper occupies the niche none of them fills: the technically inclined group that wants to own its data, bring its own LLM and voice API keys, get the voice + Foundry combination none of the others offer, and run the whole thing on its own infrastructure.

## 2. Goals & Non-Goals

### Goals

- Deliver a fluent AI DM experience for a 4-person fully-remote table (each player on their own Discord client + own Foundry view) running D&D 5e (Lost Mine of Phandelver as the reference campaign).
- Voice-first interaction over Discord with distinct NPC voices.
- Autonomous Foundry VTT operation — maps, tokens, combat tracker, dice, fog of war, all driven by the AI.
- Persistent state and memory across sessions.
- Pluggable internally: LLM provider, VTT, and voice stack are swappable behind stable interfaces.
- Operator runs everything locally: `docker compose up`, then access a local web UI on `localhost`.
- Apache 2.0 licensed; community contributions welcomed.

### Non-Goals (for v1)

- Replacing human DMs for groups that already have one.
- Tables larger than ~6 players in a single session.
- **In-person play with a shared microphone or shared Foundry screen.** Skeinkeeper assumes each player has their own Discord voice client (for clean diarization, latency, and echo isolation) and their own Foundry view (for the table-text surface — see Surface model below). Mixed-room configurations (two people sharing a mic, players watching one operator's Foundry screen) are not supported.
- **Theatre-of-mind play.** Every player has their own Foundry view; Foundry isn't optional for the player experience.
- **Out-of-session interaction with the bot.** Sessions are session-bounded. The bot does not maintain async DMs, persistent threads players can revisit later, or pre/post-session question channels. Players who want to ask the operator something between sessions do so out-of-band.
- Native mobile clients (the Discord client provides mobile voice; the operator's web UI is desktop-first; the player's Foundry view is Foundry's native client).
- Shipping or validating rulesets other than D&D 5e at MVP. The architecture is system-portable — per-system mechanics come from Foundry's system modules, not from Skeinkeeper (see [ADR-0012](adr/0012-drop-ruleset-plugin-interface.md)) — but 5e (Lost Mine of Phandelver) is the only validated target at alpha. Other systems become reachable as their Foundry module plus a small renderer exist.
- Marketplace for user-generated campaigns.
- Built-in livestreaming, recording, or content moderation.

## 3. Users & Personas

- **The Operator** — the person who installs and runs Skeinkeeper, and the **host** at the table — not the DM. Technical comfort: medium-to-high. Comfortable with Docker, command line, environment variables, and configuring API keys for LLM/voice providers. Their per-session role is host-level: launch Foundry with the campaign content loaded, start a Discord voice channel, invite each friend to **both** the Discord voice channel **and** Foundry as a Foundry user with ownership of their character actor, launch Skeinkeeper. The AI handles in-play DM duties **and** the setup work that a human DM would do between sitting down and starting the game — assessing materials, picking the starting scene, mapping characters to players, deciding which monster stat block to use (see §4.8). The operator answers escalations when intake surfaces a critical gap or genuine ambiguity, and can override any AI decision via the web UI's live-session view (§4.3). One operator per Skeinkeeper instance.
- **The Players** — the operator's friends. Each connects to the session via their own Discord voice client and their own Foundry view; both surfaces are mandatory (see Surface model below and Non-Goals above). They interact with Skeinkeeper via Discord voice, Foundry's text chat + whisper, and a one-time Discord DM consent prompt on first voice-join. They never touch the configuration UI. Don't need Skeinkeeper accounts; they're known to Skeinkeeper by Discord ID, with the operator-supplied Discord-user → Foundry-user link maintained internally.
- **The AI DM** — a system actor. Has authority to mutate campaign state via tool calls, narrate, voice NPCs, and operate the VTT.

## 4. Functional Requirements

### Surface model — what lives where

Skeinkeeper operates over two player-facing surfaces with deliberate, non-overlapping responsibilities. The split is a design intent, not an accident; do not mirror content between them.

| Surface                              | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discord voice**                    | All audio: AI narration out, player speech in, NPC voices, presence events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Real-time, low-latency, per-speaker diarization with one client per player.                                                                                                                                                                                                                                                                                                   |
| **Discord DMs (1:1)**                | One-time player consent prompt on first voice-channel-join (per §4.6 + §5.5). **Nothing else.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Consent must precede voice processing and may fire before the player has connected to Foundry; Discord voice-join is the only event reliably available at that moment. One-time, low-frequency.                                                                                                                                                                               |
| **Foundry public chat**              | The mirrored AI narration transcript; player text input ("I look around the room"); IC/OOC convention markers; dice-roll receipts (player rolls and AI/GM rolls per §4.2 + §4.3); item-use feedback; scene-change notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Everyone has Foundry open; consolidating table text there lets players keep Foundry fullscreen and not glance away. Foundry's own UI affordances (roll dialogs, ownership-aware visibility, persistent chat) are the right surface for this.                                                                                                                                  |
| **Foundry whisper / GM-only chat**   | (a) Player↔DM 1:1 side-channels (private Q&A, private in-scene actions); (b) audience-targeted journal/handout reveals to a specific `player:<id>`; (c) `gm`-audience content (secret DCs, hidden room contents, NPC true motives); (d) **operator escalations** (`notify_operator`: intake findings, ambiguity prompts, hard-gap warnings, per §4.8 + ADR-0024) delivered as GM-only chat (or whisper to the operator's Foundry user); (e) **operator resolution + override commands** (`/skeinkeeper intake resolve <id> <option>`, scene switches, eagerness/PvP toggles, etc.) typed as Foundry chat commands or — when bridge support lands — clicked as interactive prompts. | The audience model (`table` / `player:<id>` / `gm` from §4.7) maps directly onto Foundry public / whisper / GM-chat; one delivery mechanism for the whole audience taxonomy. The operator is in Foundry fullscreen during the session (per ADR-0023's operator-as-player premise), so Foundry whispers/GM-chat are strictly more visible than minimized Discord DMs would be. |
| **Operator web console (localhost)** | Operator-only configuration, observability, live-session view, override controls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Operator surface only; players never see it (per §4.4).                                                                                                                                                                                                                                                                                                                       |

**Hard rules**:

- **No mirroring between Discord text and Foundry chat.** A player's table text input lives in Foundry; the AI's table narration mirror lives in Foundry. Skeinkeeper does not maintain a parallel Discord text channel mirror.
- **Consent stays on Discord DM (one-time exception).** Consent fires on Discord voice-join, before Foundry presence is guaranteed; Discord DM is the only surface reliably available at that moment. This is the _sole_ remaining text use of Discord — operator escalations and all operator commands are in Foundry.
- **Sessions are session-bounded.** No surface listed above carries pre/post-session interaction with the bot. Async player↔DM use is a non-goal (see Non-Goals above).
- **Foundry-down ends the session.** Under the new configuration, every player needs Foundry for both visuals and table text; if the bridge or Foundry instance disconnects mid-session, there is no degraded "voice-only" mode. The orchestrator preserves state and the operator restarts when Foundry is back (per §5.8).

### 4.1 Voice & Discord Integration

**Bot model:** the operator runs the Skeinkeeper Discord bot under their own bot token, registered in their own Discord developer account. The bot joins the operator's Discord server with the operator's invited permissions.

**Inbound (players → AI):**

- Bot joins a designated Discord voice channel. Each player connects from their own Discord client (see Surface model + Non-Goals on shared-microphone configurations).
- Real-time speech-to-text per speaker with diarization (AI knows which player said what).
- **Configurable activation mode** per campaign:
  - **Wake-word** (default): players prefix utterances with a configured term ("DM", "Storyteller", or any operator-set string + aliases). STT-output prefix match with fuzzy tolerance.
  - **Always-on with VAD** — every utterance treated as directed to the AI unless flagged OOC.
  - **Push-to-talk** — Discord PTT bounds when the AI listens.
- **Text input lives in Foundry public chat**, not on a parallel Discord channel. A player typing in Foundry's chat field is surfaced to Skeinkeeper through the MCP bridge.
- IC vs OOC disambiguation via convention (`!ooc` slash, `((parentheticals))`, or wake-phrase "DM, OOC:") — applies to voice utterances and to Foundry-chat text input alike.

**Outbound (AI → players):**

- TTS streamed to the same Discord voice channel.
- **Per-NPC voice profiles** — each named NPC has a persistent voice identity, configured in the local web UI.
- **Mirrored text transcript in Foundry public chat** (the player-facing visual surface; see Surface model) and in the operator's web UI (the operator-facing observability surface).
- **Private 1:1 side-channels** — Foundry whisper threads between a player and the AI DM, for private Q&A and private in-scene actions. See §4.7.

**Discord DMs (the only Discord text surface used):**

- **One-time player consent prompt** when a player joins voice for the first time (per §4.6 + §5.5). This is the sole text use of Discord; nothing else. Operator escalations and all operator commands live in Foundry (see §4.2 + Surface model).

**TTS/STT providers (pluggable via internal interface):**

- TTS: ElevenLabs (recommended), OpenAI TTS, Azure Neural TTS, Cartesia. Operator brings their own API key.
- STT: Deepgram (recommended, best diarization), OpenAI Whisper API, AssemblyAI, local Whisper. Operator brings their own API key (or runs local Whisper).
- Provider selection is per-campaign in the operator's web UI.

### 4.2 Foundry VTT Integration

The operator runs their own Foundry instance. Skeinkeeper connects to it through a self-hosted, open-source Foundry MCP bridge (see [ADR-0001](adr/0001-use-foundry-mcp-for-vtt.md), superseded by [ADR-0011](adr/0011-prefer-oss-foundry-mcp-bridges.md)), which exposes the command surface we need: scenes, tokens, actors, items, combat, dice, chat, and journals. Under the Surface model above, Foundry is the table-text surface as well as the visual surface; the bridge must expose the AI's text-output path into Foundry chat.

**Per-player Foundry access (host pre-flight):**

- Each player has their own Foundry user account, with ownership of their character actor. Created/granted by the operator before Start (per §4.6 host pre-flight and §4.8). Shared-screen or theatre-of-mind configurations are non-goals.

**Functional surface:**

- Scene activation, fog of war, lighting from pre-built templates.
- Token creation, placement, movement, disposition (friendly/neutral/hostile).
- Combat tracker management: initiative, turn order, conditions, death saves.
- **Server-side dice rolling for AI/GM/secret rolls**, with roll-mode selection (`public` / `gm` / `blind` / `whisperTo`) so the audience model from §4.7 is enforced at the bridge call. Result lands in Foundry chat. _(Player-initiated rolls already use Foundry's native roll UI via `request-player-rolls`; this requirement extends server-side rolling to AI-side rolls.)_
- **AI text output to Foundry chat** — table-audience narration to public chat, `player:<id>`-audience content to Foundry whisper, `gm`-audience content to GM-only chat. The bridge must expose this; see Critical bridge dependencies below.
- **Operator escalation channel** — `notify_operator` content (intake findings, hard-gap warnings, ambiguity prompts) is delivered as GM-only chat (or whisper to the operator's Foundry user), per ADR-0024.
- **Operator commands** — operator-side resolutions, overrides, and toggles (e.g., `/skeinkeeper intake resolve <id> <option>`, scene-switch, eagerness/PvP toggles) are typed as Foundry chat commands surfaced through the bridge; when interactive-prompt support lands, escalations can also render one-click resolution buttons inline.
- Compendium access (D&D 5e default).
- Journal entries; per-audience handout reveals matching the audience model.
- Read-write access to actor sheets (HP, conditions, spell slots, inventory).

**Critical bridge dependencies (v0.5).** Four bridge capabilities are now load-bearing for the Surface model and must move to the critical-path upstream batch (or be addressed via fork):

1. **`post-chat-message`** with audience targeting (`table` → public; `whisperTo: [userId]` → whisper; `gm` → GM-only). Without this, the AI cannot write text to Foundry chat, and the entire table-text surface — plus the operator-escalation channel — collapses back to Discord.
2. **Server-side `roll-dice`** with roll modes (`public` / `gm` / `blind` / `whisperTo`). Without this, AI/GM rolls remain in Skeinkeeper's local roller and don't land in Foundry chat — breaking the auditability of rolls and the consolidation of table text on one surface.
3. **`delete-chat-messages`** filtered by author / recipient / time-range. Required for per-player erasure (§5.5): when a player invokes erasure, Skeinkeeper must remove that player's whisper history from Foundry as well as from its own audience-tagged store; without this, the per-audience erasure guarantee under [ADR-0017](adr/0017-per-audience-memory-visibility-erasure.md) is operational (operator manually deletes), not architectural.
4. **`chat-command` listener** — a way to surface operator-typed Foundry chat commands (e.g. `/skeinkeeper intake resolve <id> <option>`) to the bridge so the orchestrator can handle them. Without this, the operator has no in-Foundry text path to resolve escalations or run overrides; the bridge would need to either parse operator chat for known commands or expose a generic command-channel. _Optional but desirable:_ **interactive-prompt support** (clickable buttons in chat messages) so escalations can render one-click resolution options instead of requiring typed commands.

All four are tracked against [TDD 0027](tdd/0027-mcp-bridge-gap-reaudit-upstream-proposal.md)'s upstream batch.

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
- **Whisper** — targeted private text, delivered via Foundry whisper to the target player; the same mechanism as the §4.7 side-channel.

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
- **Side-channel controls:** toggle **player-vs-player (PvP)** resolution for private actions (default off); review side-channel transcripts. See §4.7.

### 4.5 Local Authentication & Secrets

- **First-run setup:** operator sets a local password. Optionally registers a WebAuthn passkey for unlock.
- **Session management:** standard browser cookie session, scoped to localhost.
- **Secret storage:** all API keys and tokens encrypted at rest using the OS keyring; fallback to libsodium-sealed config file if keyring is unavailable.
- **No remote auth, no SSO, no OAuth.** The operator is the only user.

### 4.6 Player Onboarding

Players don't need Skeinkeeper accounts. The operator:

1. Adds players to the campaign by Discord ID via the web UI, and **adds each player as a Foundry user with ownership of their character actor**. Both Discord-channel access and Foundry-user access are host pre-flight responsibilities (see §4.8 + ADR-0023).
2. Sends each player a brief in-Discord onboarding DM from the bot (consent to voice processing, campaign overview, character creation if needed). Discord DM is the pre-Foundry-join surface for this exchange — consent must be gathered before any voice processing, before a player has connected to Foundry.
3. Each player connects to the session via their own Discord client (for voice) and their own Foundry view (for visuals and table text). Both are required (per Surface model and Non-Goals).

Player-facing surfaces are **Discord** (voice + one-time consent DM) and **Foundry** (visual + all table text + whispers). The web UI is operator-only.

### 4.7 Player↔DM Side-Channels

A player can whisper the AI DM directly in Foundry for a **private 1:1 side-channel**, separate from the shared table voice and public chat. Two modes share one visibility/erasure model:

**Private Q&A** — the player asks a side question (lore lookup, character-sheet question, "what do I know about…") via Foundry whisper; the DM answers via Foundry whisper to that player. Nothing leaves the player's private context.

**Private in-scene actions — private initiation, public resolution.** A player can declare a discreet action privately ("I slip away from the others and pick the lock") via Foundry whisper. The deliberation and resolution are private; the **resolved action's narration is delivered at the table** in Foundry public chat (and over Discord voice) ("Mid-sentence, Dana's blade buries itself in the cultist's throat…"). The table learns the _action_, never the _planning_.

**Audience model.** Every utterance/turn carries an explicit audience: `table` (everyone), `player:<id>` (one player + the operator), or `gm` (the AI/operator only — secret DCs, hidden room contents, NPC true motives). A `player:<id>` context cannot see other players' private content or any `gm` content — a structural anti-leak guarantee, not a prompt instruction. The audience model maps directly onto Foundry's chat surfaces: `table` → public chat, `player:<id>` → whisper to that player, `gm` → GM-only chat.

**Session-bounded.** Side-channels exist only during an active session. There is no out-of-session DM thread; a player who wants to ask the operator something between sessions does so out-of-band.

**PvP toggle (operator-controlled).** Resolving a private action against another **player's** character is gated by a **PvP** toggle, default **OFF**. With PvP off, the AI refuses and redirects the player to settle it with the group. The PvP setting is **read once, at initiation** — an in-flight private PvP action completes under the value that applied when it began; toggling mid-resolution affects only subsequent actions.

**Single-scene invariant.** The system does not split the party across scenes. Private deliberation can happen in parallel; the _table state_ (active scene, NPCs in play) is always shared. See [ADR-0020](adr/0020-single-scene-invariant.md).

**Operator visibility.** Side-channel content is private from _other players_, **not from the operator**: the operator sees all whispers via standard Foundry GM-view, and Skeinkeeper persists the audience-tagged transcript for review, export, and erasure like any other session content. The audit log surfaces side-channel activity.

**Privacy semantics.** A player's side-channel content is **player-scoped and individually erasable**; the campaign's shared memory is campaign-scoped (per [ADR-0017](adr/0017-per-audience-memory-visibility-erasure.md) / [ADR-0014](adr/0014-episodic-memory-campaign-scoped-erasure.md)). Per-player erasure deletes both the Skeinkeeper-side dialogue store _and_ the corresponding Foundry whisper history for that player — the operator's erasure obligation extends to the Foundry side via the bridge. The consent flow discloses this up front. See §5.5.

See [TDD 0026](tdd/0026-player-dm-side-channels.md), [ADR-0017](adr/0017-per-audience-memory-visibility-erasure.md), [ADR-0020](adr/0020-single-scene-invariant.md).

### 4.8 Session Intake & Autonomous Pre-Game Setup

The AI DM is handed the campaign **cold** — like a guest DM walking into a host's table. The operator's per-session work ends at host-level tasks. Everything that a human DM would do _between sitting down and starting the game_ — assessing materials, picking the starting scene, mapping characters to players, choosing which stat block to use for a given creature — is the AI's job.

**Host pre-flight (what the operator must do before Start):**

- Foundry is running with the intended campaign content (system + module + compendium packs) loaded.
- The Foundry MCP bridge is connected.
- A Discord voice channel exists; Skeinkeeper's bot has been invited.
- Skeinkeeper is running with credentials configured (per §4.5).
- Each player has an invite to the Discord voice channel **and** has been added as a Foundry user with ownership of their character actor. Both surfaces are required (per Surface model + §4.6).

**Not** required pre-Start: a chosen active scene, named or assigned character actors, pre-spawned monsters, pre-arranged journals, an explicit "this is the campaign I'm running" config. The AI handles all of that during intake.

**Session intake (the AI's "I just walked in" routine).** On Start, the AI reads:

- **The Foundry world** — active system, installed modules, available compendium packs, pre-existing journals and scenes, party-actor candidates, current ownership map, in-progress combats and quests.
- **Skeinkeeper warm state** — prior sessions for this tenant (recap fodder), quest flags, NPC deltas, consents (see §5.1).
- **The intersection** — which actors are plausibly the player party vs. unclaimed; which scenes correspond to which campaign beats; which compendium content is required by the players' character sheets vs. what's actually loaded.

It then produces a structured **intake report** and surfaces it to the operator via the `notify_operator` Foundry channel (GM-only chat, or whisper to the operator's Foundry user). The report distinguishes:

- **Critical gaps** (block Start) — required content wholly missing; no compatible Foundry system installed; no character actors plausibly constituting the player party; a player's character requires content (a race, a class) that isn't loaded.
- **Ambiguities** (require operator preference between equally-valid options) — e.g., multiple unrelated campaign modules loaded (_"You put both Lost Mine of Phandelver and Ravenloft: The Horrors Within on the table — which one did you want me to run?"_); the same creature present in multiple packs (_"There's a Goblin in the LMoP module and one in the Monster Manual — preference on which I use?"_); a player's race/class is defined in more than one loaded source.
- **Recommendations** (AI proposes; operator may override) — proposed starting scene; proposed source pack for ambiguous lookups going forward. _(Discord-user → Foundry-user → actor ownership is host pre-flight, not a recommendation — see autonomous setup item 2 below.)_

**Autonomous pre-game setup (no operator confirmation required for routine setup).** Within the AI's authority:

1. **Initial-scene activation** — if exactly one scene unambiguously corresponds to the campaign's expected starting beat, the AI activates it and notifies the operator after the fact. Ambiguous → propose and wait.
2. **Discord-user → Foundry-user → actor ownership confirmation** — during the onboarding ritual, the AI confirms each Discord user's identity, links them to their pre-existing Foundry user (host pre-flight), and verifies ownership of the character actor. If a Foundry user is missing or ownership wasn't assigned in pre-flight, this is a critical gap that blocks Start (operator must fix in Foundry and retry).
3. **Source-material indexing** — the AI builds a retrievable index over loaded campaign content (journals, monsters, items, scenes) keyed by location, quest, and keyword, so it can pull the right entry during play. Re-indexing on subsequent Starts is incremental.
4. **Pre-loading expected content** — the AI imports needed monster/NPC actors from compendium into the world (without placing tokens on any scene) so they're ready when an encounter triggers. Lazy import at trigger time is acceptable when faster.

**Live state perception during play.** The AI subscribes to Foundry state changes — scene activation, token movement, combat-tracker events, actor-sheet updates, journal access — and to Discord voice presence. Perception is a platform capability; **when and how** the AI reacts to a given perception is the behavior spec's job (per §4.3 and the [behavior spec](../behavior/default.md)).

**Triggered actions.** The AI can place tokens with `hidden` visibility, reveal them when narratively appropriate, share journal entries with a specified audience (`table` / `player:<id>`, per §4.7), and distribute loot to actor inventories. These are platform capabilities; trigger _policy_ lives in the behavior spec.

**Concurrency model.** Intake work runs in parallel with the player-facing rituals — one of the benefits of an automated DM. The AI must complete a _minimum intake_ (Foundry system identification, party-actor candidate enumeration, critical-gap detection) before announcing readiness or beginning the onboarding ritual. Beyond that minimum, **source-material indexing and content pre-loading run concurrently with onboarding** (TDD 0023): players are greeted, mapped to characters, and welcomed into the fiction while the AI ingests the campaign in the background. Players never wait through visible prep.

**Spoiler-aware escalations.** The operator may also be a player at the table — the AI cannot assume the operator stands outside the fiction. Escalations are framed to elevate a _choice_ without surfacing the _context_ of the choice when context would spoil. Concrete: _"Both LMoP and Ravenloft are loaded — which one tonight?"_ is spoiler-safe; _"I'm preparing the road-ambush goblins — which Goblin stat block?"_ leaks an upcoming encounter. When DM-only context is unavoidable, the AI flags it explicitly (_"This will affect tonight's session — DM-only info follows:"_) so the operator can decide whether to look. The audience model from §4.7 governs the rest of the AI's communications; this principle extends it to the operator escalation channel.

**Operator-as-host principle.** Zero operator config; escalate on ambiguity, gap, or judgment. The AI's default is to proceed with what it inferred and tell the operator after the fact. It interrupts the operator only when a gap is genuinely blocking, a choice is genuinely ambiguous, or a judgment call has multiple equally-valid options and the operator's preference is needed. Silence is success.

See [ADR-0023](adr/0023-operator-as-host-model.md), [ADR-0024](adr/0024-silence-is-success-operator-escalation.md), [ADR-0016](adr/0016-operator-control-parity-across-surfaces.md), [ADR-0018](adr/0018-foundry-source-of-truth.md), and [TDD 0023](tdd/0023-session-onboarding-presence-operator-channel.md).

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
- **Per-audience visibility and erasure** — every stored utterance/memory carries an explicit audience (`table` / `player:<id>` / `gm`; see §4.7). A player's private side-channel content is player-scoped and individually erasable; shared campaign memory is campaign-scoped (per [ADR-0017](adr/0017-per-audience-memory-visibility-erasure.md) and [ADR-0014](adr/0014-episodic-memory-campaign-scoped-erasure.md)). Under the Surface model, side-channel content is stored in Skeinkeeper's audience-tagged dialogue store _and_ delivered via Foundry whisper; per-player erasure cascades to both — the deletion adapter calls the bridge to remove the corresponding Foundry whisper history for that player. The audience anti-leak guarantee is preserved at two layers: Skeinkeeper composes hot context with audience-scoping (a `player:<id>` LLM context excludes other players' private content and any `gm` content), and Foundry's whisper render enforces per-recipient visibility on delivery.

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
- Graceful degradation: if TTS provider fails, fall back to text-only narration in Foundry chat. If primary LLM fails, surface a warning + pause. **If Foundry or the bridge disconnects, the session pauses with state preserved** — there is no "voice-only" continuation mode, because under the Surface model the player text surface lives in Foundry; the operator restarts the session when Foundry is back.

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

Closed alpha with the founder's table running Lost Mine of Phandelver. Discord voice + one-time consent DM only; BYO Foundry as the visual + table-text surface AND the operator escalation/command surface; Claude as sole LLM; single hard-coded personality. Manual setup; the operator is the founder. **Success criterion:** complete one Phandelver chapter (3–5 sessions) with the founding table reporting "fun and worth using."

### v0.5 — Public Beta

Public GitHub repository goes live. Documented `docker compose up` install path. Onboarding wizard in the web UI. Behavior Spec personality presets. Multi-campaign support. Memory inspector. Foundry write integration (AI moves tokens, runs combat tracker, reveals fog, **posts to Foundry chat per the audience model, performs server-side rolls, and erases per-player whisper history on player-erasure** — see §4.2 Critical bridge dependencies). NPC voice profiles. Eval harness with ≥ 10 scenario fixtures. **Success criterion:** 50+ operators running their own instances; ≥ 5 completing full Phandelver runs; documented issues fixed.

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

**9.6 Intake escalation UX.** When the AI surfaces multiple ambiguities or gaps at once, what's the right Discord-DM format? A single structured DM with embedded reply controls (slash-command response per item), or a back-and-forth thread per item? Recommendation: single structured DM with one slash-command response path at v0.5; iterate after live UX observation.

**9.7 Hard-gap policy.** When critical content is missing and the operator can't resolve it on the spot (e.g., a player has a Fairy race but neither _Witchlight_ nor _Multiverse_ is loaded), what's the AI's fallback? Improvise from SRD-adjacent content, refuse to Start, or proceed with the player's character but flag the resource gap throughout the session? Recommendation: proceed with operator acknowledgement; the AI improvises reasonably during play and logs the gap, rather than blocking the session.

**9.8 Spoiler-safe escalation framing.** How does the AI decide whether escalation _context_ (which encounter is being prepared, which monster is being selected, which journal is about to be revealed) is spoiler-laden for the operator-as-player case? Heuristics could include: anything tied to an unrevealed scene, anything keyed to an in-progress quest, anything the players' characters haven't yet observed. Recommendation: conservative default at v0.5 (escalate the choice without context whenever possible; explicit DM-only flag when context is required); refine via live observation and an operator-configurable "I'm also a player" toggle if needed.

---

_Companion documents: the [behavior spec](../behavior/default.md), the [ADRs](adr/), and the [TDDs](tdd/)._
