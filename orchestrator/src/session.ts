// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createHash } from "node:crypto";
import type { TenantDb } from "@skeinkeeper/server";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import { bucketSpecSizeKb, type BehaviorSpec } from "./behavior.js";
import type { FoundryClient } from "./foundry/client.js";
import {
  assembleHotContext,
  formatHotContextAsText,
  type DialogueTurn,
  type PresentPlayer,
  type RetrievedMemoryChunk,
  type WarmStateSnapshot,
} from "./hot_context.js";
import type { EmbeddingProvider } from "./interfaces/embedding.js";
import type { MemoryRecord, MemoryStore } from "./memory/store.js";
import { buildMemoryQuery, retrieveMemory } from "./memory/retrieval.js";
import { generateEpisodicSummary } from "./memory/summarize.js";
import { bucketDurationMs, bucketTokens } from "./interfaces/llm.js";
import type {
  LLMContent,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  StopReason,
} from "./interfaces/llm.js";
import type { ToolDispatcher } from "./registry.js";
import { toolDefinitionToLlmSpec } from "./tool_definition_to_spec.js";
import type { Eagerness } from "./voice/eagerness.js";
import type { NarrationSegment } from "./voice/markers.js";
import { StreamingNarrationSegmenter } from "./voice/streaming_segmenter.js";
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
  /** Operator's "should I respond?" calibration for the always-listening
   *  loop (design doc 0015 §2a). Runtime-tunable; defaults to Balanced. */
  eagerness?: Eagerness;
  /** Optional cold/episodic memory (design doc 0019). When set, runTurn
   *  retrieves relevant records into hot context and archiveSession stores a
   *  post-session summary. Absent = no long-term memory (warm/hot only). */
  memory?: {
    embed: EmbeddingProvider;
    store: MemoryStore;
    /** Top-K records to retrieve per responding turn. Default 4. */
    topK?: number;
  };
  /** Send a private DM to the operator for setup escalations (design doc
   *  0023). Wired by the operator app; tools reach it via ctx.notifyOperator. */
  notifyOperator?: (message: string) => Promise<void>;
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
  config.analytics?.track("behavior_spec.loaded", {
    version: config.behaviorSpec.version,
    sizeKbBucket: bucketSpecSizeKb(Buffer.byteLength(config.behaviorSpec.content, "utf8")),
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

/**
 * Archive a finished session into episodic memory (design doc 0019 §3):
 * summarize the transcript (prose + structured deltas), embed it, and upsert
 * an episodic record. Best-effort and non-fatal — called by the operator app
 * after endSession; a no-op when memory isn't configured or there's nothing
 * to summarize. Returns the stored record, or null if it didn't store one.
 */
export async function archiveSession(session: Session): Promise<MemoryRecord | null> {
  const cfg = session.config;
  if (!cfg.memory) return null;
  if (session.dialogue.length === 0) return null;
  try {
    const summary = await generateEpisodicSummary(cfg.llm, session.dialogue);
    const [vector] = await cfg.memory.embed.embed([summary.text]);
    if (vector === undefined) return null;
    const record: MemoryRecord = {
      id: `${cfg.sessionId}-episodic`,
      kind: "episodic",
      text: summary.text,
      vector,
      metadata: {
        campaignId: cfg.campaignId,
        sessionId: cfg.sessionId,
        createdAt: Date.now(),
        embedModel: cfg.memory.embed.name,
        ...(Object.keys(summary.deltas).length > 0 ? { deltas: summary.deltas } : {}),
      },
    };
    await cfg.memory.store.upsert([record]);
    return record;
  } catch {
    // Summary/embed/store failure must not break session teardown.
    return null;
  }
}

export interface TurnInput {
  speaker: string;
  displayName?: string;
  text: string;
}

/** Optional per-turn context that isn't part of the player's utterance. */
export interface TurnOptions {
  /** Voice-channel roster + character mappings (design doc 0023), surfaced in
   *  hot context so the AI can run onboarding and call record_player_character. */
  presentPlayers?: ReadonlyArray<PresentPlayer>;
  /**
   * Streamed-narration sink (design doc 0028 P1). When set, each speakable
   * segment (sentence or `[NPC:]` voice-change boundary) is emitted **as the
   * model generates it**, so the caller can start speaking segment N while
   * segment N+1 is still being produced. Fires in order; the full narration is
   * still returned + persisted as one turn. Absent = no streaming (the segment
   * split happens after the turn, as before).
   */
  onNarrationSegment?: (segment: NarrationSegment) => void;
}

export interface DispatchedToolCall {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
}

export type TurnStopReason = "end_turn" | "max_tool_iterations" | "refusal" | "llm_error";

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

/** Append a dialogue line to both the in-memory window and the persisted store
 *  (the two must stay in lockstep). Used for the player turn and the narrator
 *  turn. turnCount is a turn-level counter and stays in runTurn. */
function appendDialogue(
  cfg: SessionConfig,
  session: Session,
  turn: { speaker: string; displayName?: string; text: string },
  timestamp: number,
): void {
  const t: DialogueTurn = { speaker: turn.speaker, text: turn.text, timestamp };
  if (turn.displayName !== undefined) t.displayName = turn.displayName;
  session.dialogue.push(t);
  cfg.tenantDb.dialogue.append({
    sessionId: cfg.sessionId,
    speaker: turn.speaker,
    ...(turn.displayName !== undefined ? { displayName: turn.displayName } : {}),
    text: turn.text,
    timestamp,
  });
}

interface IterationsResult {
  narration: string;
  toolCalls: DispatchedToolCall[];
  stopReason: TurnStopReason;
  errorMessage?: string;
  iterations: number;
}

/**
 * The LLM streaming + tool-dispatch loop (the imperative core of a turn). Drives
 * the model, dispatches any tool calls, feeds results back, and repeats until
 * the model stops, errors, or hits the iteration cap. Emits `llm.completed` per
 * round-trip and `error.captured` on an LLM error (best-effort telemetry,
 * no-op until an analytics client is wired).
 */
async function runLlmIterations(
  cfg: SessionConfig,
  messages: LLMMessage[],
  toolSpecs: LLMRequest["tools"],
  turnId: string,
  maxIter: number,
  onSegment?: (segment: NarrationSegment) => void,
): Promise<IterationsResult> {
  const allToolCalls: DispatchedToolCall[] = [];
  let narration = "";
  let stopReason: TurnStopReason = "end_turn";
  let errorMessage: string | undefined;
  let iterations = 0;
  // One segmenter for the whole turn (narration can span tool-call iterations);
  // flushed once at the end. Only built when a streaming sink is wired.
  const segmenter = onSegment ? new StreamingNarrationSegmenter() : null;

  for (let i = 1; i <= maxIter; i++) {
    iterations = i;
    const iterStart = Date.now();

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
    let usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number } | null =
      null;

    for await (const ev of cfg.llm.complete(req)) {
      if (ev.kind === "text_delta") {
        narration += ev.text;
        iterationText += ev.text;
        if (segmenter && onSegment) for (const seg of segmenter.push(ev.text)) onSegment(seg);
      } else if (ev.kind === "tool_call") {
        iterationToolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.kind === "done") {
        iterationStopReason = ev.stopReason;
        usage = ev.usage;
      } else if (ev.kind === "error") {
        iterationErrored = true;
        errorMessage = `${ev.error.kind}: ${ev.error.message}`;
        cfg.analytics?.track("error.captured", {
          errorClass: ev.error.kind,
          module: "orchestrator:run_turn",
        });
        break;
      }
      // thinking_delta and compaction events ignored at this layer.
    }

    if (!iterationErrored) {
      cfg.analytics?.track("llm.completed", {
        providerName: cfg.llm.name,
        modelTier: "narration",
        success: true,
        stopReason: iterationStopReason,
        inputTokensBucket: bucketTokens(usage?.inputTokens ?? 0),
        outputTokensBucket: bucketTokens(usage?.outputTokens ?? 0),
        cacheReadTokensBucket: bucketTokens(usage?.cacheReadInputTokens ?? 0),
        durationMsBucket: bucketDurationMs(Date.now() - iterStart),
      });
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
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    messages.push({ role: "assistant", content: assistantContent });

    // Dispatch tools and collect results.
    const toolResultBlocks: LLMContent[] = [];
    const ctx = {
      tenantDb: cfg.tenantDb,
      sessionId: cfg.sessionId,
      turnId,
      caller: "llm" as const,
      foundry: cfg.foundry,
      ...(cfg.notifyOperator !== undefined ? { notifyOperator: cfg.notifyOperator } : {}),
      ...(cfg.fudgeAllowed !== undefined ? { flags: { fudgeAllowed: cfg.fudgeAllowed } } : {}),
    };
    for (const tc of iterationToolCalls) {
      const result = await cfg.dispatcher.dispatch({ name: tc.name, input: tc.input }, ctx);
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

  // Flush the final pending segment (last sentence has no trailing space).
  if (segmenter && onSegment) for (const seg of segmenter.flush()) onSegment(seg);

  const result: IterationsResult = { narration, toolCalls: allToolCalls, stopReason, iterations };
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  return result;
}

/** Run a single player turn through the AI DM. */
export async function runTurn(
  session: Session,
  input: TurnInput,
  options: TurnOptions = {},
): Promise<TurnOutput> {
  const startMs = Date.now();
  const cfg = session.config;
  const maxIter = cfg.maxToolIterations ?? DEFAULT_MAX_ITER;
  const windowSize = cfg.dialogueWindowSize ?? DEFAULT_DIALOGUE_WINDOW;
  const turnId = `${cfg.sessionId}-${startMs}`;

  // Append player turn to dialogue so it appears in hot context.
  appendDialogue(cfg, session, input, startMs);
  session.turnCount += 1;

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

  // Cold/episodic retrieval (design doc 0019) — best-effort; never blocks a turn.
  let retrievedMemory: RetrievedMemoryChunk[] = [];
  if (cfg.memory) {
    try {
      const query = buildMemoryQuery(session.dialogue);
      const records = await retrieveMemory(cfg.memory.embed, cfg.memory.store, {
        query,
        campaignId: cfg.campaignId,
        ...(cfg.memory.topK !== undefined ? { topK: cfg.memory.topK } : {}),
      });
      retrievedMemory = records.map((r) => ({ kind: r.kind, text: r.text }));
    } catch {
      // retrieval failure must not break the turn
    }
  }

  const hotContext = assembleHotContext(warmState, session.dialogue, {
    windowSize,
    retrievedMemory,
    ...(options.presentPlayers !== undefined ? { presentPlayers: options.presentPlayers } : {}),
  });
  const hotContextText = formatHotContextAsText(hotContext);

  // Tools.
  const toolSpecs = cfg.dispatcher.registry().list().map(toolDefinitionToLlmSpec);

  // Conversation: starts with one user message carrying hot context (which
  // includes recent dialogue ending with this turn's input). Grows with
  // assistant tool_use + user tool_result pairs across iterations.
  const messages: LLMMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: hotContextText }],
    },
  ];

  const {
    narration,
    toolCalls: allToolCalls,
    stopReason,
    errorMessage,
    iterations,
  } = await runLlmIterations(cfg, messages, toolSpecs, turnId, maxIter, options.onNarrationSegment);

  // Persist the AI's narration as a narrator dialogue turn so future turns
  // see it in hot context (in-memory + DB).
  if (narration.length > 0) {
    appendDialogue(cfg, session, { speaker: "narrator", text: narration }, Date.now());
  }

  // Tools may have mutated state — refresh for the output, but only if any
  // tool ran. A pure-narration turn can't have changed warm state, so the
  // common "DM just narrates" case skips a second round of Foundry reads.
  if (allToolCalls.length > 0) {
    warmState = await buildWarmStateSnapshot(cfg.foundry, cfg.tenantDb, cfg.campaignId);
  }

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
