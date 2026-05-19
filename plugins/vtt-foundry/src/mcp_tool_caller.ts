// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Minimal MCP tool-calling surface the McpFoundryClient depends on. A real
 * implementation (Phase 3-live) spawns the adambdooley bridge MCP server as
 * a subprocess and speaks the Model Context Protocol over stdio via
 * `@modelcontextprotocol/sdk`, returning the parsed JSON payload from each
 * tool's content. Tests use FakeMcpToolCaller.
 *
 * Keeping this as a one-method interface means McpFoundryClient is fully
 * unit-testable without spawning anything or depending on the MCP SDK.
 */
export interface McpToolCaller {
  /** Call an MCP tool by name; resolve with the parsed JSON the tool
   *  returned (the caller is responsible for extracting and JSON-parsing
   *  the MCP content blocks). Rejects on tool error or transport failure. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Scripted MCP caller for tests. Maps tool name → response (or a function). */
export class FakeMcpToolCaller implements McpToolCaller {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    private readonly responses: Record<
      string,
      unknown | ((args: Record<string, unknown>) => unknown)
    >,
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (!(name in this.responses)) {
      throw new Error(`FakeMcpToolCaller: no scripted response for tool "${name}"`);
    }
    const r = this.responses[name];
    return typeof r === "function"
      ? (r as (a: Record<string, unknown>) => unknown)(args)
      : r;
  }
}
