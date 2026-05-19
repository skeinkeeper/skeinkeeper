#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// Verifies every TypeScript/JavaScript source file in the tracked code dirs
// carries the SPDX header from LICENSE-HEADER.txt. Used by CI and by the
// pre-commit hook.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const HEADER = readFileSync(join(REPO_ROOT, "LICENSE-HEADER.txt"), "utf8").trim();

const CODE_DIRS = [
  "packages",
  "plugins",
  "orchestrator",
  "telemetry",
  "web",
  "server",
  "eval",
  "scripts",
];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".next"]);

function walk(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      files.push(...walk(full));
    } else if (CODE_EXTENSIONS.has(full.slice(full.lastIndexOf("."))) && !full.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

const offenders = [];
for (const dir of CODE_DIRS) {
  for (const file of walk(join(REPO_ROOT, dir))) {
    const content = readFileSync(file, "utf8");
    if (!content.startsWith(HEADER) && !content.startsWith(`#!/usr/bin/env node\n${HEADER}`)) {
      offenders.push(relative(REPO_ROOT, file));
    }
  }
}

if (offenders.length > 0) {
  console.error("Files missing the SPDX license header (see LICENSE-HEADER.txt):");
  for (const f of offenders) console.error(`  ${f}`);
  process.exit(1);
}

console.log("All source files have the SPDX license header.");
