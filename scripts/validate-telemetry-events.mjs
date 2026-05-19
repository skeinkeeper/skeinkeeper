#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// Validates the telemetry event registry:
//   1. Every event has a description ≥ 10 chars and an integer version ≥ 1.
//   2. Event names match `namespace.event`.
//   3. Every code-registered event has a section heading in
//      docs/telemetry-events.md, and vice versa.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const REGISTRY_PATH = join(REPO_ROOT, "telemetry", "src", "events.ts");
const DOC_PATH = join(REPO_ROOT, "docs", "telemetry-events.md");

const mod = await import(pathToFileURL(REGISTRY_PATH).href);
const events = mod.events;

if (!events || typeof events !== "object") {
  console.error(`Failed to import events registry from ${REGISTRY_PATH}`);
  process.exit(1);
}

const errors = [];
for (const [name, def] of Object.entries(events)) {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name)) {
    errors.push(`Event "${name}" does not match namespace.event lowercase shape`);
  }
  if (!Number.isInteger(def?.v) || def.v < 1) {
    errors.push(`Event "${name}" has invalid version v=${def?.v} (must be integer ≥ 1)`);
  }
  if (typeof def?.description !== "string" || def.description.trim().length < 10) {
    errors.push(`Event "${name}" has a description shorter than 10 chars`);
  }
}

const doc = readFileSync(DOC_PATH, "utf8");
const docEvents = new Set([...doc.matchAll(/^###\s+`([^`]+)`/gm)].map((m) => m[1].split(" ")[0]));
const codeEvents = new Set(Object.keys(events));

for (const name of codeEvents) {
  if (!docEvents.has(name)) {
    errors.push(
      `Event "${name}" registered in events.ts but missing from docs/telemetry-events.md`,
    );
  }
}
for (const name of docEvents) {
  if (!codeEvents.has(name)) {
    errors.push(
      `Event "${name}" documented in docs/telemetry-events.md but missing from events.ts`,
    );
  }
}

if (errors.length > 0) {
  console.error("Telemetry registry validation failed:");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log(`Telemetry registry OK (${codeEvents.size} events).`);
