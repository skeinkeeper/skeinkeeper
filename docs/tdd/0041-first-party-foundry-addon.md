# TDD 0041: First-party Foundry add-on, gateway, and table-text client

Status: draft
PRD refs: 4.2 (FR-F2, FR-F3, FR-F4, FR-F5, FR-F6, load-bearing table-text 1–5), 4.1, 5.2, 5.3, 5.5, 5.8
PRD-rev: 5c3a198
ADR constraints: 0003, 0008, 0009, 0010, 0012, 0017, 0018, 0023, 0025, 0029, 0030
Supersedes: [TDD 0014](./0014-mcp-foundry-client.md), [TDD 0037](./0037-bridge-dependencies-surface-model-critical-batch.md)
Author: maintainers
Date: 2026-08-15
Related TDDs: [0007](./0007-foundry-as-source-of-truth.md), [0020](./0020-operator-app.md), [0034](./0034-surface-routing-and-io-abstraction.md), [0039](./0039-foundry-down-session-lifecycle.md), [0042](./0042-foundry-mechanical-writes.md)

## Approach

Skeinkeeper ships a Foundry add-on (`modules/skeinkeeper`). The operator enables
it in their world and points it at the Skeinkeeper process they already run.
The add-on dials **out** over WebSocket. Skeinkeeper listens. That is the only
Foundry integration.

This TDD replaces the MCP client ([TDD 0014](./0014-mcp-foundry-client.md)) and
the withdrawn upstream/fork plan ([TDD 0037](./0037-bridge-dependencies-surface-model-critical-batch.md)).
`FoundryClient` stays the orchestrator seam. Production Start never constructs
`MockFoundryClient`. Reads already on `FoundryClient` plus the table-text
methods TDD 0034/0035/0036/0038/0040 need are implemented here. Combat, damage,
fog, and token spawn are [TDD 0042](./0042-foundry-mechanical-writes.md).

**Foundry API locus (PRD conflict, resolved).** Foundry exposes `game`,
`ChatMessage`, `Roll`, and `Combat` on a connected **GM session**, not as a
headless host daemon. Resolution: the add-on attaches in the operator's GM
session on the Foundry instance they run (they already have that window open
per ADR-0025). Player clients must not open a gateway. Last GM disconnect is
Foundry-down (TDD 0039 / FR-F6). A world with zero GM users connected is
unreachable. True zero-client headless is a non-goal at v13/v14.

## Components & interfaces

### Add-on package (`modules/skeinkeeper`)

`module.json`:

- `id`: `skeinkeeper`
- `title`: Skeinkeeper
- `compatibility`: `{ minimum: "13", verified: "14", maximum: "14" }`
- `esmodules`: `["scripts/main.mjs"]`
- `socket`: false
- Apache-2.0. No phone-home URL.

World settings (GM only): `gatewayUrl` (default `ws://127.0.0.1:7733`),
`pairingSecret` (empty default). A settings form writes those two fields.

`scripts/main.mjs` runs only when `game.user.isGM` is true. On `ready` it
opens the WebSocket, sends `hello`, and dispatches `req` methods against
Foundry's API. Player users load the package and do nothing.

### Gateway listener

`FoundryGateway` binds a WebSocket server.

| Setting | Default | Env |
| --- | --- | --- |
| bind | `127.0.0.1` | `FOUNDRY_GATEWAY_BIND=loopback` or `lan` |
| port | `7733` | `FOUNDRY_GATEWAY_PORT` |
| pairing secret | generated at first boot, shown on the console | `FOUNDRY_PAIRING_SECRET` |

`lan` bind is refused unless a non-empty pairing secret is configured
**and** TLS is enabled (`FOUNDRY_GATEWAY_TLS_CERT` + `FOUNDRY_GATEWAY_TLS_KEY`;
add-on URL must be `wss://`). Pairing is authorization, not confidentiality;
PRD §5.5 requires TLS 1.3 on any network-facing surface. `loopback` is
`ws://` without TLS. A non-loopback peer without a matching secret is closed
after `hello-reject { code: "unauthorized" }`. `lan` bind without certs is
refused at process start.

`FOUNDRY_MCP_COMMAND` and `FOUNDRY_MCP_PORT` are removed from `loadConfig`.

### Protocol (JSON text frames, protocol `1`)

```
hello        { type:"hello", moduleId:"skeinkeeper", foundryVersion:string, worldId:string, pairingSecret?:string }
hello-ok     { type:"hello-ok", protocol:1 }
hello-reject { type:"hello-reject", code:"version"|"unauthorized"|"duplicate", message:string }
req          { type:"req", id:string, method:string, params:object }
res          { type:"res", id:string, ok:true, result:unknown } | { type:"res", id:string, ok:false, error:{ code:string, message:string } }
evt          { type:"evt", event:"chat"|"gone", payload:unknown }
```

`foundryVersion` must start with `13.` or `14.` (FR-F3). Otherwise
`hello-reject { code:"version" }`. A second GM `hello` while one session is
live is `duplicate`; the existing session stays. Unknown JSON is ignored
(log + count), never thrown through the gateway.

`evt chat` payload: `{ foundryUserId, text, isWhisper, recipients?: string[], timestamp }`.
`evt gone` fires when the socket closes; TDD 0039 treats it as Foundry-down.
The `event` union is additive. TDD 0041 ships `chat` and `gone`. Scene, token,
combat, actor, and journal events are [TDD 0033](./0033-live-state-perception-and-triggered-actions.md)
on this same channel — they are not a third-party connector feature.

### `FoundryClient` additions (additive on TDD 0007)

```ts
postChatMessage(args: {
  content: string;
  mode: "public" | "gm" | "whisper";
  whisperTo?: ReadonlyArray<string>;
  speaker?: { actor?: string; alias?: string };
}): Promise<{ messageId: string }>;

rollDice(formula: string, opts?: {
  mode?: "public" | "gm" | "blind" | "whisperTo";
  whisperTo?: ReadonlyArray<string>;
  flavor?: string;
  speaker?: string;
}): Promise<{ total: number; rolls: ReadonlyArray<number>; formula: string; messageId?: string }>;

deleteChatMessages(args: {
  scope: "by-author" | "by-recipient" | "by-time-range";
  authorFoundryUserId?: string;
  recipientFoundryUserId?: string;
  since?: string;
  until?: string;
}): Promise<{ deletedCount: number }>;

subscribeChatEvents(handler: (event: {
  foundryUserId: string;
  text: string;
  isWhisper: boolean;
  recipients?: ReadonlyArray<string>;
  timestamp: string;
}) => void): () => void;

listUsers(): Promise<ReadonlyArray<{
  id: string;
  name: string;
  role: "GAMEMASTER" | "ASSISTANT" | "TRUSTED" | "PLAYER";
}>>;
```

Existing read/write methods (`listPartyActors`, `getActor`, `getActiveScene`,
`listScenes`, `listSceneActors`, `applyActorUpdate`, `setActiveScene`) are
re-implemented as `req` methods with the same names. `applyActorUpdate`
supports condition and token-position updates in this TDD; HP writes are TDD 0042.

`ModuleFoundryClient.connect(gateway)` becomes ready only after `hello-ok`.
Each method is `req`/`res` with a 5s timeout (`error.code = "timeout"`).

### Production Start (FR-F6)

`createApp` / session Start:

1. Start `FoundryGateway` if not already listening.
2. Wait up to 5s for `hello-ok`.
3. On success, build `ModuleFoundryClient` and continue Start.
4. On timeout, version reject, or unauthorized: **do not Start**. The console
   and any Foundry GM chat already connected show the reason. The Discord bot
   does not join voice. `MockFoundryClient` is not constructed.

Tests inject `MockFoundryClient` at the `FoundrySource` seam. Eval does the
same. There is no env var that selects the mock in the operator app.

### Add-on method dispatch (Foundry API)

| `method` | Foundry call |
| --- | --- |
| `listPartyActors` | `game.actors` filtered to player-owned characters |
| `getActor` | `game.actors.get` |
| `getActiveScene` / `listScenes` / `setActiveScene` | `game.scenes` |
| `listSceneActors` | active scene tokens → actors |
| `applyActorUpdate` | `token.toggleEffect` / `token.document.update` for position |
| `postChatMessage` | `ChatMessage.create` with whisper / GM / public style (v13/v14 shim) |
| `rollDice` | `new Roll(formula).toMessage({ rollMode })` |
| `deleteChatMessages` | `ChatMessage.deleteDocuments` filtered by speaker/whisper/time |
| `listUsers` | `game.users` mapped to the role enum |

Chat subscribe: `Hooks.on("createChatMessage")` → `evt chat`. The add-on
must not echo Skeinkeeper-authored messages back as player input (tag
messages with `flags.skeinkeeper.echo = true` and drop those in the hook).

## Data & state

No new Skeinkeeper tables. Pairing secret lives in the sealed credential
store (TDD 0029) and is displayed on the console. The add-on stores only
world settings (`gatewayUrl`, `pairingSecret`) in Foundry. Chat messages
stay in Foundry (ADR-0018).

**Build order.** This TDD is next. Do not implement [TDD 0039](./0039-foundry-down-session-lifecycle.md), [TDD 0040](./0040-operator-control-parity-foundry-chat-commands.md), or [TDD 0042](./0042-foundry-mechanical-writes.md) until this TDD has landed. Those drafts consume `evt gone`, `subscribeChatEvents`, and add-on `req` methods that do not exist until this transport exists.

## Sequencing / implementation plan

1. Add `FoundryClient` table-text methods and keep `MockFoundryClient` compiling.
2. Implement `FoundryGateway` hello/pairing/version/bind + unit tests with a fake socket.
3. Implement `ModuleFoundryClient` `req`/`res` mapping + timeout.
4. Author `modules/skeinkeeper` (`module.json` + `main.mjs` dispatch + echo tag).
5. Rewire `foundry_source.ts` / `loadConfig`: drop MCP env, fail-closed Start, console shows pairing secret and listen address.
6. Update INSTALL: enable add-on, set URL, v13/v14, same-machine default, LAN opt-in.

## Failure modes & edge cases

**Real risks**

- Add-on never connects (disabled, wrong URL, Foundry down). 5s timeout, fail-closed, named message. No hang.
- GM closes Foundry mid-session. `evt gone` → TDD 0039 pause. No voice-only.
- LAN bind without a secret. Gateway refuses to listen; console says so.
- v13 vs v14 chat style constants differ. Shim in `main.mjs`; one unit fixture per major.
- Player client somehow sends `hello`. Reject unless `game.user.isGM`.
- Echo loop (our `postChatMessage` re-enters subscribe). `flags.skeinkeeper.echo` drop.

**Overblown risks**

- "Need MCP for Claude Desktop compatibility." The LLM never sees this protocol.
- "Need two add-ons (ours + the old bridge)." FR-F2 forbids that path.

**Unspoken risks**

- A second GM user in the same world opening a second add-on connection.
  `duplicate` reject keeps a single session; the operator must pick one GM
  window. Documented in INSTALL.

## Verification plan

Observable surface: Start result, console text, Foundry chat, `FoundryClient` returns.

| Observation point | PASS |
| --- | --- |
| Start with add-on disabled | Start refuses within 5s; message names the add-on; Discord bot does not join voice |
| Start with add-on at `ws://127.0.0.1:7733` | Start succeeds; `getActiveScene()` matches the world |
| `hello` with `foundryVersion: "12.331"` | `hello-reject code=version`; Start refuses; message names the version |
| Non-loopback connect, empty secret | `hello-reject code=unauthorized`; Start refuses |
| `FOUNDRY_GATEWAY_BIND=lan` without TLS cert/key | process refuses to listen; console names TLS |
| Non-loopback connect, matching secret, `wss://` | `hello-ok`; Start can succeed |
| `postChatMessage({ mode:"public", content:"X" })` | Every player's Foundry public chat shows `X` |
| `postChatMessage({ mode:"whisper", whisperTo:[u] })` | Only user `u` (and GM view) sees it |
| `postChatMessage({ mode:"gm", content:"Y" })` | A player client does not show `Y` |
| Player types "I search the room" in public chat | `subscribeChatEvents` fires with that text and that user's id; our own posts do not fire |
| `rollDice("1d20", { mode:"gm" })` | A player client does not show the roll; result.total is a number |
| Production `createApp` with gateway down | no `MockFoundryClient` instance is constructed |

## Evaluation rubric

| Criterion | High-quality | Acceptable | Failing |
| --- | --- | --- | --- |
| Requirement traceability | Every in-scope FR/NFR maps to a named interface, type, or step | One mapping is slightly coarse but still findable | An in-scope FR has no row, or the row is "handled in code" |
| Interface concreteness | Method names, args, return types, and error cases are specified | Types are named; one edge payload is implied | "the module talks to Skeinkeeper" with no message or method shape |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason | No new dep, and the section says why | New dep with empty or "none considered" analysis |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named | Observable but one scenario is console-only | Non-actionable plan (no surface, no observation point) |
| Scope-bound adherence | Touched files ≤8, body ≤500, per-file estimates present | One justified exception marker | Silent over-bound or missing Touched files / Expected diff |
| Naming consistency | FoundryClient methods, gateway messages, and add-on id match across 0041, 0042, and revised drafts | One leftover "bridge" in a revised draft, clearly historical | 0041 and 0034 disagree on a method or event name |

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
| --- | --- | --- |
| FR-F2 | Foundry support ships with Skeinkeeper | `modules/skeinkeeper` + INSTALL |
| FR-F3 | Foundry v13 and v14 | `hello` version check; `module.json` compatibility |
| FR-F4 | Operator-controlled infrastructure | default loopback bind; INSTALL; no hosted-Foundry path |
| FR-F5 | Unauthorized Foundry refused | pairing secret on non-loopback; `hello-reject unauthorized` |
| FR-F6 | Missing/unreachable Foundry fails closed | 5s wait; no mock in production Start |
| 4.2 table-text 1 | AI text in the right Foundry chat | `postChatMessage` modes |
| 4.2 table-text 2 | AI/GM rolls with intended visibility | `rollDice` modes |
| 4.2 table-text 3 | Erasure deletes Foundry whispers | `deleteChatMessages` (caller is TDD 0038) |
| 4.2 table-text 4 | Typed `/skeinkeeper` commands work | `evt chat` → TDD 0040 parser |
| 4.2 table-text 5 | Player Foundry chat is table input | `subscribeChatEvents` / `evt chat` |
| 4.1 | Player text lives in Foundry | same subscribe path |
| 5.3 | Foundry op ≤ 1s p95 | 5s is the fail timeout; happy-path is a local WS call |
| 5.5 | Add-on does not phone home | no outbound URL in `module.json` except operator-set gateway |
| 5.8 | Foundry-down pauses | `evt gone` → TDD 0039 |

## Dependencies considered

- **Chosen:** `ws` (MIT) in `plugins/vtt-foundry` for the gateway server. One
  channel for hello, req/res, and events.
- **Rejected:** `@modelcontextprotocol/sdk` — that is the withdrawn third-party
  connector protocol.
- **Rejected:** HTTP POST + SSE — two channels, two pairing surfaces, more
  fail-closed cases.
- **Rejected:** raw `http` upgrade without `ws` — more handshake code to get
  wrong; `ws` is the Node standard and MIT.
- Remove `@modelcontextprotocol/sdk` from `plugins/vtt-foundry` when this TDD
  lands.

## PRD conflicts surfaced (and resolution)

1. **FR-F4/operator LAN vs Foundry's GM-session API.** The add-on cannot run as
   a headless host daemon. **Resolution:** attach in the operator GM session;
   zero-GM worlds are unreachable (FR-F6). Documented above.
2. **INSTALL currently names a third-party connector.** **Resolution:** step 6
   rewrites INSTALL; listing in Foundry's public directory stays a non-goal.

## Decisions to promote (ADR candidates)

Promoted this pass: [ADR-0029](../adr/0029-first-party-foundry-addon.md),
[ADR-0030](../adr/0030-drop-vttdriver-plugin-interface.md).

## Telemetry implications

None. Gateway hello/reject is local-only structured log. No new product events
(telemetry remains opt-in and must not include world or user identifiers).

## Privacy implications

Pairing secret is a credential (sealed store). `evt chat` text is session
dialogue already covered by TDD 0013 / ADR-0017. The add-on stores no player
PII of its own. Deletion of Foundry whispers is TDD 0038 via `deleteChatMessages`.

## Eval implications

None. Eval keeps injecting `MockFoundryClient`. No live Foundry in CI.

## Touched files

- `modules/skeinkeeper/module.json` — Foundry package manifest
- `modules/skeinkeeper/scripts/main.mjs` — GM-session add-on: settings, outbound WS, dispatch
- `plugins/vtt-foundry/src/foundry_gateway.ts` — listener, hello/pairing/version
- `plugins/vtt-foundry/src/module_foundry_client.ts` — `FoundryClient` over the gateway
- `plugins/vtt-foundry/src/module_foundry_client.test.ts` — fake-socket unit tests
- `app/src/foundry_source.ts` — production Start uses the gateway; never mock
- `app/src/config.ts` — gateway bind/port/secret; drop MCP env
- `docs/INSTALL.md` — enable add-on, URL, versions, LAN opt-in

## Expected diff size

- `modules/skeinkeeper/module.json` — 40 lines
- `modules/skeinkeeper/scripts/main.mjs` — 280 lines
- `plugins/vtt-foundry/src/foundry_gateway.ts` — 220 lines
- `plugins/vtt-foundry/src/module_foundry_client.ts` — 240 lines
- `plugins/vtt-foundry/src/module_foundry_client.test.ts` — 260 lines (×1.6 test pad applied)
- `app/src/foundry_source.ts` — 80 lines
- `app/src/config.ts` — 60 lines
- `docs/INSTALL.md` — 80 lines (×1.2 prose pad applied)

Total expected diff: 1260 lines across 8 files.
