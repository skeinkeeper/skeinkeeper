// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { PiiCrypto } from "./column_crypto.js";
import type { Consent, DialogueRow, PlayerCharacterMapRow } from "./schema/index.js";

/**
 * Per-row decryption of PII columns (TDD 0030). One place that knows which
 * columns are AEAD-encrypted per table, shared by TenantDb's read paths and the
 * export adapters so the two can't drift. `dec` passes legacy plaintext through
 * untouched, so these are safe to apply to half-migrated rows.
 */

export function decryptConsentRow(crypto: PiiCrypto, row: Consent): Consent {
  return { ...row, subjectId: crypto.dec(row.subjectId) };
}

export function decryptPcmapRow(
  crypto: PiiCrypto,
  row: PlayerCharacterMapRow,
): PlayerCharacterMapRow {
  return {
    ...row,
    discordUserId: crypto.dec(row.discordUserId),
    foundryUserId: row.foundryUserId === null ? null : crypto.dec(row.foundryUserId),
    displayName: row.displayName === null ? null : crypto.dec(row.displayName),
  };
}

export function decryptDialogueRow(crypto: PiiCrypto, row: DialogueRow): DialogueRow {
  return {
    ...row,
    speaker: crypto.dec(row.speaker),
    text: crypto.dec(row.text),
    displayName: row.displayName === null ? null : crypto.dec(row.displayName),
  };
}
