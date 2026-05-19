# Privacy

Skeinkeeper is software you run on your own machine. This document explains what data it processes, where that data goes, and how you can control it.

## The short version

- **Skeinkeeper runs on your machine.** No central server, no hosted service, no Skeinkeeper-operated infrastructure.
- **Your campaign data stays local.** Character sheets, transcripts, audit logs, and AI memory live in a SQLite database and LanceDB vector store on your machine.
- **External calls go only to providers you've configured.** When the AI generates narration, the request goes to your chosen LLM provider (e.g., Anthropic, OpenAI). When players speak, audio goes to your chosen STT provider (e.g., Deepgram). You have an account and a billing relationship with each provider; Skeinkeeper is not in the middle.
- **Zero phone-home by default.** Out of the box, Skeinkeeper sends nothing to the maintainers or any third party except the providers you've configured. Anonymous analytics and crash reporting can be enabled via opt-in if you want to help improve the project.
- **You are the data controller.** If you're in a jurisdiction with privacy laws (GDPR, CCPA, etc.), you have controller responsibilities for the data your players' game generates. Skeinkeeper gives you the tools — deletion, export, audit logs — to fulfill those responsibilities.

## What Skeinkeeper stores locally

Skeinkeeper's local database holds **AI-DM-side state** only. Per [design doc 0007](./design/0007-foundry-as-source-of-truth.md), the mechanical state of your campaign — character sheets, NPCs, scenes — lives in your Foundry VTT instance, not in Skeinkeeper. Skeinkeeper reads from Foundry per turn; it does not duplicate that data.

What Skeinkeeper stores:

- **Campaign metadata** — campaign name, ruleset, which Foundry world it points at
- **Quest flags** — AI-DM-internal plot state (e.g., "cragmaw.cleared = true"), kept separate from Foundry's official world state so the operator can curate what's visible to players
- **Session transcripts** — the text of what was said, both player utterances and AI narration
- **Audit log** — every tool call, state mutation, and AI decision, with timestamps
- **Episodic memory** — structured summaries of past sessions, embedded for retrieval (lands in Phase 4)
- **Consent records** — per-player records of voice processing consent
- **Deletion log** — anonymous record that an erasure happened (no personally-identifying content)
- **Configuration** — your Discord bot token, Foundry credentials, LLM/voice API keys (all encrypted at rest using your OS keyring)

What lives in **Foundry** (not in Skeinkeeper's database):

- Character sheets — HP, stats, inventory, conditions per the active Foundry system module
- NPCs — sheets, dispositions, scene placement
- Scenes / locations — the visual tabletop, fog of war, tokens
- Combat tracker — initiative, current turn, active effects
- Dice rolls — handled and audited on Foundry's side via its chat log

If you erase a player's data from Skeinkeeper, the Skeinkeeper-side erasure does *not* reach into Foundry. You as the operator are responsible for any matching erasure in Foundry — those are separate stores.

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

> Skeinkeeper transcribes voice in this channel using [your configured STT provider]. Audio is streamed for transcription and immediately discarded; we never store voice recordings. Transcripts are retained in your operator's local Skeinkeeper instance.
>
> Do you consent to voice processing in this channel?

Audio is not processed until consent is granted. Players can withdraw consent at any time via the `/skeinkeeper consent withdraw voice` slash command; withdrawal takes effect immediately and future utterances are not transcribed.

This consent is per-player, recorded with a timestamp and the version of the consent text shown.

## Data subject rights

If a player wants to:

**Know what data you hold about them**

```bash
skeinkeeper player:export <discord-id> > player-data.json
```

Produces a JSON archive of everything Skeinkeeper has stored involving that Discord user: character data, transcript appearances, consent records, audit log entries.

**Delete their data**

```bash
skeinkeeper player:delete <discord-id>
```

Cascades across every storage system (warm state, vector store, audit log, consents). A record of the deletion is kept (anonymous: just the fact that deletion occurred, when) for your own audit purposes.

**Stop voice processing** without leaving the campaign

The slash command `/skeinkeeper consent withdraw voice` does this. The player can still participate via text.

If you're the operator, you're in control of these flows; the CLI commands work today, and the web UI will add point-and-click versions in v0.5.

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

- All credentials (API keys, Discord bot token, etc.) are encrypted at rest using your OS keyring (libsecret on Linux, Keychain on macOS, Credential Manager on Windows), with a libsodium-sealed config file as fallback.
- All network traffic uses TLS 1.3.
- PII-marked fields in the database are encrypted at rest.

## Security disclosure

If you find a security vulnerability in Skeinkeeper, please email chris@henesy.org rather than opening a public issue. We aim to acknowledge reports within 72 hours and ship fixes via a coordinated security advisory.

## Questions?

For questions about how Skeinkeeper handles data that aren't answered here, open a GitHub Discussion or Issue. We aim to be specific and accurate rather than vague.
