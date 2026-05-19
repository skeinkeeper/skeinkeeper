# Installing Skeinkeeper

This guide walks you through standing up a local Skeinkeeper instance for the pre-MVP alpha. The alpha runs from source via pnpm; a `docker compose` flow is planned for v0.5.

If you hit something this document doesn't cover, open a GitHub Issue.

## Prerequisites

You need:

- **Node.js 22 or later** (`node --version` to check).
- **pnpm 9 or later** (`npm install -g pnpm`).
- **A Discord bot** you've registered in your own [Discord developer account](https://discord.com/developers/applications). Skeinkeeper needs your bot's token and application ID; it never sees your Discord account password.
- **A Foundry VTT instance** (self-hosted or via The Forge), with one of the OSS Foundry MCP bridges installed and running. See [ADR-0011](./adr/0011-prefer-oss-foundry-mcp-bridges.md):
  - **Default:** [`adambdooley/foundry-vtt-mcp`](https://github.com/adambdooley/foundry-vtt-mcp) — Foundry module + Node MCP server, both MIT, fully self-hosted, no API key.
  - **Simpler alternative:** [`laurigates/foundryvtt-mcp`](https://github.com/laurigates/foundryvtt-mcp) — single standalone server via `bunx`.
- **An API key for an LLM provider.** Anthropic Claude is the default; OpenAI and others land in v2+.
- **An API key for a TTS provider** (ElevenLabs recommended) and **an STT provider** (Deepgram recommended). Local Whisper is also supported for STT.

All provider costs are paid directly to those providers by you. Skeinkeeper itself is free.

## Quick start (alpha, from source)

```bash
git clone https://github.com/skeinkeeper/skeinkeeper.git
cd skeinkeeper
pnpm install
cp .env.example .env
# edit .env with your tokens and API keys (see "Configuration" below)
pnpm dev
```

`pnpm dev` runs the orchestrator and the local web UI under watch mode. The web UI is served at `http://localhost:3000` (configurable via `SKEINKEEPER_WEB_PORT`).

To run tests:

```bash
pnpm test           # unit tests
pnpm eval           # behavior eval fixtures
pnpm lint           # eslint + prettier
pnpm type-check     # tsc --noEmit across the workspace
```

## Configuration

`.env.example` documents every variable Skeinkeeper reads. The required-for-alpha ones:

| Variable | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Your bot's token from the Discord developer portal. |
| `DISCORD_APPLICATION_ID` | Your bot's application ID. Used for slash-command registration. |
| `FOUNDRY_URL` | The URL of your Foundry instance (e.g., `http://localhost:30000`). |
| `FOUNDRY_MCP_URL` | The URL of your Foundry MCP bridge server (default: `http://localhost:3001` for adambdooley's bridge). |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (Claude). |
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key (TTS). |
| `DEEPGRAM_API_KEY` | Your Deepgram API key (STT). Skip if using local Whisper. |
| `SKEINKEEPER_DATA_DIR` | Where Skeinkeeper stores its SQLite + LanceDB data. Defaults to `./data`. |
| `SKEINKEEPER_WEB_PORT` | Local web UI port. Defaults to `3000`. |

Secrets in `.env` are loaded at startup and (when persisted) stored in the OS keyring (libsecret on Linux, Keychain on macOS, Credential Manager on Windows). On systems without a keyring, a libsodium-sealed config file is used as fallback. See [ADR-0010](./adr/0010-privacy-as-architecture.md).

**Never commit `.env`.** It's already in `.gitignore`.

## Setting up the Discord bot

1. Create an application at https://discord.com/developers/applications.
2. Under **Bot**, generate a token; paste it into `.env` as `DISCORD_BOT_TOKEN`. Enable the *message content*, *server members*, and *voice state* intents.
3. Under **General Information**, copy the *Application ID* into `.env` as `DISCORD_APPLICATION_ID`.
4. Under **OAuth2 → URL Generator**, select the `bot` and `applications.commands` scopes, plus the permissions: *View Channels*, *Send Messages*, *Read Message History*, *Connect*, *Speak*, *Use Voice Activity*. Use the generated URL to invite the bot to the server where your group plays.

## Setting up Foundry + the MCP bridge

You need Foundry VTT running and one of the OSS MCP bridges installed. The bridge connects to your Foundry instance and exposes its API over MCP to Skeinkeeper.

**For the `adambdooley` bridge (recommended):**

1. Install the *FoundryVTT MCP* module in Foundry from the URL in the [bridge's README](https://github.com/adambdooley/foundry-vtt-mcp).
2. Run the bridge's Node MCP server on the same host (see the bridge's setup docs).
3. Point `FOUNDRY_MCP_URL` in your `.env` at the server's URL.

**For the `laurigates` bridge:**

1. Install the bridge's Foundry module.
2. Run `bunx foundryvtt-mcp` to start the server.
3. Point `FOUNDRY_MCP_URL` at the server's URL.

Either bridge works with Skeinkeeper through the same `FoundryClient` interface (see [design doc 0007](./design/0007-foundry-as-source-of-truth.md)).

## Seeding your first campaign

Skeinkeeper expects a tenant and a campaign before it can do useful work. The alpha uses a YAML seed file:

```bash
cp data/seed.example.yaml data/seed.yaml
# edit data/seed.yaml — set your tenant name, campaign name, and the Foundry world name
pnpm tsx server/src/seed-cli.ts
```

The seed is idempotent — re-running it on an existing DB won't duplicate rows. Character sheets are *not* in the seed file; they live in Foundry. See `data/seed.example.yaml` for the schema.

## Voice consent

When a player first joins a Skeinkeeper-monitored voice channel, the bot DMs them a consent flow before any audio is processed. The flow is described in `docs/PRIVACY.md`. As the operator, you don't need to configure anything for this to work — but make sure your players know it's coming so they don't dismiss it.

## What works in the alpha vs. what's coming

| Feature | Alpha | v0.5 | v1.0+ |
|---|:-:|:-:|:-:|
| Local orchestrator + tool registry | ✅ | | |
| Foundry MCP integration | partial (Mock client only) | ✅ | |
| Discord voice (STT/TTS) | | ✅ | |
| Web UI for state inspection / overrides | minimal | ✅ | |
| `docker compose` deployment | | ✅ | |
| Multiple ruleset support beyond D&D 5e | | | ✅ |
| Multiple VTT support beyond Foundry | | | ✅ |

The alpha is meant for tinkering by people comfortable running TypeScript from source. The v0.5 milestone targets the friend-group-can-actually-play experience.

## Troubleshooting

**`pnpm dev` errors on startup with "missing DISCORD_BOT_TOKEN":** edit `.env` and supply the variable. The orchestrator refuses to start without it.

**`pnpm install` is slow:** the workspace pulls a fair number of deps (Drizzle, vitest, eslint, etc.). First install takes a couple minutes; subsequent installs are fast.

**Foundry MCP bridge isn't responding:** confirm the bridge's Node server is running (default port `3001`), then verify `FOUNDRY_MCP_URL` in `.env` matches. The bridge's own logs are the next thing to check.

**Tests fail with database errors:** Skeinkeeper uses an in-memory SQLite for unit tests. If you see "no such table," try `pnpm install` again and confirm the Drizzle migrations directory `server/drizzle/` is present.

**Anything else:** open a GitHub Issue with the failure mode and your environment (OS, Node version, pnpm version). Include redacted `.env` contents if a configuration question is involved.

## Where to go next

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — how the pieces fit together
- [`docs/PRIVACY.md`](./PRIVACY.md) — data handling and player rights
- [`behavior/default.md`](../behavior/default.md) — the AI DM's behavior spec
- [`docs/adr/`](./adr/) — architectural decision records
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — for contributors
