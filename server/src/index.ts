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
export { loadOrCreateSalt } from "./salt.js";
export { runCli } from "./cli.js";
export { TenantDb } from "./tenant_db.js";
export { seedFromFile } from "./seed.js";
