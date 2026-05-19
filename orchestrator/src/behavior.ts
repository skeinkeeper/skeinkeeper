// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Behavior Spec loader per design doc 0009. The Behavior Spec is the AI DM's
 * primary system prompt (ADR-0006); loading it is deliberately small and
 * synchronous — the file is ~12KB and read once per session.
 */

export interface BehaviorSpec {
  /** The full markdown content; sent as system prompt verbatim. */
  content: string;
  /** Parsed from the spec's header, e.g., "v0.1". */
  version: string;
  /** Absolute path the spec was loaded from. */
  path: string;
}

export class BehaviorSpecError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (path: ${path})`);
    this.name = "BehaviorSpecError";
  }
}

const VERSION_REGEX = /\*\*v(\d+\.\d+)\b/;

/**
 * Read a behavior spec file, parse its version, return the spec object.
 * Throws BehaviorSpecError on missing file, unreadable file, or
 * missing/malformed version line.
 */
export function loadBehaviorSpec(path: string): BehaviorSpec {
  const abs = resolve(path);
  let content: string;
  try {
    content = readFileSync(abs, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BehaviorSpecError(`Failed to read behavior spec: ${message}`, abs);
  }
  const version = parseVersion(content);
  if (!version) {
    throw new BehaviorSpecError(
      "Could not find a version line near the top (expected `**v<MAJOR>.<MINOR>**` within the first 500 bytes).",
      abs,
    );
  }
  return { content, version, path: abs };
}

function parseVersion(content: string): string | undefined {
  const header = content.slice(0, 500);
  const match = VERSION_REGEX.exec(header);
  return match ? `v${match[1]}` : undefined;
}

/**
 * Verify the loaded spec's version matches the campaign's stored
 * `behavior_spec_version`. Phase 1.6 enforces exact-string match; Phase 2+
 * may relax to allow MINOR bumps without breaking compatibility.
 */
export function assertSpecCompatible(
  spec: BehaviorSpec,
  campaignVersion: string,
): void {
  if (spec.version === campaignVersion) return;
  throw new BehaviorSpecError(
    `Spec version mismatch: loaded ${spec.version}, campaign expects ${campaignVersion}.`,
    spec.path,
  );
}

/**
 * Walk up from `startDir` looking for `behavior/default.md`. Returns the
 * absolute path of the first hit. Useful when the caller knows it's
 * somewhere inside the repo but doesn't know the exact relative path
 * (eval harness, tests).
 */
export function findDefaultBehaviorSpec(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, "behavior", "default.md");
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new BehaviorSpecError(
        `Could not find behavior/default.md walking up from ${startDir}.`,
        startDir,
      );
    }
    dir = parent;
  }
}

/**
 * Bucket helper for the `behavior_spec.loaded` telemetry event. Same
 * coarse buckets the rest of the registry uses; no exact size leaked.
 */
export function bucketSpecSizeKb(byteLength: number): string {
  const kb = byteLength / 1024;
  if (kb < 5) return "<5";
  if (kb < 15) return "<15";
  if (kb < 50) return "<50";
  return ">=50";
}
