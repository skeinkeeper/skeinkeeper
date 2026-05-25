# Installing Skeinkeeper

This guide walks you through standing up a local Skeinkeeper instance for the pre-MVP alpha. You can run it from source via pnpm (`pnpm app:start`) or with `docker compose up`.

If you hit something this document doesn't cover, open a GitHub Issue.

## Prerequisites

You need:

- **Node.js 22 or later** (`node --version` to check).
- **pnpm 9 or later** (`npm install -g pnpm`).
- **ffmpeg** on your `PATH` (`ffmpeg -version`). The voice stack decodes/encodes audio through it; without it the bot connects but plays no sound. (`sudo apt install ffmpeg`, `brew install ffmpeg`, etc.)
- **A Discord bot** you've registered in your own [Discord developer account](https://discord.com/developers/applications). Skeinkeeper needs your bot's token; it never sees your Discord account password.
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
pnpm app:start
```

`pnpm app:start` runs the operator app — the Discord gateway + voice loop plus the local web console, served at `http://localhost:3000` (configurable via `SKEINKEEPER_WEB_PORT`).

To run tests:

```bash
pnpm test           # unit tests
pnpm eval           # scripted eval fixtures (deterministic, faked model)
pnpm eval:live      # run fixtures against the real model (needs ANTHROPIC_API_KEY)
pnpm lint           # eslint + prettier
pnpm type-check     # tsc --noEmit across the workspace
```

## Running the operator app

The operator app is the real entrypoint — the Discord gateway + voice loop plus
a local web console:

```bash
pnpm app:start
```

It serves the **operator console** at `http://localhost:3000`. From there you:

- **Start / Stop** a session (the bot joins/leaves your voice channel).
- Pick the **DM voice** from a curated persona list (you never see provider IDs).
- Set **Eagerness** (Reserved / Balanced / Eager) — changeable mid-session.
- Toggle **PvP** (off by default) — whether the DM resolves a private action against another player's character ([TDD 0026](./tdd/0026-player-dm-side-channels.md)).
- _(Optional)_ Watch the **live feed**: each respond/skip decision, the DM's turns, consent prompts.

During play you only need to watch **Foundry + Discord** — operator notes come to
you as Discord DMs (see "Operator notes" below), so the console's live feed is
optional observability, not something you have to babysit.

**Same controls from Discord.** Every operator control above is also a slash
command, and the two surfaces stay in sync live — change the DM voice in Discord
and the console reflects it without a refresh, and vice versa ([TDD 0025](./tdd/0025-operator-control-parity.md)):

- `/skeinkeeper session action:stop` — end the session.
- `/skeinkeeper eagerness level:reserved|balanced|eager`.
- `/skeinkeeper voice action:list` / `action:set persona:<name>`.
- `/skeinkeeper operator action:claim|clear|show` (see "Operator notes").
- `/skeinkeeper pvp action:on|off|show` — toggle player-vs-player (operator only; needs Manage Channel on the voice channel).

(Cold-_starting_ a session is console-only for now — the bot has to be online to
receive a slash command, and starting is what brings it online.)

**Before you click Start (pre-flight).** You ready the _world_; Skeinkeeper
onboards the _people_ live ([TDD 0023](./tdd/0023-session-onboarding-presence-operator-channel.md)).
Make sure:

- Foundry is running and the MCP bridge is reachable (or accept the mock fallback).
- The campaign's **player-characters exist in the Foundry world and are named** —
  Skeinkeeper maps players to actors that already exist; it never creates or
  renames a character.
- Players are invited to the Discord server and know to join the voice channel
  and accept the consent DM.

You do **not** need everyone in voice, introduced, or logged into Foundry before
you Start. People trickle in; on each conversational break the AI welcomes
newcomers, asks who they are and which character is theirs, confirms the mapping,
and gets going once folks have claimed in. An empty channel at Start stays
silent until someone joins.

**Player consent.** When a player joins the voice channel or first speaks, the
bot DMs them the consent text; they grant or withdraw with
`/skeinkeeper consent grant|withdraw` (or the buttons on the DM). Audio is not
transcribed until consent is granted. Note the consent text discloses that the
campaign's **shared memory** is not individually erasable ([ADR-0014](./adr/0014-episodic-memory-campaign-scoped-erasure.md)).

**Private side-channels.** A player can **DM the bot directly** for a side
question or a surprise action — the DM answers privately, and what's said stays
out of the other players' view ([TDD 0026](./tdd/0026-player-dm-side-channels.md)).
The DM keeps such things private by default and won't split the party or resolve
a private action against another character unless you've enabled **PvP**. As the
operator, you can review side-channel transcripts like any other session
content; "private" means private from the _other players_, not from _you_ (see
[PRIVACY.md](./PRIVACY.md)).

**Operator notes (Discord).** When the AI hits a setup snag it can't resolve
in-fiction — for example, a player claims a character that isn't in the world —
it DMs _you_. Players never see these notes. Designate yourself the operator any
of three ways ([TDD 0024](./tdd/0024-operator-self-designation.md)):

- **In Discord:** type `/skeinkeeper operator claim` — you become the operator;
  no IDs or usernames needed. (`clear` / `show` manage it.) `claim`/`clear`
  require the **Manage Channel** permission on the Skeinkeeper voice channel, so
  a random guild member can't hijack the setup DMs — grant it via the voice
  channel's permission settings (server admins already have it).
- **In the console (Operator panel):** while a session is running, pick yourself
  from the live voice-channel list ("This is me"), or type your Discord
  **@username** (findable in Settings → My Account — no Developer Mode). The list
  updates live as people join/leave.
- **In `.env` (fallback):** `DISCORD_OPERATOR_USER_ID=<your numeric user ID>`
  seeds a default for headless setups. A designation set via Discord or the
  console is persisted and takes precedence; if nothing is set anywhere, notes
  fall back to the server log (degraded).

**Operator login (optional).** To require a password for the console, generate a
hash and set `SKEINKEEPER_OPERATOR_PASSWORD_HASH`:

```bash
pnpm tsx -e "import('@skeinkeeper/app').then(m => console.log(m.hashPassword('your-password')))"
```

Without it, the console is open on localhost (fine for a single-operator box).

**Long-term memory.** On the first session, the local embedding model
(a few hundred MB) downloads and caches; that first run is slower. Episodic
summaries are written at session end and recalled in later sessions.

**Things that bite on first run** (all handled by the shipped versions, listed
so you can diagnose):

- **ffmpeg missing** → bot connects but is silent. Install it (see Prerequisites).
- **Discord voice / DAVE** → Discord requires its DAVE end-to-end-encryption
  protocol; we ship `@discordjs/voice` ≥ 0.19 (which bundles `@snazzah/davey`) so
  this works. An older version is rejected with close code 4017.
- **WSL2** → if you run under WSL, Discord voice works on the default NAT
  networking; mirrored mode is _not_ required.

> **Foundry.** Set `FOUNDRY_MCP_COMMAND` to the command that launches your OSS
> MCP bridge server — it speaks MCP over **stdio**, so the app spawns it. The
> app connects at session start and discovers your Foundry system. If it's
> unset, or the bridge can't be reached, the app falls back to a mock Foundry so
> a session can still run. The `McpFoundryClient` read/mutation surface and its
> mutation-gap findings are in [TDD 0014](./tdd/0014-mcp-foundry-client.md)
> — note the OSS bridge can't do a direct HP-set or a server-side roll, so some
> D&D mutations aren't available yet.

## Running with Docker

```bash
cp .env.example .env   # fill in tokens/keys
docker compose up
```

The `app` service builds the image, installs ffmpeg + the native deps, and serves
the console on `localhost:3000`. Your Foundry instance and the MCP bridge run
outside the container (on the host or their own services); the app reaches
Foundry through the bridge it spawns via `FOUNDRY_MCP_COMMAND`. Data persists in
the `./data` volume.

## Configuration

`.env.example` documents every variable Skeinkeeper reads. The required-for-alpha ones:

| Variable                                                      | Purpose                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`                                           | Your bot's token from the Discord developer portal.                                                                                                                                                                                                               |
| `FOUNDRY_URL`                                                 | Informational: the app connects via the MCP bridge (`FOUNDRY_MCP_COMMAND`), not this URL. Your bridge may use it in its own config.                                                                                                                               |
| `FOUNDRY_MCP_COMMAND`                                         | Command to launch the OSS MCP bridge server (spawned over stdio), e.g. `node /path/to/foundry-vtt-mcp/packages/mcp-server/dist/index.js`. Unset = mock Foundry.                                                                                                   |
| `FOUNDRY_MCP_PORT`                                            | Port the bridge uses for its own Foundry-module link. Default `31415`.                                                                                                                                                                                            |
| `ANTHROPIC_API_KEY`                                           | Your Anthropic API key (Claude).                                                                                                                                                                                                                                  |
| `ELEVENLABS_API_KEY`                                          | Your ElevenLabs API key (TTS).                                                                                                                                                                                                                                    |
| `DEEPGRAM_API_KEY`                                            | Your Deepgram API key (STT). Skip if using local Whisper.                                                                                                                                                                                                         |
| `DISCORD_GUILD_ID`                                            | The Discord server (guild) ID the bot operates in.                                                                                                                                                                                                                |
| `DISCORD_VOICE_CHANNEL_ID`                                    | The voice channel the bot joins.                                                                                                                                                                                                                                  |
| `DISCORD_OPERATOR_USER_ID`                                    | Optional **fallback** for the operator who gets setup DMs. Prefer `/skeinkeeper operator claim` or the console Operator panel — a designation set there is persisted and overrides this. Unset everywhere = notes fall back to the server log.                    |
| `SKEINKEEPER_DATA_DIR`                                        | Where Skeinkeeper stores its SQLite + LanceDB data. Defaults to `./data`.                                                                                                                                                                                         |
| `SKEINKEEPER_WEB_PORT`                                        | Operator console port. Defaults to `3000`.                                                                                                                                                                                                                        |
| `SKEINKEEPER_WEB_HOST`                                        | Operator console bind address. Defaults to `127.0.0.1` (localhost). Set `0.0.0.0` to expose it on your network — only if you understand the risk.                                                                                                                 |
| `ANTHROPIC_MODEL_NARRATION` / `ANTHROPIC_MODEL_ORCHESTRATION` | Optional model overrides; the provider's per-tier defaults apply when unset.                                                                                                                                                                                      |
| `SKEINKEEPER_CAMPAIGN_ID`                                     | Campaign identifier. Defaults to `default`.                                                                                                                                                                                                                       |
| `SKEINKEEPER_EAGERNESS`                                       | Default DM eagerness: `reserved` \| `balanced` \| `eager`. Defaults to `balanced`; tunable at runtime in the console.                                                                                                                                             |
| `ELEVENLABS_DM_VOICE_ID`                                      | Optional override for the DM voice (otherwise set via the console's persona picker).                                                                                                                                                                              |
| `SKEINKEEPER_OPERATOR_PASSWORD_HASH`                          | Optional. Set (via `hashPassword`) to require login to the console. Unset = open on localhost.                                                                                                                                                                    |
| `SKEINKEEPER_SESSION_SECRET`                                  | Optional HMAC secret for session cookies; a random one is used if unset (sessions reset on restart).                                                                                                                                                              |
| `SKEINKEEPER_SECRET_PASSPHRASE`                               | Optional. Passphrase that opens the sealed credential store (`secrets:seal`) **and** turns on per-column PII encryption at rest (`pii:encrypt`). Supply via your shell/host secret, **not** `.env`. Unset = secrets read from `.env` and PII stored as plaintext. |

### Sealing your secrets at rest (optional)

By default the bot token + provider keys are read from `.env`. To keep them encrypted at rest instead:

1. Export a passphrase in your shell (or inject it as a docker/systemd secret — keep it out of `.env`): `export SKEINKEEPER_SECRET_PASSPHRASE=…`.
2. Run `pnpm skeinkeeper secrets:seal` — it seals the secret values currently in your environment into `${SKEINKEEPER_DATA_DIR}/secrets.sealed` (AES-256-GCM).
3. Delete those plaintext lines from `.env`. At boot the app opens the sealed file and overlays the secrets; a present-but-unopenable file fails startup (no silent fallback).

Manage it with `secrets:status` (lists sealed key names), `secrets:rotate --new-passphrase <p>`, and `secrets:unseal [--remove]`. An OS-keyring key source is planned. See [ADR-0010](./adr/0010-privacy-as-architecture.md) and [TDD 0029](./tdd/0029-sealed-credential-store.md).

### Encrypting PII at rest (optional)

The same `SKEINKEEPER_SECRET_PASSPHRASE` also turns on **per-column encryption of personal data** (Discord IDs, display names, transcript text, audit payloads, operator settings) using AES-256-GCM ([ADR-0022](./adr/0022-pii-encryption-node-crypto.md), [TDD 0030](./tdd/0030-pii-column-encryption.md)). With the passphrase set, new writes are encrypted automatically. To encrypt a database that already has plaintext rows, run it once:

```bash
pnpm skeinkeeper pii:encrypt
```

It walks every PII table, encrypts the values, and backfills the salted-hash lookup companions; it's idempotent, so re-running is safe (and it's the migration step after `secrets:rotate`). Deletion and export (`player:delete`, `campaign:export`, …) keep working without the passphrase because they match on the hash companions — only reading PII back in plaintext needs the key. Without a passphrase, PII is stored as plaintext (the alpha default).

**Never commit `.env`.** It's already in `.gitignore`.

## Setting up the Discord bot

1. Create an application at https://discord.com/developers/applications.
2. Under **Bot**, generate a token; paste it into `.env` as `DISCORD_BOT_TOKEN`. Enable the _message content_, _server members_, and _voice state_ intents.
3. Under **OAuth2 → URL Generator**, select the `bot` and `applications.commands` scopes, plus the permissions: _View Channels_, _Send Messages_, _Read Message History_, _Connect_, _Speak_, _Use Voice Activity_. Use the generated URL to invite the bot to the server where your group plays.

## Setting up Foundry + the MCP bridge

You need Foundry VTT running and one of the OSS MCP bridges installed. The bridge connects to your Foundry instance and exposes its API over MCP to Skeinkeeper.

**For the `adambdooley` bridge (recommended):**

1. Install the _FoundryVTT MCP_ module in Foundry from the URL in the [bridge's README](https://github.com/adambdooley/foundry-vtt-mcp), and build its `mcp-server` package per its docs.
2. Set `FOUNDRY_MCP_COMMAND` to launch that server, e.g. `node /path/to/foundry-vtt-mcp/packages/mcp-server/dist/index.js`. Skeinkeeper spawns it over stdio; the server makes its own connection to the Foundry module (default port `FOUNDRY_MCP_PORT=31415`).

**For the `laurigates` bridge:**

1. Install the bridge's Foundry module.
2. Set `FOUNDRY_MCP_COMMAND` to the command that starts its MCP server (e.g. via `bunx`), if it speaks MCP over stdio.

Either bridge works with Skeinkeeper through the same `FoundryClient` interface (see [TDD 0007](./tdd/0007-foundry-as-source-of-truth.md)).

## Seeding your first campaign

Skeinkeeper expects a tenant and a campaign before it can do useful work. The alpha uses a YAML seed file:

```bash
cp data/seed.example.yaml data/seed.yaml
# edit data/seed.yaml — set your tenant name, campaign name, and the Foundry world name
pnpm tsx server/src/seed-cli.ts
```

The seed is idempotent — re-running it on an existing DB won't duplicate rows. Character sheets are _not_ in the seed file; they live in Foundry. See `data/seed.example.yaml` for the schema.

## Voice consent

When a player first joins a Skeinkeeper-monitored voice channel, the bot DMs them a consent flow before any audio is processed. The flow is described in `docs/PRIVACY.md`. As the operator, you don't need to configure anything for this to work — but make sure your players know it's coming so they don't dismiss it.

## What works in the alpha vs. what's coming

| Feature                                 |                            Alpha                            | v0.5 | v1.0+ |
| --------------------------------------- | :---------------------------------------------------------: | :--: | :---: |
| Local orchestrator + tool registry      |                             ✅                              |      |       |
| Foundry MCP integration                 | real (stdio bridge; some D&D mutations gated by the bridge) |  ✅  |       |
| Discord voice (STT/TTS)                 |                                                             |  ✅  |       |
| Web UI for state inspection / overrides |                           minimal                           |  ✅  |       |
| `docker compose` deployment             |                                                             |  ✅  |       |
| Multiple ruleset support beyond D&D 5e  |                                                             |      |  ✅   |
| Multiple VTT support beyond Foundry     |                                                             |      |  ✅   |

The alpha is meant for tinkering by people comfortable running TypeScript from source. The v0.5 milestone targets the friend-group-can-actually-play experience.

## Troubleshooting

**`pnpm app:start` errors with a `ConfigError` listing missing variables:** supply them in `.env`. The app refuses to start without the required tokens/keys (it lists every one that's missing).

**`pnpm install` is slow:** the workspace pulls a fair number of deps (Drizzle, vitest, eslint, etc.). First install takes a couple minutes; subsequent installs are fast.

**Foundry MCP bridge isn't responding:** confirm `FOUNDRY_MCP_COMMAND` points at a built bridge server and runs on its own (`node …/mcp-server/dist/index.js`), that Foundry is up with the bridge module connected (default port `31415`), and check the bridge's own logs. If the app logs "Foundry MCP bridge unavailable … using mock Foundry", the spawn or connect failed and it fell back to the mock.

**Tests fail with database errors:** Skeinkeeper uses an in-memory SQLite for unit tests. If you see "no such table," try `pnpm install` again and confirm the Drizzle migrations directory `server/drizzle/` is present.

**Anything else:** open a GitHub Issue with the failure mode and your environment (OS, Node version, pnpm version). Include redacted `.env` contents if a configuration question is involved.

## Where to go next

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — how the pieces fit together
- [`docs/PRIVACY.md`](./PRIVACY.md) — data handling and player rights
- [`behavior/default.md`](../behavior/default.md) — the AI DM's behavior spec
- [`docs/adr/`](./adr/) — architectural decision records
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — for contributors
