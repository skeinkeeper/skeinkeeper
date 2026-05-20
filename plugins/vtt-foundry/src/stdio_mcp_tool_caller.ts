// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpToolCaller } from "./mcp_tool_caller.js";

/**
 * Real MCP transport for the OSS Foundry bridge (ADR-0011, design doc 0014).
 * The adambdooley `@foundry-mcp/server` speaks MCP over **stdio**, so this
 * spawns it as a subprocess and calls its tools via `@modelcontextprotocol/sdk`.
 * The bridge wraps each tool result as `{ content: [{ type: "text", text:
 * JSON.stringify(data) }], isError? }`; `extractToolResult` unwraps that back to
 * the data payload `McpFoundryClient` expects.
 *
 * LIVE-VALIDATION REQUIRED — needs the bridge built + Foundry running. The
 * unwrap logic is pure and unit-tested; the spawn/transport is operator-validated.
 */
export interface StdioMcpToolCallerOptions {
  /** Executable to spawn, e.g. "node". */
  command: string;
  /** Args, e.g. ["/path/to/foundry-vtt-mcp/packages/mcp-server/dist/index.js"]. */
  args?: string[];
  /** Environment for the spawned bridge (it reads its Foundry-link config here). */
  env?: Record<string, string>;
  cwd?: string;
  clientName?: string;
}

export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

interface ToolResultShape {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

/** Unwrap an MCP CallToolResult to the data payload (pure; unit-tested). */
export function extractToolResult(res: unknown): unknown {
  const r = (res ?? {}) as ToolResultShape;
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  if (r.isError === true) {
    throw new McpToolError(text.length > 0 ? text : "MCP tool returned an error");
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text; // a plain-string tool result
  }
}

export class StdioMcpToolCaller implements McpToolCaller {
  private client: Client | null = null;

  constructor(private readonly options: StdioMcpToolCallerOptions) {}

  async connect(): Promise<void> {
    if (this.client !== null) return;
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args ?? [],
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
      ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
    });
    const client = new Client({ name: this.options.clientName ?? "skeinkeeper", version: "0.0.0" });
    await client.connect(transport);
    this.client = client;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.client === null) await this.connect();
    const res = await this.client!.callTool({ name, arguments: args });
    return extractToolResult(res);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
