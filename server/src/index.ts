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
export { loadOrCreateSalt } from "./salt.js";
export { runCli } from "./cli.js";
