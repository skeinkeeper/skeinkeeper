// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { foundryWorldContentReader, MockFoundryClient } from "@skeinkeeper/orchestrator";

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
