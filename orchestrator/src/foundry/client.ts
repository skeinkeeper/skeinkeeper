// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * The orchestrator's interface to a VTT. Per design doc 0007, Foundry
 * is authoritative for mechanical state (characters, NPCs, locations,
 * sheets, conditions, inventory, combat). Application code reads and
 * writes that state exclusively through this interface; the concrete
 * implementation in `plugins/vtt-foundry/` wraps an MCP bridge.
 *
 * Tests use `MockFoundryClient` from ./mock.js — an in-memory
 * implementation that lets the orchestrator be exercised without a
 * live Foundry process.
 */

export interface FoundryActor {
  readonly id: string;
  readonly name: string;
  readonly type: "character" | "npc" | string;
  /** The active Foundry system identifier (e.g., "dnd5e", "fate-core"). */
  readonly system: string;
  /** Foundry's `actor.system` blob — opaque to the orchestrator. Format
   *  is determined by whichever Foundry system module is active. */
  readonly sheet: Readonly<Record<string, unknown>>;
  readonly flags?: Readonly<Record<string, unknown>>;
}

export interface FoundrySceneToken {
  readonly actorId: string;
  readonly name: string;
  /** Foundry token disposition: -1 hostile, 0 neutral, 1 friendly. */
  readonly disposition?: number;
}

export interface FoundryScene {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly active: boolean;
  readonly tokens: ReadonlyArray<FoundrySceneToken>;
}

export interface RollResult {
  readonly total: number;
  readonly rolls: ReadonlyArray<number>;
  readonly formula: string;
}

export interface FoundryClient {
  /** Identifier of the active Foundry system for the connected world,
   *  e.g., "dnd5e", "fate-core", "dungeon-world". */
  readonly system: string;

  // ---- reads ----
  listPartyActors(): Promise<ReadonlyArray<FoundryActor>>;
  listSceneActors(sceneId: string): Promise<ReadonlyArray<FoundryActor>>;
  getActor(actorId: string): Promise<FoundryActor | null>;
  getActiveScene(): Promise<FoundryScene | null>;

  // ---- writes (Phase 3 tool handlers route through these) ----
  applyActorUpdate(actorId: string, update: Record<string, unknown>): Promise<void>;
  rollDice(formula: string, opts?: { speaker?: string; whisperTo?: ReadonlyArray<string> }): Promise<RollResult>;
}
