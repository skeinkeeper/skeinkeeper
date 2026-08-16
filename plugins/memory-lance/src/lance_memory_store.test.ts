// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "@skeinkeeper/orchestrator";
import { LanceMemoryStore } from "./lance_memory_store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function rec(
  id: string,
  location: string,
  extras: Partial<MemoryRecord["metadata"]> = {},
): MemoryRecord {
  return {
    id,
    kind: "cold",
    text: id,
    vector: [1, 0],
    metadata: {
      campaignId: "c1",
      createdAt: 1,
      embedModel: "fake",
      source: "world-journal",
      location,
      ...extras,
    },
  };
}

describe("LanceMemoryStore.byMetadata (TDD 0032)", () => {
  it("filters by location and excludes tombstones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-lance-"));
    dirs.push(dir);
    const store = new LanceMemoryStore({ dir, dimensions: 2 });
    await store.upsert([
      rec("j-phandalin", "Phandalin", { foundry_id: "j1" }),
      rec("j-wave", "Wave Echo Cave", { foundry_id: "j2" }),
      rec("j-dead", "Phandalin", { foundry_id: "j3", tombstoned: true }),
    ]);
    const out = await store.byMetadata({ campaignId: "c1", location: "Phandalin" });
    expect(out.map((r) => r.id)).toEqual(["j-phandalin"]);
    expect(out[0]?.metadata.foundry_id).toBe("j1");
  });
});
