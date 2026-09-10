# TDD 0043: Container bind mode + console credential

Status: implemented
PRD refs: 4.2 (FR-F2, FR-F6), §3 Goals (operator-controlled `docker compose up`), 5.5
PRD-rev: b8a265c
ADR constraints: 0009, 0010, 0025, 0029, 0030
Supersedes narrowly: [TDD 0041](./0041-first-party-foundry-addon.md) — the gateway **bind** table only (§Components & interfaces). 0041's add-on, hello/pairing/version handshake, message shapes, and `FoundryClient` surface carry forward unchanged.
Set: this TDD (app) + [TDD 0044](./0044-docker-compose-ship-path.md) (packaging + docs). 0044 depends on this one; the rubric below is identical across both (FR-77).
Author: maintainers

## Approach

**The documented install path cannot produce a session-capable instance, and the cause is
in the app, not the packaging.** README's quick start and PRD §3 both name
`docker compose up`; FR-F2's acceptance requires an operator following INSTALL can enable
Foundry support and **Start a session**. Two binds prevent it.

Both the console (`app/src/main.ts:92`, default `127.0.0.1`) and the gateway
(`plugins/vtt-foundry/src/foundry_gateway.ts:69`, `loopback` → `127.0.0.1`) bind loopback.
Inside a container that is the _container's_ loopback, so neither is reachable from the
host — where the GM's browser runs. The add-on is an `esmodules` entry
(`modules/skeinkeeper/module.json`) executing in the GM's browser, not in the Foundry
server process, so the gateway must be reachable from a host browser.

**The `bind` enum fuses two unrelated things:** _where do I listen_ and _what is my threat
model_. `lan` means "0.0.0.0 **and** the traffic crosses a network the operator does not
fully control, so require TLS" (TDD 0041; PRD §5.5). A container needs the first without
the second: it listens broadly inside its own network namespace, and that namespace edge
plus a loopback publish mapping is the boundary. This TDD adds a third mode, `container`,
consistent with the gateway's existing stated intent — `foundry_gateway.ts:268` already
holds that "Pairing secret is the gateway's authorization. Require it on EVERY connection
when one is configured — loopback included." The secret is the credential; the bind
address is defense-in-depth.

**The console needs a credential of its own, and cannot simply be un-gated.**
`main.ts:97-104` fails closed: a non-loopback bind with no `SKEINKEEPER_OPERATOR_PASSWORD_HASH`
throws, and `main().catch(… process.exit(1))` (`main.ts:142`) exits — under a restart
policy, a crash loop. That guard is correct and this design does not weaken it. But the
password is documented as optional (`.env.example`, INSTALL "Without it, the console is
open on localhost") and the quick start never sets one, so requiring the operator to
hand-compute a hash before first run would regress PRD §3's "friend who can run
`docker compose up`". Instead the console credential is **auto-provisioned in `container`
mode much as the pairing secret already is** (`loadOrCreatePairingSecret`,
`app/src/foundry_source.ts:45`): generate, persist `0600` under the data dir, and print the
plaintext **on the boot that creates it only** — later boots log the file's path, not the
value. The operator copies it from the compose logs once, the same action they already
perform for pairing. There is never an unauthenticated non-loopback console.

Rejected: `network_mode: host` needs no code change and preserves the model exactly, but is
Linux-only — README promises "Linux, macOS, or Windows with Docker." Also rejected: making
`SKEINKEEPER_OPERATOR_PASSWORD_HASH` a documented hard requirement for the container path —
simpler code, but it puts a hash-generation step in front of the five-line quick start.

## Components & interfaces

`plugins/vtt-foundry/src/foundry_gateway.ts`:

```ts
export type GatewayBind = "loopback" | "container" | "lan";
```

| Mode        | Listens on  | TLS      | Pairing secret | Console credential        | Intended use                             |
| ----------- | ----------- | -------- | -------------- | ------------------------- | ---------------------------------------- |
| `loopback`  | `127.0.0.1` | not used | required¹      | optional (documented)     | native same-machine (default)            |
| `container` | `0.0.0.0`   | not used | **required**   | **always present**¹       | in-container, published to host loopback |
| `lan`       | `0.0.0.0`   | required | required       | required (existing guard) | Foundry on another host                  |

¹ generated and persisted under the data dir when unset.

- `get bindHost()` — `loopback` → `127.0.0.1`; `container` / `lan` → `0.0.0.0`.
- `get url()` — the URL **advertised to the operator for the add-on's `gatewayUrl`
  setting**, which is what the GM's browser dials. `container` advertises
  `ws://127.0.0.1:<port>` (the host-side publish mapping), _not_ `ws://0.0.0.0:<port>`.
  `loopback` and `lan` are unchanged.

`app/src/auth.ts` — new, mirroring `loadOrCreatePairingSecret`:

```ts
export function loadOrCreateConsolePassword(dataDir: string): {
  password: string;
  hash: string;
  created: boolean;
};
```

Reads `<dataDir>/.console-password`; generates `randomBytes(18).toString("base64url")` and
writes it `0600` when absent. Returns the plaintext, its `hashPassword` digest (for
`auth`), and `created` — true only on the boot that generated it.

`app/src/main.ts` — when `config.foundry.gateway.bind === "container"` and
`SKEINKEEPER_OPERATOR_PASSWORD_HASH` is unset, build `auth` from
`loadOrCreateConsolePassword(config.dataDir)`. **Print the plaintext only when
`created`;** on every later boot log the file's path instead, never the value. The
console credential grants full session control — start/stop, live overrides,
transcripts — so unlike the pairing secret it must not be re-emitted into container logs
on every restart, where `docker logs` output routinely ends up pasted into a support
thread. (The pairing secret's own every-boot reprint at
`app/src/foundry_source.ts:75` has the same shape but is TDD 0041's code and a
lower-value credential; noted for a follow-up, out of scope here.)

The `main.ts:97` fail-closed guard is left **exactly as is** — this design satisfies it
rather than bypassing it, so a non-loopback bind still cannot come up unauthenticated by
any path.

`app/src/config.ts` — `gatewayFromEnv` parses the third value: `lan` keeps its existing
`TLS cert + key + secret` requirement; `container` requires a resolvable pairing secret
(env unset is fine — it is generated and persisted). An unrecognised value falls back to
`loopback`, matching existing parse behaviour.

## Data & state

One new file, no schema change: `<dataDir>/.console-password`, mode `0600`, alongside the
existing `.foundry-pairing-secret`, `.installation`, and `.salt` dotfiles. It holds a
generated console password for `container` deployments. Because the compose volume mounts
the data dir, it survives container replacement and the operator logs in once.

## Sequencing / implementation plan

1. Widen `GatewayBind`; implement `bindHost` and the `container` advertised `url`.
2. Unit-test the three modes' bind host and advertised URL (new `foundry_gateway.test.ts`
   — the gateway has no direct test file today; only `module_foundry_client.test.ts`
   exercises it through a fake socket).
3. `loadOrCreateConsolePassword` in `auth.ts`; extend `auth.test.ts` (generation,
   persistence, `0600`, idempotence on second boot, and `created` false on reuse).
4. `config.ts` parse + per-mode validation; extend `config.test.ts`.
5. `main.ts`: provision the console credential in `container` mode and print it once;
   leave the fail-closed guard untouched.

## Failure modes & edge cases

- **Console credential in `container` mode.** Without provisioning, `main.ts:97` throws and
  the process exits 1 — under a restart policy, a crash loop on the _default_ first-run
  path (no password documented or set). This design provisions rather than un-gates, so
  the guard's invariant holds and the crash cannot occur.
- **Sibling containers on the same Compose network (load-bearing assumption).** The
  "namespace edge is the boundary" argument holds only while the app is the **sole tenant
  of its Compose network**. Docker's project network lets any sibling service reach a
  bound port _directly_, never traversing the host publish mapping the safety argument
  rests on. Today's compose has one service; the moment an operator adds a second
  (containerized Foundry, a reverse proxy — foreseeable under PRD FR-F4's
  operator-controlled infrastructure), that sibling reaches both ports. The gateway is
  backstopped by the mandatory pairing secret and the console by the always-present
  credential above — which is precisely why neither may be left un-credentialed in this
  mode. Documented in INSTALL by [TDD 0044](./0044-docker-compose-ship-path.md).
- **Operator widens the publish mapping** to `0.0.0.0:7733:7733`. The gateway then _is_
  network-facing without TLS. The app cannot detect this — a connection arriving via the
  publish mapping presents the bridge gateway address, indistinguishable from a LAN peer —
  so this is an accepted residual risk, mitigated by the mandatory pairing secret
  (constant-time compared) and by shipping a correct compose file the operator does not
  hand-write.
- **`container` mode run natively** (outside a container) binds `0.0.0.0` on the host with
  no TLS. `loopback` remains the native default and the fallback for an unrecognised
  value; INSTALL states `container` is for the shipped compose file only.
- **Data volume not mounted** — pairing secret and console password both regenerate per
  start, so the operator re-pairs and re-logs-in every restart. The shipped compose mounts
  the volume.
- **The elephant: reachability may not be the last wall.** Because the console and gateway
  have never been reachable, no part of the container path is known to have run end to
  end. Behind this fix sit untested unknowns — ffmpeg and Discord voice UDP egress from a
  container, `pnpm app:start` transpiling via tsx at container boot, and the image's
  `node:22-bookworm-slim` against the Node 24 developers actually run. This TDD makes the
  path _reachable_; it does not prove the path _works_. That proof lands in
  [TDD 0044](./0044-docker-compose-ship-path.md)'s verification, and a failure there is a
  new finding, not a regression of this design.

## Verification plan

Observable surface: process stdout at boot, `ss -tlnp`, the data dir's dotfiles, and unit
tests over `bindHost` / advertised `url` / config validation.

| Observation point                                                     | PASS                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `FOUNDRY_GATEWAY_BIND=container`, no password hash set, boot natively | starts; does NOT throw; prints the generated console password     |
| Same, then `ss -tlnp`                                                 | gateway bound `0.0.0.0:7733`; console bound `0.0.0.0:3000`        |
| Same, inspect `<dataDir>/.console-password`                           | exists, mode `0600`, non-empty                                    |
| Boot a second time with that file present                             | same password reused; plaintext NOT reprinted; logs the file path |
| Same, then POST the console login with that password                  | login succeeds; a wrong password is rejected                      |
| `FOUNDRY_GATEWAY_BIND=container` **with** a password hash set         | env hash wins; no `.console-password` generated                   |
| `FOUNDRY_GATEWAY_BIND=loopback` (default), no password                | unchanged — starts, console open on loopback, no credential file  |
| `FOUNDRY_GATEWAY_BIND=lan` without TLS cert/key                       | unchanged — refuses to listen; message names TLS                  |
| `FOUNDRY_GATEWAY_BIND=nonsense`                                       | falls back to `loopback`; binds `127.0.0.1`                       |
| Unit: `bindHost` for all three modes                                  | `127.0.0.1` / `0.0.0.0` / `0.0.0.0`                               |
| Unit: advertised `url` in `container` mode                            | `ws://127.0.0.1:<port>` — never `0.0.0.0`                         |

## Evaluation rubric

Carried from [TDD 0041](./0041-first-party-foundry-addon.md) where the criterion still
applies, plus a row for the security argument this set turns on. Identical across 0043 and
0044 (FR-77).

| Criterion                       | High-quality                                                                                                               | Acceptable                                                    | Failing                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Requirement traceability        | Every in-scope FR/NFR maps to a named interface, type, or step                                                             | One mapping is slightly coarse but still findable             | An in-scope FR has no row, or the row is "handled in code"          |
| Interface concreteness          | Bind mode, listen address, advertised URL, credential provisioning, and per-mode validation are each specified             | Types are named; one edge payload is implied                  | "the container exposes the gateway" with no address or mapping      |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason                                                            | No new dep, and the section says why                          | New dep with empty or "none considered" analysis                    |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named                                                           | Observable but one scenario is console-only                   | Non-actionable plan (no surface, no observation point)              |
| Scope-bound adherence           | Touched files ≤8, body ≤500, per-file estimates present                                                                    | One justified exception, declared in `## Scope override`      | Silent over-bound or missing Touched files / Expected diff          |
| Naming consistency              | Bind-mode names match across 0041, 0043, 0044, `.env.example`, INSTALL, and compose                                        | One leftover `loopback`-only phrasing in prose, clearly dated | 0043 and 0044 disagree on a mode name or its listen address         |
| Security-argument honesty       | States why `container` is not network-facing, names every load-bearing assumption, and says which risks cannot be detected | Argument is sound but one residual risk is only implied       | Asserts "it's safe because it's a container" with no boundary named |

## Requirement traceability

| PRD ref  | Requirement                                                     | Satisfied by                                                                           |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| FR-F2    | Operator following INSTALL can enable Foundry support and Start | `container` bind makes the gateway reachable from the GM browser; 0044 publishes it    |
| FR-F6    | Unreachable Foundry fails closed                                | unchanged; this removes the _unfixable_ failure, not the fail-closed behaviour         |
| §3 Goals | `docker compose up`, local web UI on `localhost`                | console reachable in-container without a hand-computed hash before first run           |
| §5.5     | TLS 1.3 on any network-facing surface                           | `container` is not network-facing (see PRD conflicts); `lan` keeps its TLS requirement |
| §5.5     | No unauthenticated network-facing control surface               | `main.ts:97` guard preserved; console credential auto-provisioned in `container` mode  |

## Dependencies considered

**None** — no new library, service, or integration. `randomBytes` and the existing
`hashPassword` are already in use; the credential file mirrors an existing dotfile
pattern. (Container-runtime alternatives are analysed in
[TDD 0044](./0044-docker-compose-ship-path.md), which is where the runtime choice lives.)

## PRD conflicts surfaced (and resolution)

**PRD §5.5 "TLS 1.3 on any network-facing surface" vs. a `0.0.0.0` bind without TLS.**
Resolved as _not a conflict_, with one assumption made explicit: with the shipped compose
file the container's ports are published to the host's loopback only, so traffic never
leaves the host, and the `0.0.0.0` bind is within the container's network namespace — an
isolation boundary, not a network. This is the same posture as today's PRD-compliant
`loopback` mode, which is also plain `ws://`. The argument depends on the app being the
sole tenant of its Compose network (see Failure modes); that is why both surfaces carry a
mandatory credential in this mode rather than relying on the boundary alone. The
requirement continues to bind `lan`.

No PRD change is required, and none should be made: the PRD's Evaluation rubric row "No
implementation HOW leaked" places transport, process topology, and protocol detail out of
the PRD's scope. This is a defect against existing requirements, not a new one.

## Decisions to promote (ADR candidates)

**None.** [ADR-0029](../adr/0029-first-party-foundry-addon.md) already delegates this
explicitly: "How the add-on talks to the operator's Skeinkeeper process is a TDD concern
([TDD 0041](./0041-first-party-foundry-addon.md))." The bind taxonomy is that same
concern. If a later design needs the gateway reachable across a genuinely untrusted
network by default, _that_ is an ADR.

## Telemetry implications

**None.** No new event. Bind mode is deployment configuration, and emitting it would add a
deployment-shape signal to a stream that is off by default and must carry no environment
fingerprinting ([ADR-0009](../adr/0009-telemetry-opt-in.md)).

## Privacy implications

**No new personal data.** No new PII field, no new store of personal data, no consent
surface, so no `PII<T>` marker and no `DeletionAdapter` change. `.console-password` is an
operator credential, not personal data about a player; it is written `0600` under the
operator-controlled data dir and is removed with that directory. Its plaintext is printed
to the operator's own stdout once at boot, matching the pairing secret's existing
behaviour, and is never logged to telemetry (which is off by default and carries no
secrets by type).

## Eval implications

**None** — mechanical bind configuration and credential provisioning; no LLM behaviour
changes, so no fixture. The Verification plan above is the acceptance evidence.

## Touched files

- `plugins/vtt-foundry/src/foundry_gateway.ts` — `container` bind mode, `bindHost`, advertised `url`
- `plugins/vtt-foundry/src/foundry_gateway.test.ts` — new; per-mode bind host + advertised URL
- `app/src/auth.ts` — `loadOrCreateConsolePassword`
- `app/src/auth.test.ts` — generation, `0600`, idempotence
- `app/src/config.ts` — parse + per-mode validation for the third mode
- `app/src/config.test.ts` — validation cases per mode
- `app/src/main.ts` — provision + print the console credential in `container` mode

## Expected diff size

- `plugins/vtt-foundry/src/foundry_gateway.ts` — 30 lines
- `plugins/vtt-foundry/src/foundry_gateway.test.ts` — 110 lines (×1.6 test pad applied)
- `app/src/auth.ts` — 30 lines
- `app/src/auth.test.ts` — 90 lines (×1.6 test pad applied)
- `app/src/config.ts` — 30 lines
- `app/src/config.test.ts` — 80 lines (×1.6 test pad applied)
- `app/src/main.ts` — 30 lines

Total expected diff: 400 lines across 7 files.
