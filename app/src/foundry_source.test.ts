// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { foundryWorldContentReader, MockFoundryClient } from "@skeinkeeper/orchestrator";
import { loadOrCreatePairingSecret } from "./foundry_source.js";

describe("foundryWorldContentReader", () => {
  it("indexes journals through FoundryClient, not MCP tool names", async () => {
    const client = new MockFoundryClient({
      system: "dnd5e",
      journalHits: [{ id: "j1", name: "Only the name" }],
    });
    const reader = foundryWorldContentReader(client);
    const journals = await reader.readJournals();
    expect(journals[0]?.text).toBe("Only the name");
    expect(journals[0]?.folder).toBeUndefined();
  });
});

describe("loadOrCreatePairingSecret", () => {
  const freshDir = (): string => mkdtempSync(join(tmpdir(), "skein-pair-"));

  it("returns an operator-set secret verbatim and persists nothing", () => {
    const dir = freshDir();
    expect(loadOrCreatePairingSecret(dir, "  operator-set-secret  ")).toBe("operator-set-secret");
    expect(existsSync(join(dir, ".foundry-pairing-secret"))).toBe(false);
  });

  it("generates and persists a secret when unset, so pairing survives a restart", () => {
    const dir = freshDir();
    const first = loadOrCreatePairingSecret(dir, "");
    expect(first.length).toBeGreaterThanOrEqual(16);

    const path = join(dir, ".foundry-pairing-secret");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600); // owner-only

    // A later boot (empty env again) reuses the persisted secret rather than
    // regenerating it and forcing a re-pair.
    expect(loadOrCreatePairingSecret(dir, "")).toBe(first);
  });
});
