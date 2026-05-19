// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// No .js extensions on these re-exports: drizzle-kit reads this file at
// generate-time via plain CJS require() and can't resolve TS-style .js
// imports. moduleResolution=bundler in tsconfig accepts the extensionless
// form, so both drizzle-kit and tsc are happy.
//
// Per design doc 0007: Foundry owns mechanical state (characters, NPCs,
// locations, faction relationships). Skeinkeeper owns AI-DM-specific
// state only.
export * from "./tenants";
export * from "./campaigns";
export * from "./sessions";
export * from "./dialogue";
export * from "./audit_log";
export * from "./consents";
export * from "./deletion_log";
export * from "./quest_flags";
