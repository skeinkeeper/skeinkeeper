// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/** World-content shapes shared by vtt-foundry readers and extractKeys (TDD 0032). */

export interface WorldJournalPage {
  name: string;
  text?: string;
  flags?: Readonly<Record<string, unknown>>;
}

export interface WorldJournalEntry {
  id: string;
  name: string;
  text: string;
  pages?: WorldJournalPage[];
  folder?: string;
  modifiedAt?: string;
}

export interface WorldSceneEntry {
  id: string;
  name: string;
  folder?: string;
  active: boolean;
  tags?: string[];
  flags?: Readonly<Record<string, unknown>>;
  modifiedAt?: string;
}

export interface WorldCreatureEntry {
  id: string;
  name: string;
  type?: string;
  folder?: string;
  tags?: string[];
  text: string;
  modifiedAt?: string;
}

export interface WorldItemEntry {
  id: string;
  name: string;
  type?: string;
  actorId: string;
  text: string;
  modifiedAt?: string;
}

export interface SearchQuery {
  query?: string;
}

export interface CreatureCriteria {
  name?: string;
  type?: string;
}

export type IndexSource = "world-journal" | "world-scene" | "world-creature" | "world-actor-item";

export interface WorldContentReader {
  readJournals(q?: SearchQuery): Promise<WorldJournalEntry[]>;
  readScenes(): Promise<WorldSceneEntry[]>;
  readCreatures(q?: CreatureCriteria): Promise<WorldCreatureEntry[]>;
  readActorItems(actorIds: ReadonlyArray<string>): Promise<WorldItemEntry[]>;
}
