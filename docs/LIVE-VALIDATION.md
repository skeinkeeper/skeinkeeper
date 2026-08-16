# Live end-to-end validation playbook

A hands-on, checkbox-driven walkthrough that takes one operator from a clean
checkout to a full first session at a real table — exercising every capability
Skeinkeeper ships today against **live** Foundry, Discord voice, and real
LLM/voice providers.

Why this exists: the automated suite (`pnpm test`, `pnpm eval`) runs everything
against mocks and a faked model. It cannot prove the pieces work end-to-end
across five live external systems. This playbook is that proof. Completing it is
the alpha's real pass/fail gate — in particular it is where the Foundry
mechanical writes ([TDD 0042](./tdd/0042-foundry-mechanical-writes.md)) and the
Foundry-down session lifecycle ([TDD 0039](./tdd/0039-foundry-down-session-lifecycle.md))
get validated live for the first time, and where the 4-hour stability / latency
targets get measured instead of assumed.

## How to use it

- Work top to bottom. Each `- [ ]` is a check: **do the action, confirm the
  expected result, tick the box** (or note what actually happened).
- **Ref** points at the requirement/design each check validates, so a failure is
  traceable.
- Record results in the table at the end. A check that can't be run (missing
  asset, provider outage) is **BLOCKED**, not PASS.
- Do this with a real group where possible — voice diarization, onboarding, and
  side-channels only exercise properly with 3+ distinct Discord users.

## Read first: known gaps (so your results mean something)

These are expected to be rough or absent today — a failure here is **known**, not
a regression:

- **No code-level content classifier on AI utterances yet.** Safety today is
  prompt-level (`behavior/default.md`) plus the side-channel PvP guardrail. The
  `!pause` / "DM, pause" interrupt and Lines & Veils are behavior-driven, not
  enforced by a code gate. Test them (Phase 8), but do **not** rely on them as a
  hard safety boundary for this run; keep a human hand on the wheel.
- **D&D 5e only.** The mechanical writes are validated against the `dnd5e`
  system. Other systems fall back to raw HP writes or error — out of scope here.
- **Reactive ambient perception is a no-op in production.** The DM reads current
  Foundry state each turn (pull), but does not react between turns to changes you
  make directly in the Foundry UI (that's a v0.5 item). Drive changes through the
  DM, or expect a one-turn lag.
- **First live run will surface integration bugs.** That is the point. Log each
  one against the Ref and keep going where you can.

---

## Phase 0 — Assets & accounts you need

- [ ] **A machine** (Linux / macOS / Windows+Docker) that will run Skeinkeeper,
      Node 22+ and pnpm 9+ (or Docker), and **ffmpeg** on `PATH`. — Ref: INSTALL Prereqs
- [ ] **A Discord bot** registered in your own developer account, with its token,
      added to a server (guild) you control, with a voice channel for the game. — Ref: FR-V1
- [ ] **3+ Discord accounts** (you + players), each able to join that voice
      channel from their **own** client. Fully-remote, one person per client — no
      shared mic. — Ref: [ADR-0026](./adr/0026-fully-remote-all-individual-configuration.md)
- [ ] **A Foundry VTT instance you run**, **v13 or v14**, with a **D&D 5e** world
      you control (Lost Mine of Phandelver is the reference). Each player has their
      own Foundry user login. — Ref: FR-F1..F4, ADR-0026
- [ ] **A named PC actor per player** already in the world, each **owned by that
      player's Foundry user** (one owner each). — Ref: FR-F pre-flight, TDD 0036
- [ ] **Provider keys**: Anthropic (LLM), ElevenLabs (TTS), Deepgram (STT). — Ref: ADR-0004, FR-V2/V4

---

## Phase 1 — Install & configure

- [ ] Clone and install:
      ```bash
      git clone https://github.com/skeinkeeper/skeinkeeper.git
      cd skeinkeeper
      pnpm install
      cp .env.example .env
      ```
- [ ] Fill `.env`: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_VOICE_CHANNEL_ID`,
      `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, and `FOUNDRY_URL`.
      Leave `FOUNDRY_GATEWAY_BIND=loopback` for a same-machine Foundry. — Ref: INSTALL Configuration
- [ ] **(Recommended)** Set a stable `FOUNDRY_PAIRING_SECRET` in `.env`, or leave
      it blank to have one generated and persisted for you. — Ref: PR "pairing at boot"
- [ ] Run the workspace gates once to confirm a healthy tree:
      ```bash
      pnpm type-check && pnpm test && pnpm eval
      ```
      **Expected:** all green. — Ref: CI parity

---

## Phase 2 — Foundry world + add-on

- [ ] Copy or symlink `modules/skeinkeeper` into your Foundry Data `modules/`
      directory. — Ref: INSTALL "Setting up Foundry", ADR-0029
- [ ] In the world, enable **Skeinkeeper** (you'll set its gateway URL + pairing
      secret in Phase 3, once the app has printed the secret). — Ref: FR-F2
- [ ] Confirm only **one** GM session will run the add-on (a second GM window that
      enables it is rejected as `duplicate`). — Ref: TDD 0041

---

## Phase 3 — Offline pre-flight checks

Run these before involving the table — they isolate provider/config problems
from live-session problems.

- [ ] `pnpm check:voice` — **Expected:** the configured TTS/STT providers
      construct and authenticate. — Ref: FR-V9
- [ ] `pnpm check:discord-session` — **Expected:** the bot logs in and can see the
      guild + voice channel. — Ref: FR-V1
- [ ] `pnpm check:discord-speak` — **Expected:** the bot joins voice and plays a
      test utterance (you hear it). — Ref: FR-V4
- [ ] `pnpm check:discord-listen` — **Expected:** the bot captures + transcribes
      your speech (you see the transcript). — Ref: FR-V2
- [ ] **(Optional)** `pnpm eval:live` (needs `ANTHROPIC_API_KEY`) — behavior
      fixtures against the real model. — Ref: eval harness

---

## Phase 4 — Boot & pair & connect

- [ ] Start the app: `pnpm app:start` (or `docker compose up`). — Ref: INSTALL
- [ ] **On boot** the console logs the **pairing secret** and gateway URL (before
      you Start any session). Copy the secret. — Ref: PR "pairing at boot"
- [ ] In Foundry → Skeinkeeper add-on settings: set gateway URL
      `ws://127.0.0.1:7733` and paste the pairing secret. Reload the GM session.
      **Expected:** the add-on sends `hello` and the app logs it as connected. — Ref: TDD 0041
- [ ] Open the console at `http://localhost:3000`. **Expected:** it loads (and
      prompts for a password only if you set `SKEINKEEPER_OPERATOR_PASSWORD_HASH`). — Ref: FR operator console
- [ ] Click **Start** with the add-on **disabled/disconnected** on purpose.
      **Expected:** Start refuses within ~5 s with a clear message; the bot does
      **not** join voice (fail-closed, no mock). Then re-enable and Start
      succeeds. — Ref: FR-F6

---

## Phase 5 — The live session

Start a session (bot joins the voice channel). Then walk the matrix.

### A. Voice I/O, presence, and turn-taking

- [ ] With no one in the channel at Start, the bot stays **silent** until someone
      joins. — Ref: INSTALL pre-flight, FR onboarding
- [ ] Two+ players speak; the DM attributes utterances to the **right speaker**
      (per-Discord-user diarization). — Ref: FR-V2
- [ ] The DM's narration **starts speaking mid-generation** (about a sentence in),
      not after a long silence. — Ref: FR-V4, TDD 0028
- [ ] **Barge-in:** talk over the DM mid-sentence — it **stops** and yields. — Ref: FR-V5
- [ ] Distinct NPCs speak in **distinct voices**. — Ref: FR-V8, TDD 0017
- [ ] Change **Eagerness** (Reserved → Eager) and confirm the DM visibly speaks up
      more/less readily. — Ref: FR-V3
- [ ] **IC vs OOC:** an out-of-character aside (`!ooc …` / `((parenthetical))`) is
      treated as table-talk, not narration input. — Ref: FR-V6

### B. Consent & onboarding

- [ ] A player joining voice for the first time gets a **one-time consent DM**;
      audio is **not** transcribed until they accept. — Ref: FR-V7, ADR-0010
- [ ] A player runs `/skeinkeeper consent withdraw` — their audio stops being
      processed. — Ref: FR-V7
- [ ] As players trickle in, the DM **welcomes** each, asks which character is
      theirs, and confirms the mapping in-fiction — no manual roster setup. — Ref: TDD 0036
- [ ] Pre-flight identity: the 3-way **Discord ↔ Foundry user ↔ actor** mapping
      resolves for each player (each PC owned by exactly one Foundry user). Try a
      **mis-owned** actor and confirm it escalates to you (GM chat note). — Ref: TDD 0036

### C. Foundry perception

- [ ] The DM references the **current** scene, tokens, and a PC's actual sheet
      values (HP, etc.) — i.e. it reads live Foundry state each turn. — Ref: TDD 0007, FR-F
- [ ] The DM **switches the active scene** as the party moves (or on your cue) and
      the change shows in every player's Foundry. — Ref: `setActiveScene`, FR-F

### D. Mechanical writes — the combat crawl (TDD 0042)

Run an actual encounter. Confirm each write lands in Foundry for all players.

- [ ] **Spawn** a monster token from a compendium stat block onto the scene
      (`spawn_token` / `createActorFromCompendium`). — Ref: TDD 0042
- [ ] **Start combat** and **roll initiative**; the tracker populates and orders
      correctly (`start_combat`, `manageCombat`). — Ref: TDD 0042
- [ ] **Advance turns** (`next-turn` / `previous-turn`) — the tracker's active
      combatant moves. — Ref: TDD 0042
- [ ] **Apply damage** to a PC and to an NPC (`apply_damage`); HP updates on the
      sheet/token for everyone. — Ref: TDD 0042
- [ ] Drop a PC to 0 HP → **death saves** are tracked; confirm the DM does **not**
      fudge them (see E). — Ref: TDD 0042, ADR-0003
- [ ] **Reveal / reset fog** (`reveal_fog` / `reset_fog`) as the party explores. — Ref: TDD 0042
- [ ] **Move / hide / show** a token (`moveToken`, `updateToken`). — Ref: TDD 0042
- [ ] **End combat** (`end_combat`) — tracker clears. — Ref: TDD 0042

### E. Dice discipline

- [ ] Open player rolls resolve in **Foundry chat, visibly** to the table. — Ref: FR-F8, ADR-0003
- [ ] A DM/secret roll lands **GM-only** (players don't see it). — Ref: FR-F8
- [ ] A passive check (no roll called for) resolves without a visible roll. — Ref: dice engine
- [ ] The DM **never fudges** a player roll, a death save, or a final-blow roll —
      those stay honest even under the (narrow, secret) fudge policy. — Ref: behavior spec, ADR-0003

### F. Table text routing & side-channels

- [ ] Public narration reaches **all** players in Foundry chat. — Ref: FR-F7
- [ ] A **whisper** to one player is visible only to that player (and you, the
      GM). — Ref: FR-F7, TDD 0035
- [ ] A player **whispers the DM in Foundry** (a private question / a surprise
      action); the DM answers privately. A leftover **Discord DM** to the bot gets
      a one-time courtesy redirect to Foundry. — Ref: TDD 0034, TDD 0035
- [ ] **Anti-leak:** confirm the DM never reveals one player's private content (or
      a `gm` secret) to another player, even when asked. — Ref: ADR-0017
- [ ] **PvP off (default):** a private action targeting another PC is **refused**.
      Toggle **PvP on** and confirm it now resolves. — Ref: FR PvP, ADR-0026 §6

### G. Operator control parity (console ⇄ Foundry chat)

Every control must work from **both** the web console and Foundry `/skeinkeeper`
chat commands, and stay in sync live. Discord is **not** an operator surface.

- [ ] Change **DM voice** in the console → the change reflects when you
      `/skeinkeeper voice show` in Foundry chat, and vice versa (no refresh). — Ref: ADR-0028, TDD 0040
- [ ] `/skeinkeeper eagerness level:eager` in Foundry chat → the console's
      Eagerness updates live. — Ref: TDD 0040
- [ ] `/skeinkeeper pvp action:on|off|show` toggles PvP from chat; console
      reflects it. — Ref: TDD 0040
- [ ] `/skeinkeeper operator action:claim` in Foundry chat makes you the operator
      (requires **Manage Channel** on the voice channel); `clear` / `show` manage
      it. Also do it from the console Operator panel. — Ref: TDD 0024, ADR-0028
- [ ] `/skeinkeeper session action:stop` ends the session from chat. — Ref: TDD 0040
- [ ] **Operator notes:** trigger a setup snag the DM can't resolve in-fiction and
      confirm it posts a **GM-only** Foundry chat note (players never see it). — Ref: ADR-0025

### H. Safety (behavior-level today — see known gaps)

- [ ] Say the pause phrase (`!pause` / "DM, pause") → the DM pauses cleanly. — Ref: FR-S1
- [ ] Set a **Line / Veil** and confirm the DM respects it in the fiction. — Ref: FR-S2
- [ ] Note explicitly that the **code-level content classifier (FR-S3) is not yet
      implemented** — record this as a known gap, not a pass. — Ref: FR-S3 (pending)

---

## Phase 6 — Failure-mode & recovery tests

- [ ] **Barge-in under load:** interrupt a long narration during combat — DM
      yields promptly. — Ref: FR-V5
- [ ] **Foundry-down → pause (TDD 0039):** with a session running, **kill the
      Foundry process** (or drop its network). **Expected:** the session **pauses**
      with state preserved, you get an operator notification, and player input is
      buffered (no crash, no silent continue). — Ref: TDD 0039, FR-R1
- [ ] **Add-on auto-reconnect:** bring Foundry back up. **Expected:** the add-on
      **re-dials the gateway on its own** — no manual GM reload required. — Ref: PR "add-on auto-reconnect"
- [ ] **Operator resume + replay:** resume the session from the console/chat.
      **Expected:** it comes back and **buffered input replays** in order. — Ref: TDD 0039
- [ ] **Pairing survives restart:** stop the app (Ctrl-C) and `pnpm app:start`
      again. **Expected:** the **same** pairing secret is printed (no re-pair
      needed) when `FOUNDRY_PAIRING_SECRET` was left unset. — Ref: PR "pairing at boot"

---

## Phase 7 — Memory & continuity

- [ ] End the session cleanly. Start a **new** session for the same campaign.
      **Expected:** the DM recalls prior events / who did what, and a post-session
      summary exists. — Ref: TDD 0007, four-tier memory
- [ ] Ask the DM about something from **earlier in the first session** — it
      remembers. — Ref: episodic memory (TDD 0019)

> Note: a session-start **recap** and end-of-session "wrap by N minutes" pacing
> (FR-E4) are **not** implemented yet; only a post-session summary exists. Record
> as a known gap.

---

## Phase 8 — Data rights & teardown

- [ ] **Per-player export:** `pnpm skeinkeeper player:export --tenant <t> …` returns
      that player's data. — Ref: PRIVACY, TDD 0038
- [ ] **Per-player erasure:** `pnpm skeinkeeper player:delete --tenant <t> …`
      removes that player's individual data across SQLite + LanceDB. — Ref: TDD 0038, ADR-0017
      - Note: the **offline CLI** records the Foundry-whisper cascade as
        *addon-unavailable* (it can't reach a live Foundry). In-session erasure
        cascades to Foundry whisper history; the offline path is DB-only. Confirm
        the DB rows are gone and the cascade is logged as pending. — Ref: TDD 0038
- [ ] **Per-campaign erasure:** `pnpm skeinkeeper campaign:delete --tenant <t> …`
      clears the campaign's shared memory. — Ref: ADR-0014
- [ ] **Consent-withdrawal effect persists:** a withdrawn player stays untranscribed
      on a later session until they re-consent. — Ref: FR-V7

---

## Phase 9 — Stability & latency (NFR-4)

- [ ] Run a **full encounter / most of a session** (aim for a multi-hour sitting).
      Watch for crashes, memory growth, or context overflow. — Ref: NFR-4
- [ ] **Voice latency feels right:** first audio within a few seconds of a turn;
      no dead air on think-time (a natural beat covers it). — Ref: TDD 0028 (targets ≤3 s / ≤6 s p95)
- [ ] **Foundry ops feel immediate:** writes (damage, tokens, tracker) land within
      ~1 s. — Ref: NFR-4 (≤1 s p95)

---

## Phase 10 — Verdict

- [ ] **Alpha bar:** the table completed a real encounter (ideally a full LMoP
      chapter across sessions) and the humans say it was **fun and worth using**. — Ref: alpha success criterion

### Results

| Phase / check | Result (PASS / FAIL / BLOCKED) | Notes (what actually happened, Ref) |
| ------------- | ------------------------------ | ----------------------------------- |
|               |                                |                                     |

**Blocking failures found:**

**Known gaps confirmed (expected):** FR-S3 classifier absent · non-dnd5e out of scope · reactive perception (FR-O5) v0.5 · recap/pacing (FR-E4) absent

---

## Appendix — quick reference

**Pre-flight checks:** `pnpm check:voice` · `check:discord-session` · `check:discord-speak` · `check:discord-listen` · `pnpm eval:live`

**Operator commands (Foundry chat):** `/skeinkeeper session action:stop` · `eagerness level:reserved|balanced|eager` · `voice action:list|set persona:<name>|show` · `operator action:claim|clear|show` · `pvp action:on|off|show`. Players: `/skeinkeeper consent grant|withdraw`.

**Data-rights CLI:** `pnpm skeinkeeper player:export|player:delete|campaign:delete|tenant:delete --tenant <id> …` · `pnpm skeinkeeper --help`

**Docs:** [INSTALL](./INSTALL.md) · [ARCHITECTURE](./ARCHITECTURE.md) · [PRIVACY](./PRIVACY.md) · [ADRs](./adr/) · [behavior spec](../behavior/default.md)
