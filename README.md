<p align="center">
  <img src="./branding/wordmark.png" alt="Skeinkeeper" width="720">
</p>

> _Wyrd bið ful aræd._ — Old English: "Fate remains wholly inexorable."

**Skeinkeeper** is a self-hosted AI Dungeon Master for your friend group's tabletop RPG sessions. It joins your Discord voice channel, speaks aloud in distinct character voices, autonomously operates Foundry VTT (maps, tokens, combat, dice), and maintains persistent campaign state across sessions.

The target setup: four to six friends, some in-person, some remote over Discord voice. Skeinkeeper runs the DM side so the humans can focus on playing.

## Status

**Pre-MVP alpha.** The founder's table is running Lost Mine of Phandelver as the reference deployment. Public beta target: v0.5. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for what's built and what's planned.

## What you need

To run Skeinkeeper, you need:

- A machine to run it on (Linux, macOS, or Windows with Docker)
- A Discord account, with a [bot you've registered](https://discord.com/developers/applications) in your own Discord developer account
- A Foundry VTT instance (self-hosted or via The Forge) with a Foundry MCP bridge installed. We recommend [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) (fully OSS, no API keys); [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp) is supported as a simpler alternative. See [ADR-0011](./docs/adr/0011-prefer-oss-foundry-mcp-bridges.md).
- An API key for an LLM provider (Anthropic Claude recommended; OpenAI also supported)
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

- **Runs the DM side of a tabletop RPG session.** Narrates scenes, voices NPCs, manages combat, calls for rolls, adjudicates rules, tracks state.
- **Joins your Discord voice channel** and speaks aloud. Per-NPC voice profiles. Configurable wake-word.
- **Operates Foundry VTT autonomously** — moves tokens, manages combat tracker, rolls dice, reveals fog, switches scenes.
- **Remembers your campaign.** Foundry remains authoritative for the mechanical state of your campaign — character sheets, NPCs, scenes — and Skeinkeeper adds the AI-DM layer on top: quest flags the AI tracks, session transcripts, who said what three sessions ago, post-session summaries, and the audit trail of every tool call. See [design doc 0007](./docs/design/0007-foundry-as-source-of-truth.md).
- **Treats the dice with respect.** Open rolls stay open. The AI never fudges player rolls, death saves, or final-blow rolls. The fudging policy (described in [`behavior/default.md`](./behavior/default.md)) is narrow, secret, and exclusively for the players' benefit.
- **Stays out of your data.** Self-hosted; nothing leaves your machine except calls to the providers you've configured. Zero phone-home by default. See [`docs/PRIVACY.md`](./docs/PRIVACY.md).

## What it doesn't do

- **Ship commercial campaign content.** Commercial game content is operator-supplied from your own legally-acquired copy.
- **Lock you into a specific provider.** LLM, voice, and VTT integrations are pluggable. Use Claude, GPT, Gemini, Grok, or whichever provider you prefer.

## Documentation

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how the pieces fit together
- [`docs/INSTALL.md`](./docs/INSTALL.md) — setup and configuration
- [`docs/PRIVACY.md`](./docs/PRIVACY.md) — what data is stored, where, and how to delete it
- [`docs/adr/`](./docs/adr/) — architectural decision records
- [`behavior/default.md`](./behavior/default.md) — the AI DM's behavior spec (system prompt)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — for contributors

## Contributing

Skeinkeeper is open source under [Apache 2.0](./LICENSE). Contributions welcome via GitHub Issues and Pull Requests. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev environment, code conventions, and the design-doc-first contribution flow.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).
