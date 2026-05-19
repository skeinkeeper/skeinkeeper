// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createHash } from "node:crypto";
import type { TenantDb } from "@skeinkeeper/server";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { BehaviorSpec } from "./behavior.js";
import type { FoundryClient } from "./foundry/client.js";
import {
  assembleHotContext,
  formatHotContextAsText,
  type DialogueTurn,
  type WarmStateSnapshot,
} from "./hot_context.js";
import { bucketDurationMs } from "./interfaces/llm.js";
import type {
  LLMContent,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  StopReason,
} from "./interfaces/llm.js";
import type { ToolDispatcher } from "./registry.js";
import { toolDefinitionToLlmSpec } from "./tool_definition_to_spec.js";
import { buildWarmStateSnapshot } from "./warm_state.js";

/**
 * Orchestrator turn loop per design doc 0011. Pulls the Phase 1 pieces
 * (behavior spec, hot context, warm state, LLM provider, tool dispatcher,
 * audit log) into a single runTurn(input) function.
 */

export interface SessionConfig {
  /** Identifies this orchestration; used in audit-log rows. */
  sessionId: string;
  /** The campaign this session is for. */
  campaignId: string;
  /** Loaded once at session start; cached for every turn. */
  behaviorSpec: BehaviorSpec;
  /** LLM provider for this session. */
  llm: LLMProvider;
  /** Tool dispatcher. */
  dispatcher: ToolDispatcher;
  /** Where mechanical state comes from. */
  foundry: FoundryClient;
  /** Tenant-scoped DB accessor for AI-DM state. */
  tenantDb: TenantDb;
  /** Optional analytics client. */
  analytics?: AnalyticsClient;
  /** Defaults to 10. Bound on tool-dispatch iterations per turn. */
  maxToolIterations?: number;
  /** Defaults to 20. Sliding-window size for hot-context dialogue. */
  dialogueWindowSize?: number;
  /** Per-session flag set by the operator; controls whether fudge_roll
   *  may be invoked by the LLM. */
  fudgeAllowed?: boolean;
}

export class Session {
  /** Dialogue history, hydrated from TenantDb by startSession and appended
   *  to (in-memory + persisted) on each turn. */
  readonly dialogue: DialogueTurn[] = [];
  /** Number of turns processed in this session; used for session.ended. */
  turnCount = 0;

  constructor(readonly config: SessionConfig) {}
}

/**
 * Begin a session: create (or resume) the persisted session row, hydrate
 * the in-memory dialogue from any prior turns, and emit session.started.
 * The proper entry point before calling runTurn — runTurn persists dialogue
 * rows that FK-reference the session row created here.
 */
export function startSession(config: SessionConfig): Session {
  const session = new Session(config);
  const now = Date.now();

  const existing = config.tenantDb.sessions.get(config.sessionId);
  if (!existing) {
    config.tenantDb.sessions.create({
      id: config.sessionId,
      campaignId: config.campaignId,
      behaviorSpecVersion: config.behaviorSpec.version,
      startedAt: now,
    });
  }

  // Resume: hydrate in-memory dialogue from persisted turns.
  for (const row of config.tenantDb.dialogue.listBySession(config.sessionId)) {
    const t: DialogueTurn = { speaker: row.speaker, text: row.text, timestamp: row.timestamp };
    if (row.displayName != null) t.displayName = row.displayName;
    session.dialogue.push(t);
  }

  const campaign = config.tenantDb.campaigns.get(config.campaignId);
  config.analytics?.track("session.started", {
    campaignIdHash: hashHex(config.campaignId, 16),
    rulesetId: campaign?.rulesetId ?? "unknown",
  });

  return session;
}

/** End a session: stamp endedAt, store an optional summary, emit session.ended. */
export function endSession(session: Session, summaryJson?: string): void {
  const cfg = session.config;
  const row = cfg.tenantDb.sessions.get(cfg.sessionId);
  const endedAt = Date.now();
  cfg.tenantDb.sessions.end(cfg.sessionId, endedAt, summaryJson);
  const startedAt = row?.startedAt ?? endedAt;
  const durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  cfg.analytics?.track("session.ended", {
    campaignIdHash: hashHex(cfg.campaignId, 16),
    durationSecBucket: bucketDurationSec(durationSec),
    turnCount: session.turnCount,
  });
}

export interface TurnInput {
  speaker: string;
  displayName?: string;
  text: string;
}

export interface DispatchedToolCall {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
}

export type TurnStopReason =
  | "end_turn"
  | "max_tool_iterations"
  | "refusal"
  | "llm_error";

export interface TurnOutput {
  narration: string;
  toolCalls: ReadonlyArray<DispatchedToolCall>;
  warmStateAfter: WarmStateSnapshot;
  stopReason: TurnStopReason;
  /** LLM-side error info if stopReason is `llm_error`. */
  errorMessage?: string;
  /** Number of LLM round-trips performed (1 if no tool calls). */
  iterations: number;
}

const DEFAULT_MAX_ITER = 10;
const DEFAULT_DIALOGUE_WINDOW = 20;

/** Run a single player turn through the AI DM. */
export async function runTurn(
  session: Session,
  input: TurnInput,
): Promise<TurnOutput> {
  const startMs = Date.now();
  const cfg = session.config;
  const maxIter = cfg.maxToolIterations ?? DEFAULT_MAX_ITER;
  const windowSize = cfg.dialogueWindowSize ?? DEFAULT_DIALOGUE_WINDOW;
  const turnId = `${cfg.sessionId}-${startMs}`;

  // Append player turn to dialogue so it appears in hot context.
  const dialogueTurn: DialogueTurn = {
    speaker: input.speaker,
    text: input.text,
    timestamp: startMs,
  };
  if (input.displayName !== undefined) dialogueTurn.displayName = input.displayName;
  session.dialogue.push(dialogueTurn);
  session.turnCount += 1;
  cfg.tenantDb.dialogue.append({
    sessionId: cfg.sessionId,
    speaker: input.speaker,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    text: input.text,
    timestamp: startMs,
  });

  // Audit: turn start.
  appendAudit(cfg, {
    actor: "orchestrator:run_turn",
    eventType: "turn_started",
    payloadJson: JSON.stringify({
      speaker: input.speaker,
      displayName: input.displayName,
      textHash: hashHex(input.text, 12),
    }),
    sessionId: cfg.sessionId,
    turnId,
    timestamp: startMs,
  });

  // Assemble state.
  let warmState = await buildWarmStateSnapshot(cfg.foundry, cfg.tenantDb, cfg.campaignId);
  const hotContext = assembleHotContext(warmState, session.dialogue, { windowSize });
  const hotContextText = formatHotContextAsText(hotContext);

  // Tools.
  const toolSpecs = cfg.dispatcher
    .registry()
    .list()
    .map(toolDefinitionToLlmSpec);

  // Conversation: starts with one user message carrying hot context (which
  // includes recent dialogue ending with this turn's input). Grows with
  // assistant tool_use + user tool_result pairs across iterations.
  const messages: LLMMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: hotContextText }],
    },
  ];

  const allToolCalls: DispatchedToolCall[] = [];
  let narration = "";
  let stopReason: TurnStopReason = "end_turn";
  let errorMessage: string | undefined;
  let iterations = 0;

  for (let i = 1; i <= maxIter; i++) {
    iterations = i;

    const req: LLMRequest = {
      systemPrompt: cfg.behaviorSpec.content,
      messages,
      tools: toolSpecs,
      modelTier: "narration",
    };

    const iterationToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let iterationText = "";
    let iterationStopReason: StopReason = "end_turn";
    let iterationErrored = false;

    for await (const ev of cfg.llm.complete(req)) {
      if (ev.kind === "text_delta") {
        narration += ev.text;
        iterationText += ev.text;
      } else if (ev.kind === "tool_call") {
        iterationToolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.kind === "done") {
        iterationStopReason = ev.stopReason;
      } else if (ev.kind === "error") {
        iterationErrored = true;
        errorMessage = `${ev.error.kind}: ${ev.error.message}`;
        break;
      }
      // thinking_delta and compaction events ignored at this layer.
    }

    if (iterationErrored) {
      stopReason = "llm_error";
      break;
    }

    if (iterationToolCalls.length === 0) {
      stopReason = iterationStopReason === "refusal" ? "refusal" : "end_turn";
      break;
    }

    // Append assistant response (text + tool_use blocks).
    const assistantContent: LLMContent[] = [];
    if (iterationText.length > 0) {
      assistantContent.push({ type: "text", text: iterationText });
    }
    for (const tc of iterationToolCalls) {
      assistantContent.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }
    messages.push({ role: "assistant", content: assistantContent });

    // Dispatch tools and collect results.
    const toolResultBlocks: LLMContent[] = [];
    const ctx = {
      tenantDb: cfg.tenantDb,
      sessionId: cfg.sessionId,
      turnId,
      caller: "llm" as const,
      ...(cfg.fudgeAllowed !== undefined ? { flags: { fudgeAllowed: cfg.fudgeAllowed } } : {}),
    };
    for (const tc of iterationToolCalls) {
      const result = await cfg.dispatcher.dispatch(
        { name: tc.name, input: tc.input },
        ctx,
      );
      const dispatched: DispatchedToolCall = {
        id: tc.id,
        name: tc.name,
        input: tc.input,
        output: result.ok ? result.output : { error: result.kind, message: result.error },
        ok: result.ok,
      };
      allToolCalls.push(dispatched);
      const resultBlock: LLMContent = {
        type: "tool_result",
        toolUseId: tc.id,
        content: JSON.stringify(dispatched.output),
      };
      if (!result.ok) resultBlock.isError = true;
      toolResultBlocks.push(resultBlock);
    }
    messages.push({ role: "user", content: toolResultBlocks });

    if (i === maxIter) {
      stopReason = "max_tool_iterations";
    }
  }

  // Persist the AI's narration as a narrator dialogue turn so future turns
  // see it in hot context (in-memory + DB).
  if (narration.length > 0) {
    const narratorTs = Date.now();
    session.dialogue.push({ speaker: "narrator", text: narration, timestamp: narratorTs });
    cfg.tenantDb.dialogue.append({
      sessionId: cfg.sessionId,
      speaker: "narrator",
      text: narration,
      timestamp: narratorTs,
    });
  }

  // Tools may have mutated state — refresh once at end for the output.
  warmState = await buildWarmStateSnapshot(cfg.foundry, cfg.tenantDb, cfg.campaignId);

  // Audit: turn end.
  const durationMs = Date.now() - startMs;
  appendAudit(cfg, {
    actor: "orchestrator:run_turn",
    eventType: "turn_completed",
    payloadJson: JSON.stringify({
      stopReason,
      iterations,
      toolCallCount: allToolCalls.length,
      durationMsBucket: bucketDurationMs(durationMs),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    }),
    sessionId: cfg.sessionId,
    turnId,
    timestamp: Date.now(),
  });

  const out: TurnOutput = {
    narration,
    toolCalls: allToolCalls,
    warmStateAfter: warmState,
    stopReason,
    iterations,
  };
  if (errorMessage !== undefined) out.errorMessage = errorMessage;
  return out;
}

interface AuditEntry {
  sessionId: string;
  turnId: string;
  actor: string;
  eventType: string;
  payloadJson: string;
  timestamp: number;
}

function appendAudit(cfg: SessionConfig, entry: AuditEntry): void {
  cfg.tenantDb.auditLog.append(entry);
}

function hashHex(s: string, len: number): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, len);
}

function bucketDurationSec(sec: number): string {
  if (sec < 15 * 60) return "<15m";
  if (sec < 60 * 60) return "15-60m";
  if (sec < 2 * 3600) return "1-2h";
  if (sec < 4 * 3600) return "2-4h";
  return ">4h";
}
