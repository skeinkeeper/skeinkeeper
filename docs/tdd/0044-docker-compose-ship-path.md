# TDD 0044: The `docker compose up` ship path

Status: implemented
PRD refs: 4.2 (FR-F2, FR-F6), §3 Goals (operator-controlled `docker compose up`), 5.5, §8 v0.5 roadmap
PRD-rev: b8a265c
ADR constraints: 0009, 0010, 0025, 0029, 0030
Depends on: [TDD 0043](./0043-container-bind-and-console-credential.md) — the `container` bind mode and console credential this packaging selects must exist first.
Set: [TDD 0043](./0043-container-bind-and-console-credential.md) (app) + this TDD (packaging + docs). The rubric below is identical across both (FR-77).
Author: maintainers

## Approach

**`docker compose up` is the product's shipping vehicle, and it ships broken.** README's
quick start is `docker compose up`; PRD §3 names it as the operator constraint and §8 lists
a "Documented `docker compose up` install path" as a v0.5 deliverable. FR-F2's acceptance
requires an operator following INSTALL can enable Foundry support and **Start a session**.
[TDD 0043](./0043-container-bind-and-console-credential.md) fixes the app-side cause; this
TDD fixes the packaging and the docs, and is what actually makes the path work end to end.

Three packaging defects, independent of the app fix:

1. **The gateway port is never published.** `docker-compose.yml` has exactly one `ports:`
   entry, for 3000. Even with 0043's `container` bind, the add-on has nothing to dial.
2. **Publish mappings are unscoped.** `"${SKEINKEEPER_WEB_PORT:-3000}:3000"` has no host-IP
   prefix, so Docker binds `0.0.0.0` — putting the operator console on the LAN. Combined
   with 0043 making the console reachable at all, both halves must be correct together.
3. **Any built image bakes the operator's secrets.** There is no `.dockerignore`, and
   `Dockerfile:19` runs `COPY . .` before install, so `.env` (Discord bot token, Anthropic
   / ElevenLabs / Deepgram keys) and `data/` (the audience-tagged dialogue store and
   LanceDB episodic memory — player speech) are copied into the image. An operator who
   builds and publishes an image distributes their own credentials and their table's
   transcripts. This is CLAUDE.md hard rule #7 and PRD §5.5.

The compose file selects the deployment's shape in its `environment:` block rather than in
`.env`, so the mode is a property of the shipped artifact and not something an operator can
forget or half-configure. `environment:` takes precedence over `env_file:` for the same
key, which is the intended behaviour here.

## Components & interfaces

No app code. Four packaging/doc artifacts:

`docker-compose.yml`:

```yaml
ports:
  - "127.0.0.1:${SKEINKEEPER_WEB_PORT:-3000}:${SKEINKEEPER_WEB_PORT:-3000}"
  - "127.0.0.1:${FOUNDRY_GATEWAY_PORT:-7733}:${FOUNDRY_GATEWAY_PORT:-7733}"
environment:
  FOUNDRY_GATEWAY_BIND: container
  SKEINKEEPER_WEB_HOST: 0.0.0.0
  SKEINKEEPER_DATA_DIR: /data
```

Both mappings are host-loopback-scoped: this is the boundary the whole security argument in
[TDD 0043](./0043-container-bind-and-console-credential.md) rests on, so it is not
operator-tunable via `.env`. `restart: unless-stopped` stays as-is.

**Both sides of each mapping are templated off the same variable, deliberately.**
`app/src/config.ts:95` and `:107` read `FOUNDRY_GATEWAY_PORT` and `SKEINKEEPER_WEB_PORT` to
choose where the app listens _inside_ the container — there is no separate internal-port
knob. Today's compose hardcodes the container side (`"${SKEINKEEPER_WEB_PORT:-3000}:3000"`,
`docker-compose.yml:16`), so an operator who sets `SKEINKEEPER_WEB_PORT=8080` — a supported,
documented knob — gets the app bound to container port 8080 while Docker still forwards to
3000, and the console goes unreachable. That is a live defect in the current file, not one
this TDD introduces; it is fixed here because this TDD owns the port syntax and because
shipping a second variant of "the mapping points at nothing" is precisely the class of bug
this set exists to close.

`.dockerignore` (new): `.env`, `.env.*`, `data/`, `node_modules`, `.git`, `**/dist`,
`**/*.tsbuildinfo`. Excluding `node_modules` and `dist` also stops a host build tree
leaking into the image, where `pnpm install --frozen-lockfile` must own them.

`Dockerfile`: header still describes "the MCP bridge … run outside the container", stale
since [ADR-0029](../adr/0029-first-party-foundry-addon.md). Corrected to describe the
first-party add-on dialling the published gateway.

`docs/INSTALL.md` + `.env.example`: document `container` alongside `loopback` / `lan`; that
the add-on's `gatewayUrl` stays `ws://127.0.0.1:7733`; that the console password is printed
once at boot and persisted in the data volume; and the two things an operator must not do —
widen a publish mapping to `0.0.0.0` (use `lan` + TLS instead), and add a second service to
this Compose project without re-reading the sole-tenant assumption in 0043.

## Data & state

None. The compose volume mounts `./data:/data`, which is what makes 0043's
`.foundry-pairing-secret` and `.console-password` survive container replacement so the
operator pairs and logs in once. **`SKEINKEEPER_DATA_DIR` must be pinned in
`environment:`, not left to the Dockerfile's `ENV`** — see Failure modes.

## Sequencing / implementation plan

1. Add `.dockerignore`.
2. Fix the `Dockerfile` header.
3. Compose: loopback-scoped publish for both ports; `environment:` for bind mode and web
   host.
4. `docs/INSTALL.md`: the container path end to end — pair, log in, do-not-widen.
5. `.env.example`: document the third bind mode and that compose sets it.

## Failure modes & edge cases

- **Operator widens a publish mapping** to `0.0.0.0:7733:7733` or `0.0.0.0:3000:3000`. The
  surface then genuinely is network-facing; the gateway without TLS, the console with only
  a password. The app cannot detect it — a connection through the publish mapping presents
  the bridge gateway address, indistinguishable from a LAN peer. Accepted residual risk,
  mitigated by shipping a correct file the operator does not hand-write and by documenting
  `lan` + TLS as the supported way to do this deliberately.
- **A second service added to the Compose project.** Docker's project network lets siblings
  reach bound ports directly, never traversing the host publish mapping. INSTALL states
  this; the mandatory pairing secret and always-present console credential from 0043 are
  what keep it from being an open door.
- **Stale image after a rebuild.** `COPY . .` copies whatever is in the build context;
  `.dockerignore` is what keeps a native run's `.env` and `data/` out. A pre-existing image
  built before this TDD may already contain them — INSTALL notes that such images should be
  rebuilt and not published.
- **`SKEINKEEPER_WEB_PORT` / `FOUNDRY_GATEWAY_PORT` changed in `.env`.** Both sides of the
  mapping follow the variable, because the app binds that same port inside the container
  (`app/src/config.ts:95`, `:107`). Templating only the host side — as the current file
  does — leaves nothing listening on the container side and breaks reachability; that is
  why the snippet above repeats the variable on both sides. The advertised add-on URL
  follows `FOUNDRY_GATEWAY_PORT` too, so a customised gateway port must be pasted into the
  add-on's `gatewayUrl` setting; INSTALL says so.
- **The `prepare` lifecycle hook breaks the image build.** `pnpm install` runs the root
  `prepare` script (`lefthook install`), which shells out to `git` and requires a
  repository. The image has neither: `git` is not in the base image, and
  `.dockerignore` deliberately excludes `.git`. Setting `LEFTHOOK=0` does not help —
  lefthook still invokes git at install time — and `--ignore-scripts` would skip the
  native rebuilds the voice path needs. The hook is therefore guarded to no-op when
  there is no repository, which keeps it loud on a developer machine and silent in
  an image. Found by runtime-verify, not by design.
- **`env_file:` silently defeats the volume mount.** The Dockerfile sets
  `ENV SKEINKEEPER_DATA_DIR=/data`, but compose's `env_file:` overrides image `ENV`, and
  `.env.example` ships `SKEINKEEPER_DATA_DIR=./data` — which every operator copies into
  their `.env`. The app then resolved the data dir to `/app/data` _inside_ the container,
  the `./data:/data` mount received nothing, and every `docker compose down` discarded the
  operator's credentials, SQLite database and episodic memory. Pinning the key in
  `environment:` fixes it under the same rule as the other two. Found by runtime-verify
  booting the stack twice, not by design.
- **The elephant: this is the first end-to-end run of the container path.** Because the
  console and gateway have never been reachable (0043), nothing behind them is known to
  work in a container: ffmpeg and Discord voice UDP egress, `pnpm app:start` transpiling
  via tsx at boot, and the image's `node:22-bookworm-slim` against the Node 24 developers
  run natively. The "Start a session" row below is therefore the load-bearing check of this
  whole set, and a failure there is a new finding rather than a regression of this design.

## Verification plan

Observable surface: `docker compose up` output, host-side reachability of the published
ports, the built image's filesystem, the add-on's connection state in Foundry, and the
Start result.

| Observation point                                                            | PASS                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `docker compose up`, then `curl http://127.0.0.1:3000/` on host              | HTTP 200 — console reachable (fails today)                          |
| Same, from another host on the LAN                                           | connection refused — publish is loopback-scoped                     |
| `ss -tlnp` on host after `up`                                                | 3000 and 7733 both bound `127.0.0.1`, not `0.0.0.0`                 |
| `docker compose up` with no password hash set                                | starts; does NOT crash-loop; prints a console password once         |
| Log in to the console with that printed password                             | login succeeds                                                      |
| Add-on `gatewayUrl` = `ws://127.0.0.1:7733`, GM loads world                  | add-on connects; console logs the pairing accept                    |
| **Start a session with that container running**                              | Start succeeds (FR-F2, FR-F6); `getActiveScene()` matches the world |
| `docker compose down && up` with `./data` mounted                            | same pairing secret and console password; no re-pair, no new login  |
| `docker build`, then `docker run --rm --entrypoint sh <img> -c 'ls -a /app'` | no `.env`, no `data/`, no host `node_modules`                       |
| `docker history`/image inspect for the build context                         | no layer containing `.env` or `data/`                               |

## Evaluation rubric

Identical to [TDD 0043](./0043-container-bind-and-console-credential.md) (FR-77 — one
rubric across the set).

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

| PRD ref  | Requirement                                                     | Satisfied by                                                                                     |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| FR-F2    | Operator following INSTALL can enable Foundry support and Start | 7733 published + INSTALL's container path; the Start row of the Verification plan                |
| FR-F6    | Unreachable Foundry fails closed                                | unchanged; this removes the _unfixable_ failure, not the fail-closed behaviour                   |
| §3 Goals | `docker compose up`, local web UI on `localhost`                | both ports published to host loopback only                                                       |
| §5.5     | TLS 1.3 on any network-facing surface                           | loopback-scoped publish keeps the surface off the network; `lan` + TLS documented                |
| §5.5     | Secrets encrypted at rest / not leaked                          | `.dockerignore` keeps `.env` out of built images (leak-prevention; at-rest sealing is unchanged) |
| §5.5     | Deletion path per store                                         | unchanged; `data/` excluded from images means no transcript copy escapes the store               |
| §8 v0.5  | Documented `docker compose up` install path                     | INSTALL documents the container path end to end                                                  |

## Dependencies considered

**No new library or service** — Docker and Compose are already the PRD's stated install
path (§3, §8) and already in-repo. On the runtime choice, since this TDD is where it
lives: **Podman** was evaluated — rootless by default, no root-equivalent `docker` group,
first-class systemd integration via Quadlet, and it can consume this same compose file via
`podman compose`. Rejected as the _documented_ path because the PRD, README, and INSTALL
all commit to `docker compose up`, and shipping-path fidelity is the point of this set;
operators who prefer Podman are not blocked. **`network_mode: host`** was evaluated as an
alternative to publishing ports (no app change at all, exact preservation of the loopback
model) and rejected as Linux-only against README's "Linux, macOS, or Windows with Docker".

## PRD conflicts surfaced (and resolution)

**PRD §5.5 "TLS 1.3 on any network-facing surface" vs. publishing an unencrypted `ws://`
gateway.** Resolved as _not a conflict_: both mappings publish to the host's loopback
interface only, so traffic never leaves the host — the same posture as today's
PRD-compliant `loopback` mode, which is also plain `ws://`. The full argument, including
the sole-tenant-of-the-Compose-network assumption it depends on, is in
[TDD 0043](./0043-container-bind-and-console-credential.md).

No PRD change is required, and none should be made: the PRD's Evaluation rubric row "No
implementation HOW leaked" places transport, process topology, and protocol detail out of
the PRD's scope. This is a defect against existing requirements, not a new one.

## Decisions to promote (ADR candidates)

**None.** The container runtime is already fixed by the PRD and README; this TDD implements
that commitment rather than making a new one. Were the project to adopt a different
_documented_ runtime, or to support LAN-facing deployment as a first-class shape, either
would be an ADR.

## Telemetry implications

**None.** No new event; packaging carries no instrumentation, and deployment shape must not
be fingerprinted into a stream that is off by default
([ADR-0009](../adr/0009-telemetry-opt-in.md)).

## Privacy implications

**Net positive, no new processing.** No new personal data, store, or consent surface. The
`.dockerignore` closes an active leak: without it, `COPY . .` bakes `.env` and `data/` —
the audience-tagged dialogue store and LanceDB episodic memory, i.e. players' recorded
speech — into every built image, which an operator publishing an image would distribute to
third parties. That is a disclosure of players' personal data the operator (the controller
under PRD §5.5) never intended. Loopback-scoping the console publish likewise keeps a UI
that can read transcripts off the LAN.

## Eval implications

**None** — packaging only; no LLM behaviour changes, so no fixture. The Verification plan
is the acceptance evidence, and this path is exercised as part of
`docs/LIVE-VALIDATION.md`.

## Touched files

- `docker-compose.yml` — loopback-scoped publish for 3000 + 7733; bind/web-host env
- `.dockerignore` — new; keep `.env`, `data/`, `node_modules`, `.git` out of images
- `Dockerfile` — drop the stale MCP-bridge header
- `docs/INSTALL.md` — the container path, pairing, console login, do-not-widen
- `.env.example` — document `container` alongside `loopback` / `lan`
- `README.md` — quick start notes the generated console password
- `package.json` — guard the root `prepare` hook so it no-ops outside a git repo
  _(added at verify time: `docker build` failed because `pnpm install` runs
  `prepare` → `lefthook install`, which requires a git repository. `.dockerignore`
  correctly excludes `.git`, so installing the `git` package would not have helped
  either — the fix belongs in the hook, not the image.)_

## Expected diff size

- `docker-compose.yml` — 20 lines
- `.dockerignore` — 15 lines
- `Dockerfile` — 10 lines
- `docs/INSTALL.md` — 70 lines (×1.2 prose pad applied)
- `.env.example` — 15 lines (×1.2 prose pad applied)
- `README.md` — 6 lines (×1.2 prose pad applied)
- `package.json` — 2 lines

Total expected diff: 138 lines across 7 files.
