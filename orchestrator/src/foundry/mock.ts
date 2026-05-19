// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  FoundryActor,
  FoundryClient,
  FoundryScene,
  RollResult,
} from "./client.js";

export interface MockFoundryClientOptions {
  system: string;
  actors?: ReadonlyArray<FoundryActor>;
  scenes?: ReadonlyArray<FoundryScene>;
  partyActorIds?: ReadonlyArray<string>;
  activeSceneId?: string;
}

/**
 * In-memory FoundryClient for unit tests. Holds actors and scenes in
 * plain maps; mutations via applyActorUpdate are recorded; dice rolls
 * are deterministic (always returns 10 unless seeded otherwise).
 */
export class MockFoundryClient implements FoundryClient {
  readonly system: string;
  private readonly actorsById = new Map<string, FoundryActor>();
  private readonly scenesById = new Map<string, FoundryScene>();
  private partyActorIds: ReadonlyArray<string>;
  private activeSceneId: string | undefined;
  readonly updates: Array<{ actorId: string; update: Record<string, unknown> }> = [];
  readonly rolls: Array<{ formula: string; speaker?: string; whisperTo?: ReadonlyArray<string> }> = [];
  /** Override the deterministic roll result; set by tests. */
  rollResultFor: (formula: string) => RollResult = (formula) => ({
    total: 10,
    rolls: [10],
    formula,
  });

  constructor(opts: MockFoundryClientOptions) {
    this.system = opts.system;
    for (const a of opts.actors ?? []) this.actorsById.set(a.id, a);
    for (const s of opts.scenes ?? []) this.scenesById.set(s.id, s);
    this.partyActorIds = opts.partyActorIds ?? [];
    if (opts.activeSceneId !== undefined) this.activeSceneId = opts.activeSceneId;
  }

  setActor(actor: FoundryActor): void {
    this.actorsById.set(actor.id, actor);
  }

  setScene(scene: FoundryScene): void {
    this.scenesById.set(scene.id, scene);
  }

  setPartyActorIds(ids: ReadonlyArray<string>): void {
    this.partyActorIds = ids;
  }

  setActiveScene(sceneId: string | undefined): void {
    this.activeSceneId = sceneId;
  }

  async listPartyActors(): Promise<ReadonlyArray<FoundryActor>> {
    return this.partyActorIds
      .map((id) => this.actorsById.get(id))
      .filter((a): a is FoundryActor => a !== undefined);
  }

  async listSceneActors(sceneId: string): Promise<ReadonlyArray<FoundryActor>> {
    const scene = this.scenesById.get(sceneId);
    if (!scene) return [];
    return scene.tokens
      .map((t) => this.actorsById.get(t.actorId))
      .filter((a): a is FoundryActor => a !== undefined);
  }

  async getActor(actorId: string): Promise<FoundryActor | null> {
    return this.actorsById.get(actorId) ?? null;
  }

  async getActiveScene(): Promise<FoundryScene | null> {
    if (this.activeSceneId === undefined) return null;
    return this.scenesById.get(this.activeSceneId) ?? null;
  }

  async applyActorUpdate(actorId: string, update: Record<string, unknown>): Promise<void> {
    this.updates.push({ actorId, update });
    const existing = this.actorsById.get(actorId);
    if (existing) {
      // Shallow-merge update.system into existing.sheet for test convenience.
      const updateSystem = (update.system as Record<string, unknown> | undefined) ?? {};
      this.actorsById.set(actorId, {
        ...existing,
        sheet: { ...existing.sheet, ...updateSystem },
      });
    }
  }

  async rollDice(
    formula: string,
    opts?: { speaker?: string; whisperTo?: ReadonlyArray<string> },
  ): Promise<RollResult> {
    this.rolls.push({
      formula,
      ...(opts?.speaker !== undefined ? { speaker: opts.speaker } : {}),
      ...(opts?.whisperTo !== undefined ? { whisperTo: opts.whisperTo } : {}),
    });
    return this.rollResultFor(formula);
  }
}
