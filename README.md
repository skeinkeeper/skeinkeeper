<p align="center">
  <img src="./branding/wordmark.png" alt="Skeinkeeper" width="720">
</p>

> _Wyrd bið ful aræd._ — Old English: "Fate remains wholly inexorable."

**Skeinkeeper** is a self-hosted AI Dungeon Master for your friend group's tabletop RPG sessions. It joins your Discord voice channel, listens to the whole table and speaks aloud in distinct character voices, drives your Foundry VTT, and maintains persistent campaign state across sessions. You run it from a local web console or right from Discord with slash commands.

The target setup: four to six friends, some in-person, some remote over Discord voice. Skeinkeeper runs the DM side so the humans can focus on playing.

## Status

**Pre-MVP alpha.** The founder's table is running Lost Mine of Phandelver as the reference deployment. Public beta target: v0.5. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for what's built and what's planned.

## What you need

To run Skeinkeeper, you need:

- A machine to run it on (Linux, macOS, or Windows with Docker)
- A Discord account, with a [bot you've registered](https://discord.com/developers/applications) in your own Discord developer account
- A Foundry VTT instance you run (v13 or v14) with the Skeinkeeper add-on from this repo (`modules/skeinkeeper`) enabled. You do not install a third-party Foundry connector. See [ADR-0029](./docs/adr/0029-first-party-foundry-addon.md).
- An API key for an LLM provider (Anthropic Claude — the implemented provider today; the interface is pluggable)
- An API key for a TTS provider (ElevenLabs recommended) and an STT provider (Deepgram recommended)
- Comfort with `docker compose up` and editing environment variables

All API costs are paid directly to those providers by you. Skeinkeeper itself is free.

## Installation

See [`docs/INSTALL.md`](./docs/INSTALL.md) for full setup instructions.

Quick start:

```bash
git clone https://github.com/skeinkeeper/skeinkeeper.git
cd skeinkeeper
cp .env.example .env
# edit .env with your API keys and Discord bot token
docker compose up
# open http://localhost:3000 in your browser
```

## What it does

- **Runs the DM side of a tabletop RPG session.** Narrates scenes, voices NPCs, calls for rolls, adjudicates rules, tracks state.
- **Joins your Discord voice channel and speaks aloud.** Distinct per-NPC voices. Always-listening — no wake-word — with an operator-tunable "Eagerness" dial controlling how readily it speaks up.
- **Talks like a person, not a kiosk.** It streams its narration as it generates, so it starts speaking about a sentence in rather than after composing the whole turn; you can **talk over it** and it stops (barge-in); and it covers think-time with a natural beat instead of dead silence. See [TDD 0028](./docs/tdd/0028-real-time-voice-latency.md).
- **Onboards your table as people arrive.** When players join the voice channel it welcomes them, asks which character is theirs, and maps each one to its Foundry actor — no manual roster setup. Voice-processing consent is requested per player and is withdrawable at any time. See [TDD 0023](./docs/tdd/0023-session-onboarding-presence-operator-channel.md).
- **Pulls a player aside, privately.** Private text is a Foundry whisper to that player — not a Discord DM. Discord DMs are the one-time consent prompt only; a leftover DM to the bot gets a courtesy redirect. See [TDD 0034](./docs/tdd/0034-surface-routing-and-io-abstraction.md) and [TDD 0035](./docs/tdd/0035-side-channels-via-foundry-whisper.md).
- **Driven from a console or from Foundry chat.** A local operator console (`http://localhost:3000`) and `/skeinkeeper` Foundry chat commands (plus the existing Discord slash commands) offer the same controls — start/stop the session, pick the DM voice, tune Eagerness, claim the operator role — and stay in sync live. Setup snags the AI can't resolve in-fiction land in Foundry GM chat. See [ADR-0025](./docs/adr/0025-foundry-as-table-text-and-operator-surface.md).
- **Drives your Foundry VTT.** Switches the active scene/map as the party moves, and reads Foundry's authoritative mechanical state — character sheets, NPCs, tokens, the active scene — every turn. Table-text (public chat, whispers, GM rolls) goes through the first-party add-on. Combat, damage, fog, and token spawn are [TDD 0042](./docs/tdd/0042-foundry-mechanical-writes.md). See [TDD 0041](./docs/tdd/0041-first-party-foundry-addon.md) and [ADR-0029](./docs/adr/0029-first-party-foundry-addon.md).
- **Remembers your campaign.** On top of Foundry's authoritative state, Skeinkeeper keeps the AI-DM layer: quest flags the AI tracks, session transcripts, who said what three sessions ago, post-session summaries, and the audit trail of every tool call. See [TDD 0007](./docs/tdd/0007-foundry-as-source-of-truth.md).
- **Treats the dice with respect.** Open rolls stay open. The AI never fudges player rolls, death saves, or final-blow rolls. The fudging policy (described in [`behavior/default.md`](./behavior/default.md)) is narrow, secret, and exclusively for the players' benefit.
- **Stays out of your data.** Self-hosted; nothing leaves your machine except calls to the providers you've configured. Zero phone-home by default. See [`docs/PRIVACY.md`](./docs/PRIVACY.md).

## What it doesn't do

- **Ship commercial campaign content.** Commercial game content is operator-supplied from your own legally-acquired copy.
- **Lock you into a specific provider.** The LLM, voice, and VTT integrations sit behind plugin interfaces. Claude is the implemented LLM provider today; swapping in another is a plugin, not a rewrite.

## Documentation

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how the pieces fit together
- [`docs/INSTALL.md`](./docs/INSTALL.md) — setup and configuration
- [`docs/PRIVACY.md`](./docs/PRIVACY.md) — what data is stored, where, and how to delete it
- [`docs/adr/`](./docs/adr/) — architectural decision records
- [`behavior/default.md`](./behavior/default.md) — the AI DM's behavior spec (system prompt)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — for contributors

## Contributing

Skeinkeeper is open source under [Apache 2.0](./LICENSE). Contributions welcome via GitHub Issues and Pull Requests. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev environment, code conventions, and the TDD-first contribution flow.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).
