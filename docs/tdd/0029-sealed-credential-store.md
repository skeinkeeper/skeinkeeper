# TDD 0029: Sealed Credential Store
Status: ready
PRD refs: 4.5, 5.5
PRD-rev: 66c079f
ADR constraints: 0010
Author: maintainers
Date: 2026-05-25
Related TDDs: [0020 (operator app)](./0020-operator-app.md)

## Approach

PRD §4.5 / §5.5 and [ADR-0010](../adr/0010-privacy-as-architecture.md) commit to
secrets encrypted at rest. The crypto already exists — `app/src/secrets.ts`
provides authenticated `seal`/`open` (AES-256-GCM, scrypt-derived key, zero
external deps) — but nothing calls it: `loadConfig` reads the bot token and the
provider API keys straight from a plaintext `.env`. This TDD wires the existing
crypto into a **sealed credential store** so production secrets live encrypted at
rest, opened at boot with one passphrase.

It deliberately ships the **sealed-config-file** path (the "fallback" the PRD
names) before the OS keyring (the PRD's stated primary). The keyring is
impractical for the dominant deployment — headless Linux / `docker compose` /
auto-restart, where an unlocked keyring daemon usually isn't present. A small
`KeySource` seam lets a keyring source replace the env-passphrase source later
with no change to the rest of the design (its own future TDD). Per-column PII
encryption ([ADR-0019](../adr/0019-per-column-pii-encryption.md)) is a separate
concern and a separate TDD.

The `.env`-only path keeps working unchanged: with no sealed file, boot reads
`.env` exactly as today (backward compatible for dev).

## Components & interfaces

- **`app/src/secrets.ts`** *(existing, unchanged)* — pure crypto: `seal(passphrase,
  plaintext): string`, `open(passphrase, sealed): string`, `SecretOpenError`.
- **`app/src/secret_store.ts`** *(new)* — file I/O + orchestration around the crypto:

  ```ts
  /** Where the boot passphrase comes from. The seam for a future keyring source. */
  export interface KeySource { getPassphrase(): string | undefined; }
  /** Default source: reads SKEINKEEPER_SECRET_PASSPHRASE from the environment. */
  export class EnvKeySource implements KeySource { /* ... */ }

  /** Keys eligible for sealing (required + optional-if-present). */
  export const SEALABLE_KEYS: readonly string[];

  /** Open the sealed file and return the secret map; {} if the file is absent.
   *  Throws SecretStoreError (fail closed) if the file EXISTS but the passphrase
   *  is missing or wrong. */
  export function loadSealedSecrets(opts: { path: string; keySource: KeySource }): Record<string, string>;

  /** Seal `secrets` under `passphrase` and write the file atomically (mode 0600). */
  export function sealSecrets(opts: { path: string; passphrase: string; secrets: Record<string, string> }): void;

  /** Names of keys currently sealed in the file (never values); [] if absent. */
  export function sealedKeyNames(opts: { path: string; keySource: KeySource }): string[];

  export class SecretStoreError extends Error {}
  ```

- **Boot glue — `app/src/main.ts`** (via a small `loadEffectiveEnv` helper): after
  `loadDotenv`, if the sealed file exists, overlay `loadSealedSecrets(...)` onto the
  env map for the sealable keys, then call `loadConfig`. **`loadConfig` is
  unchanged** (still env-map-in / validated-config-out) — sealing is a pre-step,
  preserving its purity and its tests.
- **CLI — `server/src/cli.ts`** (surfaced as `pnpm skeinkeeper secrets:<cmd>` via
  `scripts/skeinkeeper.mjs`; these commands need only the data dir + env, no DB or
  LanceDB adapters):
  - `secrets:seal` — seal the sealable secrets present in the current env (`.env`)
    under the passphrase, write the file; print which keys were sealed and a
    reminder to delete them from `.env`.
  - `secrets:status` — list sealed key names (never values) + whether a passphrase
    is currently available.
  - `secrets:rotate` — open with the current passphrase, re-seal under a new one
    (`SKEINKEEPER_SECRET_PASSPHRASE_NEW` or `--new-passphrase`).
  - `secrets:unseal` — open and print `KEY=value` lines to restore to `.env`; with
    `--remove`, delete the sealed file. Warns that this exposes plaintext.

## Data & state

- **File:** `${SKEINKEEPER_DATA_DIR}/secrets.sealed`, mode `0600`. Contents: a single
  sealed blob (`seal(passphrase, JSON.stringify(map))`) — one salt/iv/tag for the
  whole `{ KEY: value }` map (no per-key sealing; needless complexity). Written
  atomically (temp file + `rename`) so a crash mid-write can't truncate it.
- **No DB/schema changes.** Secrets are config, not campaign state; nothing new in
  SQLite or LanceDB. Mechanical state stays in Foundry (ADR-0018) — unaffected.
- **Sealable keys:** required — `DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`,
  `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`; optional-if-present —
  `SKEINKEEPER_SESSION_SECRET`, `POSTHOG_PROJECT_API_KEY`, `SENTRY_DSN`.
- **New env var:** `SKEINKEEPER_SECRET_PASSPHRASE` (the key source). Never written to
  `secrets.sealed`; supplied by the host (shell export, docker/systemd secret).

## Sequencing / implementation plan

1. `secret_store.ts` + unit tests (round-trip, fail-closed, no-file, overlay set).
2. Boot glue in `main.ts` (overlay before `loadConfig`) + an integration test.
3. CLI `secrets:seal` / `status` / `rotate` / `unseal` in `server/src/cli.ts` + tests.
4. Docs in the same PR: `.env.example` (add `SKEINKEEPER_SECRET_PASSPHRASE`, mark the
   sealable keys), `INSTALL.md` ("Sealing your secrets" + the commands), `PRIVACY.md`
   (Encryption: sealing now available), and flip the "planned" wording in the
   `secrets.ts` / `config.ts` comments.

## Failure modes & edge cases

- **Sealed file present, passphrase absent/wrong → fatal, fail closed.** `main` exits
  with a clear `SecretStoreError`; never silently falls back to `.env` (avoids a
  confusing downgrade / running on stale plaintext creds).
- **No sealed file → `.env` path** (backward compatible); no passphrase required.
- **Key sealed AND in `.env` →** sealed wins (production store authoritative). A
  required key in neither → the existing `ConfigError` (missing key) fires in
  `loadConfig`, unchanged.
- **Corrupt/truncated file →** `open` throws `SecretOpenError` → surfaced as fatal.
- **`secrets:seal` with no passphrase set →** refuse with guidance (don't write an
  unopenable file).
- **`secrets:unseal` exposes plaintext** by design; warns and never logs values to
  telemetry.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.5 | API keys/tokens encrypted at rest; sealed-config-file fallback | `secrets.sealed` (AES-256-GCM via `secret_store` + `secrets.ts`); boot overlay |
| 5.5 | All secrets encrypted at rest | sealable-keys set sealed in `secrets.sealed`; `secrets:seal` migration |
| 4.5 | Keyring primary, sealed-file fallback | `KeySource` seam; sealed-file shipped now, keyring source deferred (see PRD conflicts) |
| ADR-0010 #1 / hard rule #7 | Secrets not plaintext at rest; never inline secrets | passphrase via host-injected env; secrets sealed on disk |

## Dependencies considered

None new. Uses Node's built-in `node:crypto` (AES-256-GCM + scrypt), already used
by `secrets.ts`. **Rejected:** `libsodium` / `sodium-native` (the PRD's literal
wording) — a native build dependency that complicates install on every platform
and in Docker, for no security gain over authenticated AES-256-GCM from the
platform crypto. `keytar` / OS-keyring libraries — deferred to the keyring TDD
(native dep, headless-unfriendly).

## PRD conflicts surfaced (and resolution)

- PRD §4.5/§5.5 list the **OS keyring as primary** with the sealed file as
  *fallback*; this TDD ships the **sealed file first** and defers the keyring.
  Resolution: the keyring is impractical for the dominant headless/Docker
  deployment; the sealed file is the PRD-named fallback and is sufficient on its
  own. The `KeySource` seam makes the keyring a drop-in later (its own TDD), so the
  end state still satisfies "keyring primary." This is implementation sequencing,
  not a scope change — no PRD edit needed.
- PRD says "**libsodium**-sealed"; we use Node `crypto` AES-256-GCM (see
  Dependencies). Functionally equivalent authenticated encryption, zero-dep.

## Decisions to promote (ADR candidates)

None. This implements an existing ADR-0010 commitment; env-passphrase + sealed
file is an implementation choice, not a new cross-cutting decision. (If a later
keyring source changes the *default* key source, that warrants an ADR.)

## Telemetry implications

None. No new events. The CLI and boot path must **never** emit secret values or the
passphrase to logs or telemetry (no-PII-in-telemetry rule, ADR-0009).

## Privacy implications

Strengthens the privacy posture: removes plaintext provider keys / bot token from
`.env` at rest. No new personal data is processed — secrets are operator
credentials, not player PII — so no `PII<T>` fields and no new `DeletionAdapter`
(the sealed file is config; removed by deleting it or `secrets:unseal --remove`).
Directly advances ADR-0010 architectural commitment #1.

## Eval implications

None — mechanical (non-LLM) feature. Covered by unit + integration tests
(`secret_store`, boot overlay, CLI round-trip), not eval fixtures.
