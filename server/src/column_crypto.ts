// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";
import type { KeySource } from "./secret_store.js";

/**
 * Per-column PII encryption (TDD 0030, ADR-0022). Mirrors the credential
 * store's primitive — authenticated AES-256-GCM with a scrypt-derived key, Node
 * `crypto` only, zero dependencies — but applies it per column and adds a salted
 * deterministic hash companion for equality lookups and erasure.
 *
 * Two independent capabilities:
 *
 *   - **Value encryption** (`enc`/`dec`) is gated on the same passphrase
 *     `KeySource` as the sealed credential store (TDD 0029). With a passphrase,
 *     values are AES-256-GCM ciphertext at rest; without one they pass through as
 *     plaintext — the honest alpha default, since a key kept next to the data on
 *     disk would not be encryption-at-rest (ADR-0022 gating).
 *   - **The hash companion** (`hash`) uses only the always-present per-install
 *     salt, never the passphrase, so per-subject lookup and erasure work in both
 *     modes and stay **key-free** (ADR-0010 #4 / ADR-0022).
 *
 * `enc` output is tagged with a `gcm:` prefix so `dec` and the `pii:encrypt`
 * migration can tell ciphertext from legacy plaintext and operate on a
 * half-migrated table.
 */
export interface PiiCrypto {
  /** True when a passphrase is available (value encryption on). */
  readonly enabled: boolean;
  /** AES-256-GCM with the derived column key; passthrough when `!enabled`. */
  enc(plaintext: string): string;
  /** Decrypt tagged ciphertext; passthrough for untagged legacy plaintext. */
  dec(stored: string): string;
  /** Salted deterministic hash for equality/erasure (always available). */
  hash(value: string): string;
}

/** Raised when a tagged value cannot be decrypted (wrong passphrase or corrupt data). */
export class PiiDecryptError extends Error {
  constructor(message = "could not decrypt PII column (wrong passphrase or corrupt data)") {
    super(message);
    this.name = "PiiDecryptError";
  }
}

const ALGO = "aes-256-gcm";
/** Tag distinguishing AES-256-GCM ciphertext from legacy plaintext. */
const CIPHERTEXT_PREFIX = "gcm:";
/**
 * scrypt derivation label, distinct from credential sealing, so the same
 * passphrase yields a different key for PII columns (ADR-0022).
 */
const COLUMN_KEY_LABEL = "pii-column";

function deriveColumnKey(passphrase: string, salt: string): Buffer {
  return scryptSync(passphrase, `${COLUMN_KEY_LABEL}:${salt}`, 32);
}

export function createPiiCrypto(opts: { keySource: KeySource; salt: string }): PiiCrypto {
  const passphrase = opts.keySource.getPassphrase();
  const enabled = passphrase !== undefined;
  const key = enabled ? deriveColumnKey(passphrase, opts.salt) : undefined;

  return {
    enabled,

    enc(plaintext: string): string {
      if (key === undefined) return plaintext; // disabled: plaintext at rest
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGO, key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return CIPHERTEXT_PREFIX + [iv, tag, ct].map((b) => b.toString("base64")).join(".");
    },

    dec(stored: string): string {
      // Disabled: nothing we wrote is ciphertext, so everything is plaintext.
      if (key === undefined) return stored;
      // Enabled but untagged: legacy plaintext from before encryption was turned
      // on — return it unchanged so reads work mid-migration.
      if (!stored.startsWith(CIPHERTEXT_PREFIX)) return stored;
      const parts = stored.slice(CIPHERTEXT_PREFIX.length).split(".");
      if (parts.length !== 3) throw new PiiDecryptError();
      try {
        const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64"));
        const decipher = createDecipheriv(ALGO, key, iv!);
        decipher.setAuthTag(tag!);
        return Buffer.concat([decipher.update(ct!), decipher.final()]).toString("utf8");
      } catch {
        throw new PiiDecryptError();
      }
    },

    hash(value: string): string {
      // HMAC-SHA-256 keyed by the per-install salt (same family as
      // ErasureService.hashSubject). Key-free w.r.t. the passphrase.
      return createHmac("sha256", opts.salt).update(value).digest("hex");
    },
  };
}

/**
 * A disabled PiiCrypto for contexts that don't inject one (tests, and the
 * back-compat default on TenantDb / the deletion adapters). Encryption is OFF
 * (plaintext passthrough) and the hash uses a fixed dev salt — NEVER turns on
 * encryption. Production paths (bootstrap, the CLI) MUST inject a real one built
 * from the per-install salt + KeySource so runtime writes and CLI erasure agree
 * on the hash. A forgotten injection leaves encryption off (the alpha default),
 * never a plaintext-vs-ciphertext mismatch, because only an injected passphrase
 * turns encryption on.
 */
export function defaultPiiCrypto(): PiiCrypto {
  return createPiiCrypto({
    keySource: { getPassphrase: () => undefined },
    salt: "skeinkeeper-default-pii-hash-salt",
  });
}
