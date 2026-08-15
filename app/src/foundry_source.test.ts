// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { MockFoundryClient } from "@skeinkeeper/orchestrator";
import { FakeMcpToolCaller } from "@skeinkeeper/vtt-foundry";
import { resolveWorldContent } from "./foundry_source.js";

describe("resolveWorldContent", () => {
  it("uses the MCP world-content reader when a caller is present", async () => {
    const caller = new FakeMcpToolCaller({
      "list-journals": {
        journals: [
          {
            id: "j1",
            name: "Phandalin",
            content: "A frontier town.",
            folder: "Locations",
            _modifiedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      },
    });
    const reader = resolveWorldContent({
      caller,
      client: new MockFoundryClient({ system: "dnd5e" }),
    });
    const journals = await reader.readJournals();
    expect(journals[0]?.text).toContain("frontier town");
    expect(journals[0]?.folder).toBe("Locations");
    expect(journals[0]?.modifiedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("falls back to FoundryClient search when no caller is present", async () => {
    const client = new MockFoundryClient({
      system: "dnd5e",
      journalHits: [{ id: "j1", name: "Only the name" }],
    });
    const reader = resolveWorldContent({ client });
    const journals = await reader.readJournals();
    expect(journals[0]?.text).toBe("Only the name");
    expect(journals[0]?.folder).toBeUndefined();
  });
});
