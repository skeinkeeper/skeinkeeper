// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

export {
  ToolRegistry,
  ToolDispatcher,
  defineTool,
  type ToolDefinition,
  type AnyToolDefinition,
  type ToolHandlerContext,
  type ToolResult,
  type ToolDispatcherOptions,
} from "./registry.js";
export { rollFormula, type RollResult } from "./dice.js";
export {
  BUILTIN_TOOLS,
  registerBuiltinTools,
  createDefaultRegistry,
} from "./tools/index.js";
export {
  assembleHotContext,
  formatHotContextAsText,
  type HotContext,
  type HotContextOptions,
  type WarmStateSnapshot,
  type LocationSnapshot,
  type CampaignSnapshot,
  type DialogueTurn,
} from "./hot_context.js";
export { buildWarmStateSnapshot, summarizeWarmStateForOperator } from "./warm_state.js";
export {
  type FoundryClient,
  type FoundryActor,
  type FoundryScene,
  type FoundrySceneToken,
  type RollResult as FoundryRollResult,
} from "./foundry/client.js";
export { MockFoundryClient, type MockFoundryClientOptions } from "./foundry/mock.js";
export { renderActorState } from "./foundry/render.js";
export * from "./interfaces/index.js";
export { toolDefinitionToLlmSpec } from "./tool_definition_to_spec.js";
export {
  Session,
  runTurn,
  startSession,
  endSession,
  type DispatchedToolCall,
  type SessionConfig,
  type TurnInput,
  type TurnOutput,
  type TurnStopReason,
} from "./session.js";
export {
  runVoiceSession,
  VOICE_CONSENT_TEXT,
  VOICE_CONSENT_TEXT_VERSION,
  type VoiceSessionConfig,
} from "./voice_session.js";
export {
  BehaviorSpecError,
  assertSpecCompatible,
  bucketSpecSizeKb,
  findDefaultBehaviorSpec,
  loadBehaviorSpec,
  type BehaviorSpec,
} from "./behavior.js";
