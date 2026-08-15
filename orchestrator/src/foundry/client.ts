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

/** Lightweight scene reference for scene awareness + switching (ADR-0015). */
export interface FoundrySceneRef {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
}

/** World metadata used by session intake (TDD 0031). */
export interface FoundryModuleRef {
  readonly id: string;
  readonly title: string;
  readonly kind?: "campaign" | "system" | "utility";
  readonly active?: boolean;
}

export interface FoundryWorldInfo {
  readonly connected: boolean;
  readonly system: { id: string; name: string } | null;
  readonly modules: ReadonlyArray<FoundryModuleRef>;
}

export interface FoundryUser {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly isActive?: boolean;
  readonly ownedActorIds?: ReadonlyArray<string>;
}

export interface FoundryPackRef {
  readonly id: string;
  readonly label: string;
  readonly type?: string;
}

export interface FoundryCreatureRef {
  readonly id: string;
  readonly name: string;
  readonly packId: string;
  readonly type?: string;
}

export interface FoundrySearchHit {
  readonly id: string;
  readonly name: string;
  readonly packId?: string;
  readonly type?: string;
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
  /** All scenes in the world, so the AI knows what it can switch to. */
  listScenes(): Promise<ReadonlyArray<FoundrySceneRef>>;
  /** Active system + installed modules (TDD 0031 intake). */
  getWorldInfo(): Promise<FoundryWorldInfo>;
  /**
   * Foundry users + owned actors. The first-party add-on (TDD 0041) is
   * the real source; today's MCP bridge has no list-users tool, so the
   * MCP client returns an empty list and intake degrades to a
   * recommendation (ADR-0024).
   */
  listUsers(): Promise<ReadonlyArray<FoundryUser>>;
  listCompendiumPacks(): Promise<ReadonlyArray<FoundryPackRef>>;
  listCreaturesByCriteria(criteria: {
    name?: string;
    type?: string;
  }): Promise<ReadonlyArray<FoundryCreatureRef>>;
  searchCompendium(
    query: string,
    opts?: { packType?: string },
  ): Promise<ReadonlyArray<FoundrySearchHit>>;
  searchJournals(query: string): Promise<ReadonlyArray<FoundrySearchHit>>;

  // ---- writes (tool handlers route through these) ----
  applyActorUpdate(actorId: string, update: Record<string, unknown>): Promise<void>;
  rollDice(
    formula: string,
    opts?: { speaker?: string; whisperTo?: ReadonlyArray<string> },
  ): Promise<RollResult>;
  /** Activate a scene by id or name — an in-play DM action (ADR-0015). */
  setActiveScene(sceneIdOrName: string): Promise<void>;
}
