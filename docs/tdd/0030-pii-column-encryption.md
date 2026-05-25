# TDD 0030: Per-Column PII Encryption
Status: implemented
PRD refs: 5.5, 5.6
PRD-rev: 66c079f
ADR constraints: 0008, 0010, 0022
Author: maintainers
Date: 2026-05-25
Related TDDs: [0002 (privacy foundation)](./0002-privacy-foundation.md), [0029 (sealed credential store)](./0029-sealed-credential-store.md)

## Approach

ADR-0010 commits to encrypting PII-marked columns at rest; [ADR-0022](../adr/0022-pii-encryption-node-crypto.md)
(superseding ADR-0019) fixes the mechanism: per-column AEAD via Node `crypto`
AES-256-GCM, keyed from the same `SKEINKEEPER_SECRET_PASSPHRASE` `KeySource` as the
sealed credential store ([TDD 0029](./0029-sealed-credential-store.md)). The shim
TDD 0002 promised was never built; this TDD builds it.

Three column shapes need three treatments (inventory in *Data & state*):

1. **Identity lookup columns** (raw Discord IDs queried by equality / used for
   erasure) — `consents.subject_id`, `player_character_map.discord_user_id`,
   `dialogue.speaker`. Add a **salted deterministic hash companion** column for
   equality + erasure; AEAD-encrypt the value for read-back.
2. **Data-only columns** (stored, read back, never filtered) — `dialogue.text`,
   `dialogue.display_name`, `player_character_map.display_name`,
   `audit_log.payload_json`, `settings.value`. Straight AEAD (encrypt-on-write,
   decrypt-on-read).
3. **Routing tokens** that embed a raw ID and are matched by equality —
   `dialogue.audience`, `dialogue.conversation_id`, and the LanceDB `memory.audience`.
   Rework `playerAudience()` / `playerConversation()` to embed the **hash**
   (`player:<hash>`) instead of the raw ID, so the token stops carrying recoverable
   PII while equality still works everywhere it is matched.

**Gating:** value encryption is active only when `SKEINKEEPER_SECRET_PASSPHRASE`
is set (the same switch as credential sealing) — without it the columns are
plaintext (alpha default; a key kept on disk next to the data is not
encryption-at-rest). The hash companions use the always-present per-installation
salt, so lookup/erasure work in both modes.

Audit and deletion paths stay **key-free** — they match on the hash companions and
operate on ciphertext, never needing the plaintext key (ADR-0010 / ADR-0022).

## Components & interfaces

- **`server/src/column_crypto.ts`** *(new)* — built once at boot from the
  `KeySource` + per-install salt:

  ```ts
  export interface PiiCrypto {
    /** True when a passphrase is available (value encryption on). */
    readonly enabled: boolean;
    /** AES-256-GCM with the derived column key; passthrough when !enabled. */
    enc(plaintext: string): string;
    dec(stored: string): string;
    /** Salted deterministic hash for equality/erasure (always available). */
    hash(value: string): string;
  }
  export function createPiiCrypto(opts: { keySource: KeySource; salt: string }): PiiCrypto;
  ```

  The column key is `scrypt(passphrase, salt, label="pii-column")` — a label
  distinct from credential sealing. `enc` output is tagged (e.g. a `gcm:` prefix)
  so `dec` and the migration can tell ciphertext from legacy plaintext. `hash` is
  HMAC/SHA-256 over the per-install salt + value (same family as
  `ErasureService.hashSubject`).
- **Schema** *(new `_hash` columns + migration)* — add `subject_id_hash` to
  `consents`, `discord_user_id_hash` to `player_character_map`, `speaker_hash` to
  `dialogue`, each indexed in place of the raw-value index. Value columns stay
  `TEXT` (now hold ciphertext when enabled).
- **`server/src/tenant_db.ts` + adapters** — write path computes the hash and
  encrypts the value; read path decrypts; **all equality lookups and erasure WHERE
  clauses switch to the `_hash` column**. `PiiCrypto` is injected (constructor
  dep), so the query layer stays unit-testable with a fake.
- **`server/src/audience.ts`** — `playerAudience(id)` / `playerConversation(id)`
  embed `hash(id)` → `player:<hash>`. `isPlayerScoped` still works on the prefix;
  `playerIdOf` returns the hash (callers that need the raw ID get it from the
  Discord event, not by parsing the token — verified in the inventory). The
  LanceDB `memory.audience` filter (`lance_memory_store.ts`) inherits the new token
  unchanged because it matches the same string `playerAudience()` produces.
- **CLI `pii:encrypt`** *(in `server` CLI, alongside `secrets:*`)* — one-shot
  migration: with the passphrase set, walk each PII table, fill the `_hash`
  columns, encrypt the values, and rewrite `audience`/`conversation_id` tokens to
  the hashed form. Idempotent: rows already encrypted (tagged ciphertext) are
  skipped.

## Data & state

Per-column treatment (from the schema/adapter inventory):

| Column | PII | Treatment |
|---|---|---|
| `consents.subject_id` | Discord ID (lookup + erasure) | `subject_id_hash` companion + AEAD value |
| `player_character_map.discord_user_id` | Discord ID (lookup + erasure) | `discord_user_id_hash` companion + AEAD value |
| `dialogue.speaker` | Discord ID (lookup + erasure) | `speaker_hash` companion + AEAD value |
| `dialogue.audience`, `dialogue.conversation_id` | `player:<id>` routing token | embed `hash(id)` → `player:<hash>` |
| `dialogue.text`, `dialogue.display_name` | free text / name (data-only) | AEAD |
| `player_character_map.display_name` | name (data-only) | AEAD |
| `audit_log.payload_json` | JSON may embed IDs (data-only; read for display) | AEAD; audit *existence/deletion* works on ciphertext |
| `settings.value` | may hold operator ID (data-only) | AEAD |
| `deletion_log.subject_id_hash` | already a salted hash | unchanged |
| LanceDB `memory.audience` | `player:<id>` routing token | inherits the hashed token (no separate change) |

No new persistent store; uses the existing SQLite DB + the per-install salt
(`salt.ts`) + the TDD-0029 passphrase. Mechanical state stays in Foundry
(ADR-0018) — untouched.

## Sequencing / implementation plan

1. `column_crypto.ts` (`PiiCrypto`, `createPiiCrypto`) + unit tests
   (enc/dec round-trip, hash determinism, passthrough when disabled, ciphertext
   tagging).
2. Schema: add `_hash` columns + a Drizzle migration; reindex on the hash.
3. `tenant_db.ts` + adapters: hash-on-write, lookup/erase by hash, enc/dec values;
   inject `PiiCrypto`. Update + extend the adapter tests.
4. `audience.ts` rework + tests; confirm the LanceDB audience filter still matches.
5. `pii:encrypt` migration command + test (round-trips a seeded plaintext DB to
   encrypted-and-queryable).
6. Boot: build `PiiCrypto` in `bootstrap.ts`/`main.ts` from the same KeySource and
   thread it into `TenantDb`.
7. Docs in-PR: `PRIVACY.md` (PII now encrypted at rest when sealed), `INSTALL.md`
   (`pii:encrypt`), `.env.example` note; flip the TDD-0002 encryption note.

## Failure modes & edge cases

- **Passphrase set but wrong/changed → decrypt fails.** `dec` surfaces a clear
  error; boot fails closed (consistent with TDD 0029). Rotating the passphrase
  requires re-encrypting (a `pii:encrypt` re-run after `secrets:rotate`).
- **Mixed plaintext/ciphertext during migration.** `dec` detects the ciphertext
  tag and returns legacy plaintext untouched, so reads work mid-migration;
  `pii:encrypt` is resumable and idempotent.
- **No passphrase →** values stored plaintext, hashes still populated; lookups and
  erasure work. Documented as the alpha default.
- **Hash companion drift.** Writes always set the hash; the migration backfills it.
  A row missing its hash (pre-migration) is found by a one-time backfill, not by
  scanning plaintext.
- **`audience`/`conversationId` format change** invalidates old tokens until
  migrated — `pii:encrypt` rewrites them in the same pass; the LanceDB store is
  rewritten via its existing audience-aware path.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 5.5 | PII fields annotated and protected | `PII<T>` (existing) + per-column AEAD on every PII column |
| 5.6 | Encryption-at-rest for PII-marked columns | `column_crypto` AES-256-GCM via `PiiCrypto`; `_hash` companions keep audit/deletion key-free |
| ADR-0022 | Node-crypto AEAD, KeySource passphrase, per-column, key-free audit/deletion | `column_crypto` + hash companions + audience rework |
| ADR-0010 #4 | Deletion path works without the key | erasure matches on `_hash`, operates on ciphertext |

## Dependencies considered

None new. Node `crypto` (AES-256-GCM + scrypt + HMAC), already used by
`secrets.ts`. Reuses the TDD-0029 `KeySource` and the per-install salt. **Rejected:**
libsodium / SQLCipher (see [ADR-0022](../adr/0022-pii-encryption-node-crypto.md)).

## PRD conflicts surfaced (and resolution)

- PRD §5.6 (echoing ADR-0019) names **libsodium + OS keyring**; this design uses
  Node-crypto AEAD + the passphrase `KeySource`. Resolved by
  [ADR-0022](../adr/0022-pii-encryption-node-crypto.md) (supersedes ADR-0019) for
  consistency with TDD 0029; the keyring stays a future `KeySource`. No PRD edit
  needed — the PRD requirement ("encrypted at rest") is met; the primitive/key are
  implementation choices the ADR now records.

## Decisions to promote (ADR candidates)

Promoted: the crypto/key change is [ADR-0022](../adr/0022-pii-encryption-node-crypto.md),
included in this design PR (supersedes ADR-0019).

## Telemetry implications

None. No new events. Never log plaintext PII, ciphertext, the passphrase, or the
derived key (ADR-0009 no-PII rule).

## Privacy implications

Directly advances ADR-0010: PII-marked columns are encrypted at rest when a
passphrase is set, with the key off-disk. Deletion/audit stay key-free via the
hash companions, preserving the "verify the erasure happened" property. The
`audience`/`conversationId` rework removes recoverable Discord IDs from routing
tokens. No new personal-data processing or new consent basis. No new
`DeletionAdapter` (erasure paths are retargeted to the `_hash` columns, same rows).

## Eval implications

None — mechanical (non-LLM). Covered by unit + integration tests (`column_crypto`,
adapter read/write/erase by hash, audience rework, `pii:encrypt` round-trip).
