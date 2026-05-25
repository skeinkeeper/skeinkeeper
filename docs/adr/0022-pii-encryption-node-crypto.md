# ADR-0022: Per-column PII encryption via Node-crypto AEAD, keyed from the sealed-secret passphrase

Status: accepted
Date: 2026-05-25
Scope: privacy
Relates to: ADR-0010
Supersedes: ADR-0019

> Supersedes [ADR-0019](./0019-per-column-pii-encryption.md). ADR-0019's decisions
> to encrypt PII **per-column with AEAD** and to keep the audit/deletion paths
> working **without** the key are retained unchanged. Only the cryptographic
> primitive and the key source change, to align with the credential store shipped
> in [TDD 0029](../tdd/0029-sealed-credential-store.md). Implementation detail (the
> column helpers, the identity-hash companion, the audience rework, the migration)
> lives in [TDD 0030](../tdd/0030-pii-column-encryption.md).

## Context

ADR-0019 (2026-05-24) fixed the approach for encrypting PII-marked columns at
rest: per-column AEAD via **libsodium** (XSalsa20-Poly1305), keyed from the **OS
keyring**. A day later, [TDD 0029](../tdd/0029-sealed-credential-store.md) shipped
the credential store and deliberately chose differently for the same class of
problem (secrets at rest):

- **Node's built-in `crypto` (AES-256-GCM)**, not libsodium — to avoid a native
  build dependency on every platform and in Docker, for no security gain over
  authenticated AES-256-GCM from the platform crypto (CLAUDE.md hard rule #10).
- **A passphrase-derived key behind a pluggable `KeySource`** (env passphrase
  today, OS keyring a future drop-in), not the keyring directly — because an
  unlocked keyring daemon usually isn't present in the dominant headless /
  `docker compose` deployment.

Running two crypto stacks and two key sources in one codebase — libsodium+keyring
for PII columns, Node-crypto+passphrase for credentials — is avoidable complexity.
One approach should cover both.

## Decision

**Encrypt PII-marked columns per-column with AEAD using Node `crypto`
AES-256-GCM, keyed from the same `KeySource` passphrase as the sealed credential
store (TDD 0029).** A distinct scrypt derivation label separates the column key
from the credential-sealing use of the passphrase.

**Retained from ADR-0019 (unchanged):**

- **Per-column AEAD**, not whole-DB (SQLCipher rejected for the same reasons).
- **Audit and deletion paths operate on ciphertext** — they never need the key.
  Equality lookups and per-subject erasure use a **salted deterministic hash**
  companion (extending the existing `deletion_log.subject_id_hash` pattern), so
  the plaintext key is needed only by feature code that reads PII back.
- The key is **never written to disk in plaintext** (the passphrase is supplied by
  the host per TDD 0029; an OS-keyring `KeySource` remains a future option).

**Changed from ADR-0019:**

- Primitive: **AES-256-GCM (Node `crypto`)**, not XSalsa20-Poly1305 (libsodium).
- Key source: the **TDD-0029 `KeySource` passphrase**, not the OS keyring (keyring
  deferred behind the same seam).

### Gating

Because the key is the (optional) sealing passphrase, **column encryption is
active when `SKEINKEEPER_SECRET_PASSPHRASE` is set** — the same switch that turns
on credential sealing. With no passphrase the columns are plaintext (the honest
alpha default; a key kept next to the data on disk would not be
encryption-at-rest). The identity-hash companions use the always-present
per-installation salt, so lookup and erasure work in both modes.

### Dependencies considered (CLAUDE.md hard rule #10)

- **Chosen: Node `crypto` AES-256-GCM + scrypt** — zero new dependencies; already
  used by TDD 0029's `secrets.ts`.
- **Rejected: libsodium / sodium-native** (ADR-0019's choice) — a native build
  dependency, with no security gain over authenticated AES-256-GCM here.
- **Rejected: SQLCipher (whole-DB)** — forces every read (incl. audit/deletion)
  through the key and pays the cost on non-PII columns. (Unchanged from ADR-0019.)
- **OS-keyring key source** — deferred behind the `KeySource` seam (a later ADR/TDD).

## Consequences

- One crypto stack and one secret across the codebase (credentials + PII).
- Audit/deletion stay key-free (ciphertext + hash companions); only PII read-back
  needs the passphrase — preserving ADR-0010's "verify the erasure happened" cheaply.
- Granularity preserved: only PII columns pay the crypto cost.
- Identity values embedded in routing tokens (`audience` / `conversationId` =
  `player:<id>`) move to `player:<hash>`, so the routing strings stop carrying
  recoverable PII while equality still works (detail in TDD 0030).
- **Open follow-ups** (tracked in TDD 0030): an OS-keyring `KeySource`; key
  rotation (alpha uses the fixed passphrase-derived key); encryption of the
  LanceDB episodic-memory text (a distinct vector-store mechanism).

## Revisit when

- An OS-keyring `KeySource` lands — it may become the default key source.
- Multi-operator deployments need key rotation or per-tenant keys.
