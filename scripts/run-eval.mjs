#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// Thin wrapper that invokes the eval harness CLI in the eval/ workspace.
// The real implementation lives in eval/src/cli.ts.

import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["--filter", "@skeinkeeper/eval", "eval"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
