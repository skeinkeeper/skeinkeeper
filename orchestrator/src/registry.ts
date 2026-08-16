// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { z } from "zod";
import type { TenantDb } from "@skeinkeeper/server";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { FoundryClient } from "./foundry/client.js";
import type { SessionRunState } from "./session/run-state.js";
import type { SideChannelIdentityMap } from "./side_channel/identity_map.js";
import type { SurfaceRouter } from "./surfaces/router.js";
import type { Mutex } from "./util/mutex.js";

export interface ToolHandlerContext {
  tenantDb: TenantDb;
  sessionId: string;
  turnId: string;
  /** Campaign this turn belongs to (TDD 0033 telemetry). */
  campaignId?: string;
  /** Per-session transient flags (TDD 0032). Optional for older callers. */
  runState?: SessionRunState;
  /** Caller hint: did this dispatch originate from the LLM or the operator?
   *  Operator-gated tools refuse LLM invocation. */
  caller: "llm" | "operator";
  /** Per-session flags set by the orchestrator. fudge_roll honors `fudgeAllowed`. */
  flags?: { fudgeAllowed?: boolean };
  /** The session's Foundry client, so tools can perform in-play DM actions
   *  (scene switch, token moves, …) per ADR-0015. Present in real sessions;
   *  optional so unit tests can dispatch state-only tools without a VTT. */
  foundry?: FoundryClient;
  /** Send a private message to the human operator (Foundry GM chat via
   *  SurfaceRouter, TDD 0034) for setup escalations. Present in real sessions. */
  notifyOperator?: (message: string) => Promise<void>;
  /** Opt-in product analytics (ADR-0009). */
  analytics?: AnalyticsClient;
  /** Voice/session consent check for player-audience journal share (TDD 0033). */
  isPlayerConsented?: (playerId: string) => boolean;
  /**
   * TDD 0034 SurfaceRouter hook (FoundryPublicChat + DiscordVoice).
   * Default delivery writes table-audience dialogue and notifyTable.
   */
  journalShare?: JournalShareDelivery;
  /** Table-audience delivery; SessionManager wires this to SurfaceRouter. */
  notifyTable?: (message: string) => Promise<void>;
  /** Player-audience delivery; SessionManager wires this to SurfaceRouter. */
  whisperPlayer?: (playerId: string, message: string) => Promise<void>;
  /** TDD 0035: whisper / resolve_action emit through the surface router. */
  surfaces?: SurfaceRouter;
  /** TDD 0035 / 0036: Discord player id → Foundry user id. */
  resolveFoundryUserId?: (playerId: string) => string | undefined;
  /** TDD 0036: persistent 3-way map binds the ephemeral session cache. */
  identity?: SideChannelIdentityMap;
}

/** Typed 0034/0035 seam used by share_journal_to_audience. */
export interface JournalSharePayload {
  journalId: string;
  title: string;
  excerpt: string;
  framedText: string;
}

export interface JournalShareDelivery {
  shareTable(payload: JournalSharePayload): Promise<void>;
  sharePlayer(payload: JournalSharePayload & { playerId: string }): Promise<void>;
}

export interface ToolDefinition<S extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly outputSchema: O;
  readonly operatorGated?: boolean;
  /** True if this tool mutates shared world/campaign state. When the dispatcher
   *  is given a `writeSerializer`, such handlers run one-at-a-time through it so
   *  concurrent conversations (table loop + N side-channels) never race the
   *  world (design doc 0026 §3). Read-only tools run unserialized. */
  readonly mutatesWorld?: boolean;
  handle(input: z.infer<S>, ctx: ToolHandlerContext): Promise<z.infer<O>>;
}

export type AnyToolDefinition = ToolDefinition<z.ZodTypeAny, z.ZodTypeAny>;

/** Helper for defining a tool; lets the input/output types flow from the
 *  Zod schemas without redundant generic parameters at the call site. */
export function defineTool<S extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: ToolDefinition<S, O>,
): ToolDefinition<S, O> {
  return def;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register(tool: AnyToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): ReadonlyArray<AnyToolDefinition> {
    return [...this.tools.values()];
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }
}

export type ToolResult =
  | { ok: true; output: unknown; latencyMs: number }
  | {
      ok: false;
      kind: "unknown_tool" | "invalid_input" | "handler_error" | "operator_gated";
      error: string;
      latencyMs: number;
    };

export interface ToolDispatcherOptions {
  registry: ToolRegistry;
  analytics?: AnalyticsClient;
  /** Single serialized writer for world-state mutations (design doc 0026 §3).
   *  When present, `mutatesWorld` handlers run exclusively through it (FIFO);
   *  read-only handlers are unaffected. Absent = no serialization (the legacy
   *  single-table flow, where there's only ever one in-flight turn). */
  writeSerializer?: Mutex;
}

export class ToolDispatcher {
  constructor(private readonly options: ToolDispatcherOptions) {}

  /** Access the underlying registry — needed by the turn loop to enumerate
   *  available tools when building the LLM request. */
  registry(): ToolRegistry {
    return this.options.registry;
  }

  async dispatch(
    call: { name: string; input: unknown },
    ctx: ToolHandlerContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const tool = this.options.registry.get(call.name);

    if (!tool) {
      const result: ToolResult = {
        ok: false,
        kind: "unknown_tool",
        error: `Unknown tool: ${call.name}`,
        latencyMs: Date.now() - start,
      };
      this.recordAudit(call, ctx, result);
      this.recordTelemetry(call.name, false, result.latencyMs);
      return result;
    }

    if (tool.operatorGated && ctx.caller === "llm") {
      const fudgeOk = call.name === "fudge_roll" && ctx.flags?.fudgeAllowed === true;
      if (!fudgeOk) {
        const result: ToolResult = {
          ok: false,
          kind: "operator_gated",
          error: `Tool "${tool.name}" requires operator authorization`,
          latencyMs: Date.now() - start,
        };
        this.recordAudit(call, ctx, result);
        this.recordTelemetry(tool.name, false, result.latencyMs);
        return result;
      }
    }

    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      const result: ToolResult = {
        ok: false,
        kind: "invalid_input",
        error: parsed.error.message,
        latencyMs: Date.now() - start,
      };
      this.recordAudit(call, ctx, result);
      this.recordTelemetry(tool.name, false, result.latencyMs);
      return result;
    }

    try {
      const serializer = this.options.writeSerializer;
      const output =
        tool.mutatesWorld === true && serializer !== undefined
          ? await serializer.runExclusive(() => tool.handle(parsed.data, ctx))
          : await tool.handle(parsed.data, ctx);
      const result: ToolResult = { ok: true, output, latencyMs: Date.now() - start };
      this.recordAudit(call, ctx, result);
      this.recordTelemetry(tool.name, true, result.latencyMs);
      return result;
    } catch (err) {
      const result: ToolResult = {
        ok: false,
        kind: "handler_error",
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
      this.recordAudit(call, ctx, result);
      this.recordTelemetry(tool.name, false, result.latencyMs);
      return result;
    }
  }

  private recordAudit(
    call: { name: string; input: unknown },
    ctx: ToolHandlerContext,
    result: ToolResult,
  ): void {
    ctx.tenantDb.auditLog.append({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      actor: `tool:${call.name}`,
      eventType: result.ok ? "tool_called" : "tool_failed",
      payloadJson: JSON.stringify({
        input: call.input,
        result,
      }),
      timestamp: Date.now(),
    });
  }

  private recordTelemetry(toolName: string, success: boolean, latencyMs: number): void {
    this.options.analytics?.track("tool.called", {
      toolName,
      success,
      latencyMsBucket: bucketLatency(latencyMs),
    });
  }
}

function bucketLatency(ms: number): string {
  if (ms < 50) return "<50";
  if (ms < 250) return "<250";
  if (ms < 1000) return "<1000";
  if (ms < 5000) return "<5000";
  return ">=5000";
}
