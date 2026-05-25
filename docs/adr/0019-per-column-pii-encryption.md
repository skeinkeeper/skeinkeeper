# ADR-0019: Per-column AEAD encryption for PII, keyed from the OS keyring

Status: superseded by [ADR-0022](./0022-pii-encryption-node-crypto.md)
Date: 2026-05-24
Scope: privacy
Relates to: ADR-0010

> This ADR formalizes a decision originally made and recorded in
> [TDD 0002 (Privacy Foundation)](../tdd/0002-privacy-foundation.md). ADR-0010 commits
> the project to encryption-at-rest as a *mechanism* but does not fix the *approach*; this ADR
> records the approach. Implementation detail (the `encryptedColumn()` helpers, nonce handling,
> the `consents`/`deletion_log` tables) stays in TDD 0002.

## Context

ADR-0010 ("privacy as architecture") commits Skeinkeeper to encrypting PII-marked fields at
rest, but leaves the cryptographic approach open. The approach is cross-cutting: every feature
that persists a `PII<T>`-marked field inherits it, and it must not foreclose the audit and
deletion paths that ADR-0010 also requires (an operator must be able to verify a row was
deleted without needing to decrypt it).

## Decision

**Encrypt PII-marked columns per-column with AEAD, keyed from the OS keyring.**

- Per-column **AEAD** (XSalsa20-Poly1305 via `libsodium`-bindings) on `PII<T>`-marked columns.
  The data-access layer wraps reads/writes through `encryptedColumn(name)` helpers (nonce
  generation, ciphertext storage, decrypt-on-read).
- The key is sourced from the **OS keyring** (libsecret on Linux, Keychain on macOS, Credential
  Manager on Windows) and never written to disk in plaintext (per ADR-0010).
- **Per-column, not whole-DB.**

### Dependencies considered (per CLAUDE.md hard rule #10)

- **Chosen: `libsodium` per-column AEAD.** Fully OSS, audited, cross-platform; lets audit and
  deletion paths operate on ciphertext without the key.
- **Rejected: SQLCipher (whole-DB encryption).** Forces *every* read through the key, including
  the audit/deletion paths that only need to confirm a row exists or was removed. Whole-DB also
  pays the encryption cost on non-PII columns that don't need it.

## Consequences

- Audit and deletion code paths work **without** the plaintext key — only feature code that
  reads PII plaintext needs it. This is what keeps ADR-0010's "verify the erasure happened"
  commitment cheap.
- Granularity: only PII columns pay the crypto cost.
- **Open follow-ups** (tracked in TDD 0002, not this ADR): key rotation (deferred to v0.5;
  alpha runs a fixed key) and a per-installation salt for `subject_id_hash` to prevent
  cross-installation correlation.
