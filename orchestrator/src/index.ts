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
export { rollFormula, type RollResult, type RollOptions } from "./dice.js";
export { BUILTIN_TOOLS, registerBuiltinTools, createDefaultRegistry } from "./tools/index.js";
export {
  assembleHotContext,
  formatHotContextAsText,
  type HotContext,
  type HotContextOptions,
  type WarmStateSnapshot,
  type LocationSnapshot,
  type CampaignSnapshot,
  type DialogueTurn,
  type RetrievedMemoryChunk,
  type PresentPlayer,
} from "./hot_context.js";
export { buildWarmStateSnapshot, summarizeWarmStateForOperator } from "./warm_state.js";
export {
  type FoundryClient,
  type FoundryActor,
  type FoundryScene,
  type FoundrySceneToken,
  type FoundrySceneRef,
  type FoundryWorldInfo,
  type FoundryModuleRef,
  type FoundryUser,
  type FoundryPackRef,
  type FoundryCreatureRef,
  type FoundrySearchHit,
  type FoundryTokenDetails,
  type RollResult as FoundryRollResult,
} from "./foundry/client.js";
export * from "./intake/types.js";
export {
  isStarterSceneName,
  isKnownFoundrySystem,
  classifyModuleKind,
  readWorldInfo,
  readPartyActorSummaries,
  readSceneSummaries,
  readModuleSummaries,
  readPackSummaries,
  readOwnershipMap,
} from "./intake/foundry_reads.js";
export { runMinimumIntake, runExtendedIntake } from "./intake/runner.js";
export { runSessionStartIntake, kickExtendedIntake } from "./intake/session_start.js";
export { formatIntakeReportForOperator } from "./intake/report.js";
export {
  applyIntakeResolution,
  createIntakeResolutionState,
  announceReadyAllowed,
  unresolvedCriticalCodes,
  type IntakeResolutionState,
  type IntakeResolutionHooks,
} from "./intake/resolve.js";
export { DM_ONLY_MARKER } from "./intake/summary.js";
export {
  INTAKE_SETTING_KEY,
  emptyIntakeConfig,
  loadIntakeConfig,
  saveIntakeConfig,
  persistSurfacedFindings,
  persistFindingResolution,
} from "./intake/persist.js";
export { MockFoundryClient, type MockFoundryClientOptions } from "./foundry/mock.js";
export { renderActorState } from "./foundry/render.js";
export { resolveCharacterName, type NameResolution } from "./identity.js";
export * from "./interfaces/index.js";
export { toolDefinitionToLlmSpec } from "./tool_definition_to_spec.js";
export {
  Session,
  runTurn,
  startSession,
  endSession,
  archiveSession,
  type DispatchedToolCall,
  type SessionConfig,
  type TurnInput,
  type TurnOptions,
  type TurnOutput,
  type TurnStopReason,
} from "./session.js";
export {
  InMemoryMemoryStore,
  cosineSimilarity,
  effectiveAudience,
  matchesMetadataFilter,
  type MemoryStore,
  type MemoryRecord,
  type MemoryKind,
  type MemorySource,
  type MemoryMetadataFilter,
  type MemoryQueryOptions,
  type ByMetadataOptions,
} from "./memory/store.js";
export { allowedAudiencesFor, audienceVisibleInConversation } from "./audience.js";
export { Mutex } from "./util/mutex.js";
export {
  evaluatePrivateAction,
  pvpEnabledFromSetting,
  PVP_SETTING_KEY,
  type PrivateActionClassification,
  type GuardrailDecision,
} from "./side_channel/guardrail.js";
export { retrieveMemory, buildMemoryQuery, DEFAULT_RETRIEVAL_TOP_K } from "./memory/retrieval.js";
export {
  generateEpisodicSummary,
  EpisodicSummaryError,
  type EpisodicSummary,
} from "./memory/summarize.js";
export { ingestColdEntries, type ColdEntry } from "./memory/ingest.js";
export { extractKeys, type ExtractedKeys, type WorldEntrySource } from "./memory/world-metadata.js";
export {
  activateScene,
  applyInitialScene,
  chooseInitialScene,
  stripSceneFindings,
  type ApplyInitialSceneResult,
  type SceneChoice,
} from "./autosetup/initial-scene.js";
export { preloadExpectedContent, type PreloadReport } from "./autosetup/preload.js";
export {
  dispatchPostIntakeAutosetup,
  type DispatchAutosetupArgs,
  type DispatchAutosetupResult,
} from "./autosetup/dispatch.js";
export { foundryWorldContentReader } from "./autosetup/foundry-world-reader.js";
export {
  invokeIdentityPreflight,
  type VerifyIdentityPreflight,
} from "./autosetup/identity-preflight.js";
export { createSessionRunState, type SessionRunState } from "./session/run-state.js";
export {
  refreshIndex,
  resetIndexRefreshMutexForTests,
  type RefreshCounts,
  type RefreshIndexContext,
  type RefreshReport,
} from "./autosetup/index-refresh.js";
export type {
  CreatureCriteria,
  IndexSource,
  SearchQuery,
  WorldContentReader,
  WorldCreatureEntry,
  WorldItemEntry,
  WorldJournalEntry,
  WorldJournalPage,
  WorldSceneEntry,
} from "./autosetup/world-types.js";
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
export {
  DM_VOICE_PERSONAS,
  DEFAULT_DM_PERSONA_ID,
  getDmPersona,
  type DmPersona,
} from "./voice/personas.js";
export { parseNarrationSegments, normalizeNpcKey, type NarrationSegment } from "./voice/markers.js";
export { StreamingNarrationSegmenter } from "./voice/streaming_segmenter.js";
export { FakeVoiceLibrary, type VoiceLibrary, type VoiceLibraryEntry } from "./voice/library.js";
export {
  assignNpcVoice,
  resolveSegmentVoices,
  VoiceAssignmentError,
  type NpcVoiceAssignment,
  type ResolvedSpeechSegment,
} from "./voice/assignment.js";
export {
  DEFAULT_EAGERNESS,
  isEagerness,
  eagernessInstruction,
  type Eagerness,
} from "./voice/eagerness.js";
export {
  FillerSelector,
  MaskingPool,
  generateFillers,
  parseFillers,
  fillerStem,
  NEUTRAL_TAG,
  type Filler,
  type FillerSelectorOptions,
  type MaskingPoolOptions,
  type GenerateFillersInput,
} from "./voice/masking/index.js";
export {
  shouldPreplan,
  preplanIntent,
  type PreplanDecisionOptions,
  type PreplanInput,
} from "./voice/anticipation.js";
export {
  TranscriptionBuffer,
  utteranceToFragment,
  renderBuffer,
  type BufferFragment,
} from "./voice/buffer.js";
export { decideShouldRespond, type RespondDecision } from "./voice/decider.js";
export {
  selectOnboardingTargets,
  buildOnboardingDirective,
  type OnboardingSelectionInput,
} from "./voice/onboarding.js";
export {
  runAlwaysListeningSession,
  mergeFragmentsToTurnInput,
  type AlwaysListeningConfig,
  type AlwaysListeningResult,
} from "./always_listening_session.js";
