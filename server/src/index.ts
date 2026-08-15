// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

export { openDb, type Db, type OpenOptions } from "./db.js";
export * as schema from "./schema/index.js";
export {
  ErasureService,
  type DeletionAdapter,
  type ErasureScope,
  type ErasureReport,
  type ErasureServiceOptions,
} from "./erasure.js";
export {
  ExportService,
  type ExportAdapter,
  type ExportPayload,
  type ExportBundle,
} from "./export.js";
export { ConsentsAdapter } from "./adapters/consents-adapter.js";
export { CampaignAdapter } from "./adapters/campaign-adapter.js";
export { AuditLogAdapter } from "./adapters/audit-log-adapter.js";
export { DialogueAdapter } from "./adapters/dialogue-adapter.js";
export { PlayerCharacterMapAdapter } from "./adapters/player-character-map-adapter.js";
export { SessionIntakeFindingAdapter } from "./adapters/session-intake-finding-adapter.js";
export { loadOrCreateSalt } from "./salt.js";
export { seal, open, SecretOpenError } from "./secrets.js";
export {
  createPiiCrypto,
  defaultPiiCrypto,
  PiiDecryptError,
  type PiiCrypto,
} from "./column_crypto.js";
export {
  EnvKeySource,
  SEALABLE_KEYS,
  SecretStoreError,
  loadEffectiveEnv,
  loadSealedSecrets,
  sealSecrets,
  sealedKeyNames,
  type KeySource,
} from "./secret_store.js";
export { runCli } from "./cli.js";
export { TenantDb } from "./tenant_db.js";
export { seedFromFile } from "./seed.js";
export {
  TABLE_AUDIENCE,
  GM_AUDIENCE,
  TABLE_CONVERSATION,
  playerAudience,
  playerConversation,
  isPlayerScoped,
  playerIdOf,
  type Audience,
  type AudienceHasher,
  type ConversationId,
} from "./audience.js";
