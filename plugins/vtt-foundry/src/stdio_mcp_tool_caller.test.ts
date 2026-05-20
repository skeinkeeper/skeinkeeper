// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { extractToolResult, McpToolError } from "./stdio_mcp_tool_caller.js";

describe("extractToolResult", () => {
  it("JSON-parses the text content into the data payload", () => {
    const res = {
      content: [{ type: "text", text: JSON.stringify({ id: "w1", system: "dnd5e" }) }],
    };
    expect(extractToolResult(res)).toEqual({ id: "w1", system: "dnd5e" });
  });

  it("returns a plain string when the content isn't JSON", () => {
    const res = { content: [{ type: "text", text: "scene switched" }] };
    expect(extractToolResult(res)).toBe("scene switched");
  });

  it("throws McpToolError when isError is set", () => {
    const res = { isError: true, content: [{ type: "text", text: "Error: Foundry unavailable" }] };
    expect(() => extractToolResult(res)).toThrow(McpToolError);
  });

  it("returns null for empty content", () => {
    expect(extractToolResult({ content: [] })).toBeNull();
    expect(extractToolResult({})).toBeNull();
  });
});
