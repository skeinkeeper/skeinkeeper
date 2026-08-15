// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { EmbeddingProvider } from "../interfaces/embedding.js";
import { ingestColdEntries } from "../memory/ingest.js";
import { extractKeys, type ExtractedKeys } from "../memory/world-metadata.js";
import type { MemoryRecord, MemoryStore } from "../memory/store.js";
import type {
  IndexSource,
  WorldContentReader,
  WorldCreatureEntry,
  WorldItemEntry,
  WorldJournalEntry,
  WorldSceneEntry,
} from "./world-types.js";

export interface RefreshCounts {
  added: number;
  updated: number;
  deleted: number;
}

export interface RefreshReport {
  perSource: Record<IndexSource, RefreshCounts>;
  errors: Array<{ source: IndexSource; error: string }>;
  durationMs: number;
}

export interface RefreshIndexContext {
  campaignId: string;
  lastRunAt?: number;
  partyActorIds?: ReadonlyArray<string>;
  sessionId?: string;
  onTelemetry?: (name: string, props?: Record<string, unknown>) => void;
}

const SOURCES: IndexSource[] = [
  "world-journal",
  "world-scene",
  "world-creature",
  "world-actor-item",
];

const inflight = new Map<string, Promise<RefreshReport>>();

export function resetIndexRefreshMutexForTests(): void {
  inflight.clear();
}

export function refreshIndex(
  source: WorldContentReader,
  store: MemoryStore,
  embed: EmbeddingProvider,
  ctx: RefreshIndexContext,
): Promise<RefreshReport> {
  const existing = inflight.get(ctx.campaignId);
  if (existing !== undefined) return existing;
  const run = runRefresh(source, store, embed, ctx).finally(() => {
    if (inflight.get(ctx.campaignId) === run) inflight.delete(ctx.campaignId);
  });
  inflight.set(ctx.campaignId, run);
  return run;
}

async function runRefresh(
  source: WorldContentReader,
  store: MemoryStore,
  embed: EmbeddingProvider,
  ctx: RefreshIndexContext,
): Promise<RefreshReport> {
  const started = Date.now();
  ctx.onTelemetry?.("index.run.started", {
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId ?? "",
  });

  const empty = (): RefreshCounts => ({ added: 0, updated: 0, deleted: 0 });
  const report: RefreshReport = {
    perSource: {
      "world-journal": empty(),
      "world-scene": empty(),
      "world-creature": empty(),
      "world-actor-item": empty(),
    },
    errors: [],
    durationMs: 0,
  };

  const loaded = await loadSources(source, ctx, report);
  const sceneFolders = new Set(
    loaded.scenes.map((s) => s.folder).filter((f): f is string => f !== undefined),
  );
  const journalKeys = new Map<string, ExtractedKeys>();
  const journalByFolder = new Map<string, ExtractedKeys>();
  for (const j of loaded.journals) {
    const keys = extractKeys({ kind: "journal", entry: j, sceneFolders });
    journalKeys.set(j.id, keys);
    if (j.folder !== undefined && !journalByFolder.has(j.folder))
      journalByFolder.set(j.folder, keys);
  }

  await syncOne(
    store,
    embed,
    ctx,
    "world-journal",
    loaded.journals.map((j) =>
      currentEntry(
        j.id,
        j.modifiedAt,
        embedText(j.name, j.text),
        journalKeys.get(j.id) ?? { keywords: [] },
      ),
    ),
    report,
  );
  await syncOne(
    store,
    embed,
    ctx,
    "world-scene",
    loaded.scenes.map((s) =>
      currentEntry(
        s.id,
        s.modifiedAt,
        embedText(s.name, s.folder),
        extractKeys({ kind: "scene", entry: s, journalByFolder }),
      ),
    ),
    report,
  );
  await syncOne(
    store,
    embed,
    ctx,
    "world-creature",
    loaded.creatures.map((c) => {
      const xref = creatureXref(c, loaded.journals, journalKeys, journalByFolder);
      return currentEntry(
        c.id,
        c.modifiedAt,
        embedText(c.name, c.text),
        extractKeys({
          kind: "creature",
          entry: c,
          ...(xref !== undefined ? { journalCrossRef: xref } : {}),
        }),
      );
    }),
    report,
  );
  await syncOne(
    store,
    embed,
    ctx,
    "world-actor-item",
    loaded.items.map((i) =>
      currentEntry(
        i.id,
        i.modifiedAt,
        embedText(i.name, i.text),
        extractKeys({ kind: "item", entry: i }),
      ),
    ),
    report,
  );

  report.durationMs = Date.now() - started;
  const perSourceCounts: Record<string, RefreshCounts> = {};
  for (const s of SOURCES) perSourceCounts[s] = report.perSource[s];
  ctx.onTelemetry?.("index.run.completed", {
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId ?? "",
    durationMs: report.durationMs,
    perSourceCounts,
  });
  return report;
}

interface Loaded {
  journals: WorldJournalEntry[];
  scenes: WorldSceneEntry[];
  creatures: WorldCreatureEntry[];
  items: WorldItemEntry[];
}

async function loadSources(
  source: WorldContentReader,
  ctx: RefreshIndexContext,
  report: RefreshReport,
): Promise<Loaded> {
  const loaded: Loaded = { journals: [], scenes: [], creatures: [], items: [] };
  loaded.journals = await readOne(source.readJournals(), "world-journal", ctx, report);
  loaded.scenes = await readOne(source.readScenes(), "world-scene", ctx, report);
  loaded.creatures = await readOne(source.readCreatures(), "world-creature", ctx, report);
  loaded.items = await readOne(
    source.readActorItems(ctx.partyActorIds ?? []),
    "world-actor-item",
    ctx,
    report,
  );
  return loaded;
}

async function readOne<T>(
  task: Promise<T[]>,
  source: IndexSource,
  ctx: RefreshIndexContext,
  report: RefreshReport,
): Promise<T[]> {
  try {
    return await task;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    report.errors.push({ source, error });
    ctx.onTelemetry?.("index.run.source_failed", {
      campaignId: ctx.campaignId,
      source,
      reason: error,
    });
    return [];
  }
}

interface CurrentEntry {
  foundryId: string;
  lastModified?: string;
  text: string;
  keys: ExtractedKeys;
}

function currentEntry(
  foundryId: string,
  lastModified: string | undefined,
  text: string,
  keys: ExtractedKeys,
): CurrentEntry {
  return {
    foundryId,
    text,
    keys,
    ...(lastModified !== undefined ? { lastModified } : {}),
  };
}

async function syncOne(
  store: MemoryStore,
  embed: EmbeddingProvider,
  ctx: RefreshIndexContext,
  source: IndexSource,
  current: ReadonlyArray<CurrentEntry>,
  report: RefreshReport,
): Promise<void> {
  try {
    await syncSource(store, embed, ctx, source, current, report);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    report.errors.push({ source, error });
    ctx.onTelemetry?.("index.run.source_failed", {
      campaignId: ctx.campaignId,
      source,
      reason: error,
    });
  }
}

async function syncSource(
  store: MemoryStore,
  embed: EmbeddingProvider,
  ctx: RefreshIndexContext,
  source: IndexSource,
  current: ReadonlyArray<CurrentEntry>,
  report: RefreshReport,
): Promise<void> {
  const existing = await store.byMetadata({
    campaignId: ctx.campaignId,
    source,
    includeTombstones: true,
  });
  const byFoundry = new Map<string, MemoryRecord>();
  for (const r of existing) {
    if (r.metadata.foundry_id !== undefined) byFoundry.set(r.metadata.foundry_id, r);
  }

  const seen = new Set<string>();
  const toIngest: CurrentEntry[] = [];
  for (const entry of current) {
    seen.add(entry.foundryId);
    const prior = byFoundry.get(entry.foundryId);
    if (prior === undefined || prior.metadata.tombstoned === true) {
      toIngest.push(entry);
      report.perSource[source].added += 1;
      continue;
    }
    if (shouldUpdate(entry.lastModified, prior.metadata.last_modified)) {
      toIngest.push(entry);
      report.perSource[source].updated += 1;
    }
  }

  if (toIngest.length > 0) {
    await ingestColdEntries(embed, store, {
      campaignId: ctx.campaignId,
      entries: toIngest.map((e) => ({
        id: `${ctx.campaignId}:${source}:${e.foundryId}`,
        text: e.text,
        source,
        foundry_id: e.foundryId,
        ...(e.lastModified !== undefined ? { last_modified: e.lastModified } : {}),
        ...(e.keys.location !== undefined ? { location: e.keys.location } : {}),
        ...(e.keys.quest !== undefined ? { quest: e.keys.quest } : {}),
        keywords: e.keys.keywords,
      })),
    });
  }

  const tombstones: MemoryRecord[] = [];
  for (const [foundryId, rec] of byFoundry) {
    if (seen.has(foundryId) || rec.metadata.tombstoned === true) continue;
    tombstones.push({
      ...rec,
      metadata: { ...rec.metadata, tombstoned: true },
    });
    report.perSource[source].deleted += 1;
  }
  if (tombstones.length > 0) await store.upsert(tombstones);
}

function shouldUpdate(current: string | undefined, stored: string | undefined): boolean {
  if (current === undefined) return false;
  if (stored === undefined) return true;
  return current > stored;
}

function embedText(...parts: Array<string | undefined>): string {
  return parts
    .filter((p): p is string => p !== undefined && p.trim().length > 0)
    .join("\n")
    .trim();
}

function creatureXref(
  creature: WorldCreatureEntry,
  journals: ReadonlyArray<WorldJournalEntry>,
  journalKeys: ReadonlyMap<string, ExtractedKeys>,
  journalByFolder: ReadonlyMap<string, ExtractedKeys>,
): ExtractedKeys | undefined {
  if (creature.folder !== undefined) {
    const byFolder = journalByFolder.get(creature.folder);
    if (byFolder !== undefined) return byFolder;
  }
  const needle = creature.name.toLowerCase();
  for (const j of journals) {
    if (j.name.toLowerCase().includes(needle) || j.text.toLowerCase().includes(needle)) {
      return journalKeys.get(j.id);
    }
  }
  return undefined;
}
