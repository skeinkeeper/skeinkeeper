#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// PostToolUse hook for Claude Code. Runs Prettier (and ESLint for code files)
// on the file that was just edited. Blocks the edit on failure.
//
// Reads the hook payload as JSON on stdin and exits non-zero to signal failure.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RELEVANT = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml)$/;
const LINTABLE = /\.(ts|tsx|js|mjs|cjs)$/;

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // No payload — nothing to do.
  process.exit(0);
}

const file = payload?.tool_input?.file_path;
if (typeof file !== "string" || !RELEVANT.test(file)) process.exit(0);

const quoted = JSON.stringify(file);
try {
  execSync(`pnpm prettier --write ${quoted}`, { stdio: "inherit" });
  if (LINTABLE.test(file)) {
    execSync(`pnpm eslint --fix ${quoted}`, { stdio: "inherit" });
  }
} catch {
  process.exit(2); // Non-zero blocks the tool call per Claude Code hook conventions.
}
