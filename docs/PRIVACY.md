# Privacy

Skeinkeeper is software you run on your own machine. This document explains what data it processes, where that data goes, and how you can control it.

## The short version

- **Skeinkeeper runs on your machine.** No central server, no hosted service, no Skeinkeeper-operated infrastructure.
- **Your campaign data stays local.** Character sheets, transcripts, audit logs, and AI memory live in a SQLite database and LanceDB vector store on your machine.
- **External calls go only to providers you've configured.** When the AI generates narration, the request goes to your chosen LLM provider (e.g., Anthropic, OpenAI). When players speak, audio goes to your chosen STT provider (e.g., Deepgram). You have an account and a billing relationship with each provider; Skeinkeeper is not in the middle.
- **Zero phone-home by default.** Out of the box, Skeinkeeper sends nothing to the maintainers or any third party except the providers you've configured. Anonymous analytics and crash reporting can be enabled via opt-in if you want to help improve the project.
- **You are the data controller.** If you're in a jurisdiction with privacy laws (GDPR, CCPA, etc.), you have controller responsibilities for the data your players' game generates. Skeinkeeper gives you the tools — deletion, export, audit logs — to fulfill those responsibilities.

## What Skeinkeeper stores locally

Skeinkeeper's local database holds **AI-DM-side state** only. Per [TDD 0007](./tdd/0007-foundry-as-source-of-truth.md), the mechanical state of your campaign — character sheets, NPCs, scenes — lives in your Foundry VTT instance, not in Skeinkeeper. Skeinkeeper reads from Foundry per turn; it does not duplicate that data.

What Skeinkeeper stores:

- **Campaign metadata** — campaign name, ruleset, which Foundry world it points at
- **Quest flags** — AI-DM-internal plot state (e.g., "cragmaw.cleared = true"), kept separate from Foundry's official world state so the operator can curate what's visible to players
- **Player↔character map** — which Foundry character each Discord player controls, so the AI knows whose turn it is and who to address. Holds the Discord user ID, the Foundry actor ID, and an optional display name.
- **Voice assignments** — which TTS voice the DM and each NPC use, so characters sound consistent across sessions. Campaign config, not personal data (no Discord IDs); removed when the campaign is deleted.
- **Operator setting** — the Discord user ID of the **operator** who receives setup-note DMs, when you designate yourself in the console or via `/skeinkeeper operator claim`. It's the operator's own ID (operator config, not data collected about a player); removed when the campaign is deleted.
- **Session transcripts** — the text of what was said, both player utterances and AI narration
- **Audit log** — every tool call, state mutation, and AI decision, with timestamps
- **Intake findings** — PII-free session-start classifications (stable codes + rubric summaries) in `session_intake_finding`. Cascades on campaign/tenant delete. Not personal data about players.
- **Episodic memory** — structured summaries of past sessions, embedded for retrieval
- **Consent records** — per-player records of voice processing consent
- **Deletion log** — anonymous record that an erasure happened (no personally-identifying content)
- **Configuration** — your Discord bot token, Foundry credentials, LLM/voice API keys (read from your local `.env`, or **sealed at rest** via `secrets:seal` — see [Encryption](#encryption))

What lives in **Foundry** (not in Skeinkeeper's database):

- Character sheets — HP, stats, inventory, conditions per the active Foundry system module
- NPCs — sheets, dispositions, scene placement
- Scenes / locations — the visual tabletop, fog of war, tokens
- Combat tracker — initiative, current turn, active effects
- Dice rolls — handled and audited on Foundry's side via its chat log

If you erase a player's data from Skeinkeeper, the Skeinkeeper-side erasure does _not_ reach into Foundry. You as the operator are responsible for any matching erasure in Foundry — those are separate stores.

What Skeinkeeper does **not** store, anywhere:

- **Voice audio.** Audio is streamed to your STT provider, transcribed, and the bytes are discarded immediately.
- **Voiceprints or biometric data.** Skeinkeeper does not perform voice identification.
- **Player personal information beyond Discord ID and consent records.**

## What Skeinkeeper sends to external providers

Only the providers you've configured. Specifically:

- **LLM provider** (Anthropic / OpenAI / etc.) — receives the assembled prompt for each turn, including relevant warm state, retrieved cold knowledge, and recent dialogue. Subject to that provider's own data handling and retention policies.
- **STT provider** (Deepgram / OpenAI Whisper / etc.) — receives the audio stream of player speech for transcription. Subject to that provider's policies.
- **TTS provider** (ElevenLabs / OpenAI / etc.) — receives the text the AI wants to speak, and returns audio. Subject to that provider's policies.
- **Foundry VTT** — your own instance; receives commands like "move this token" or "set this scene active." Subject to your own Foundry hosting setup.
- **Discord** — your bot interacts with Discord servers and voice channels you've configured. Subject to Discord's terms.

**Skeinkeeper does not see, store, or transmit any of this data to its maintainers.** Your relationship with each provider is direct.

## Player consent

When a player first joins a voice channel that the Skeinkeeper bot is in, they receive a Discord DM with a consent flow:

> Skeinkeeper transcribes voice in this channel using [your configured STT provider]. Audio is streamed for transcription and immediately discarded; we never store voice recordings. Transcripts are retained in your operator's local Skeinkeeper instance. The AI also keeps a shared, campaign-level memory of what happens at the table; that shared record is not erased when an individual player asks to be forgotten (see "Delete their data" below).
>
> Do you consent to voice processing in this channel?

Audio is not processed until consent is granted. Players can withdraw consent at any time via the `/skeinkeeper consent withdraw voice` slash command; withdrawal takes effect immediately and future utterances are not transcribed.

To be a present DM, Skeinkeeper transcribes the table's ongoing conversation continuously — not only when a player directly addresses the DM. This is how it can react to a player declaring an action to the group, or pick up the thread after a lull. Consented audio is still transcribed and the bytes immediately discarded; the AI simply listens to more of the table than a "push to talk" model would. Unconsented players' audio is never transcribed.

Skeinkeeper also reads **who is in the voice channel** (Discord user IDs + display names) so it can welcome newcomers and run the session-start introductions. This presence signal is used transiently in the moment — it is not a new stored record beyond the player↔character map and consent records already listed above.

**Operator notes go to Foundry GM chat.** When the AI hits a setup problem it can't resolve in-fiction (for example, a player names a character that isn't in the Foundry world), it posts a GM-only Foundry chat message (and whispers the operator's Foundry user when one is known). Players never see these notes. They carry campaign-operational details (a player's display name, a character name) — nothing beyond what's already covered above. The note _messages_ live in Foundry's chat log, not in Skeinkeeper. Discord DMs are used only for the one-time voice-consent prompt (and a one-time courtesy redirect if a player DMs the bot after side-channels moved to Foundry).

This consent is per-player, recorded with a timestamp and the version of the consent text shown.

## Data subject rights

If a player wants to:

**Know what data you hold about them**

```bash
pnpm skeinkeeper player:export --tenant <id> --subject <discord-id> [--out <dir>]
```

Writes an archive (JSON + a readable HTML summary) of everything Skeinkeeper has stored involving that Discord user — their player↔character mappings, transcript appearances, consent records — into the output directory (`./exports` by default). `--tenant` defaults to `default`.

**Delete their data**

```bash
pnpm skeinkeeper player:delete --tenant <id> --subject <discord-id> [--yes]
```

Cascades across the player's **personal** data: dialogue transcripts (their spoken/typed lines), player↔character mappings, consent records, and their **private side-channel content** — their 1:1 DMs with the DM and the DM's private replies addressed to them, plus any private memory derived from them ([ADR-0017](./adr/0017-per-audience-memory-visibility-erasure.md)). (`--yes` skips the confirmation prompt.) The **audit log is not erased per-player** — it's part of the tamper-evident audit trail and is removed only on full tenant deletion. A record of the deletion itself is kept (anonymous: just the fact that deletion occurred, when) for your own audit purposes. Note that character sheets and other mechanical state live in your Foundry instance, not Skeinkeeper; erasing those is a separate action on the Foundry side.

**Private side-channels: what "private" means.** A player can message the DM privately (a Discord DM) for a side question or a surprise action (TDD 0026). That content is **private from the other players** — it never enters another player's context, by construction. It is **not private from you, the operator**: side-channel transcripts are stored and reviewable like any other session content (operator sovereignty / replay-any-session). Don't promise players secrecy from the operator. Private side-channel content is **player-scoped and individually erasable** (the per-player deletion above), unlike the campaign's shared memory.

**What per-player deletion does _not_ remove: the campaign's shared memory.** The AI's episodic memory — the session-by-session summaries of what happened at the table — is a _shared, jointly-authored record of the whole group's story_, not one player's personal data. One player asking to be forgotten doesn't make the rest of the table forget the campaign they played together, any more than it would in real life. Those summaries (and operator-imported lore) persist and are erased only when the **campaign or the whole tenant** is deleted:

```bash
pnpm skeinkeeper campaign:delete --tenant <id> --campaign <id> [--yes]   # erases that campaign's shared memory
pnpm skeinkeeper tenant:delete   --tenant <id> [--yes]                   # erases the whole tenant
```

Campaign/tenant deletion cascades the SQLite tables **and** the on-box episodic vector store (LanceDB). This is a deliberate design decision ([ADR-0014](./adr/0014-episodic-memory-campaign-scoped-erasure.md)); the consent flow discloses it up front. Embeddings are computed **on-box** (the local embedding provider), so memory content does not reach any external embedding service.

(`campaign:export` and `tenant:delete` follow the same flag shape; run `pnpm skeinkeeper --help` for the full list.)

**Stop voice processing** without leaving the campaign

The slash command `/skeinkeeper consent withdraw voice` does this. The player can still participate via text.

If you're the operator, you're in control of these flows; the CLI commands work today (run them with `pnpm skeinkeeper …` from the repo root during alpha), and the web UI will add point-and-click versions in v0.5.

## Your role as operator

If you run Skeinkeeper for players in GDPR-covered jurisdictions (EU/UK) or under other privacy regimes (CCPA in California, VCDPA in Virginia, etc.), you are the data controller for the campaign data you process. Skeinkeeper provides the tools you need — deletion, export, audit, consent records — to meet your obligations. We do not act as a processor on your behalf because we never see your data.

This isn't legal advice. If you're processing data for people in regulated jurisdictions and you're unsure of your obligations, consult someone qualified.

## Telemetry

Skeinkeeper has two telemetry streams, both **off by default**:

- **Anonymous product analytics** — opaque rotating tokens, no PII, no campaign content. Helps the maintainers understand which features get used. Routes to a maintainers-operated PostHog project when enabled.
- **Crash and error reporting** — anonymized stack traces and error context. Routes to a maintainers-operated Sentry project when enabled.

You can enable either or both in Settings → Telemetry. The disclosure on that screen explains exactly what data is sent, where it goes, and how long it's retained. You can disable at any time.

A "Local mode only" badge appears in the web UI when both streams are off, as a reassurance that nothing is leaving your machine beyond the providers you've configured.

## Encryption

- Credentials (API keys, Discord bot token, etc.) can be **sealed at rest** in an AES-256-GCM config file, opened at boot with a passphrase you supply via `SKEINKEEPER_SECRET_PASSPHRASE` (run `pnpm skeinkeeper secrets:seal`, then delete the plaintext from `.env`). Without sealing, they are read from your local `.env`. An OS-keyring key source is planned (per [ADR-0010](./adr/0010-privacy-as-architecture.md)).
- Traffic to external providers uses HTTPS/TLS; the operator console binds to localhost (`127.0.0.1`) and is plain HTTP on your own machine.
- PII fields are type-marked in code (`PII<>`) and **encrypted at rest per column** (AES-256-GCM) when you set `SKEINKEEPER_SECRET_PASSPHRASE` — the same passphrase that seals credentials ([ADR-0022](./adr/0022-pii-encryption-node-crypto.md), superseding ADR-0019). The encrypted columns are Discord IDs, player/character display names, transcript text, audit payloads, and operator settings. Without a passphrase they are stored as plaintext (the alpha default — a key kept on disk next to the data would not be encryption-at-rest). Either way, deletion and audit work **without** the key: each identity column carries a salted hash companion, so `player:delete`/`campaign:delete` and the deletion log never need to decrypt. To encrypt an existing database after setting the passphrase, run `pnpm skeinkeeper pii:encrypt` once (idempotent). An OS-keyring key source is planned (per [ADR-0010](./adr/0010-privacy-as-architecture.md)).

## Security disclosure

If you find a security vulnerability in Skeinkeeper, please email chris@heartofgoldventures.com rather than opening a public issue. We aim to acknowledge reports within 72 hours and ship fixes via a coordinated security advisory.

## Questions?

For questions about how Skeinkeeper handles data that aren't answered here, open a GitHub Discussion or Issue. We aim to be specific and accurate rather than vague.
