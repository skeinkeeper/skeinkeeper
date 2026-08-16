// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  WorldCreatureEntry,
  WorldItemEntry,
  WorldJournalEntry,
  WorldSceneEntry,
} from "../autosetup/world-types.js";

export interface ExtractedKeys {
  location?: string;
  quest?: string;
  keywords: string[];
}

export type WorldEntrySource =
  | {
      kind: "journal";
      entry: WorldJournalEntry;
      sceneFolders: ReadonlySet<string>;
      quests?: ReadonlyArray<string>;
    }
  | {
      kind: "scene";
      entry: WorldSceneEntry;
      journalByFolder?: ReadonlyMap<string, ExtractedKeys>;
    }
  | {
      kind: "creature";
      entry: WorldCreatureEntry;
      journalCrossRef?: ExtractedKeys;
    }
  | {
      kind: "item";
      entry: WorldItemEntry;
      ownerKeys?: ExtractedKeys;
    };

const LEADING_ARTICLES = new Set(["the", "a", "an"]);
const INFIX_STOP = new Set(["of", "the", "a", "an", "and", "or", "in", "on", "for", "to", "from"]);

export function extractKeys(source: WorldEntrySource): ExtractedKeys {
  switch (source.kind) {
    case "journal":
      return extractJournal(source.entry, source.sceneFolders, source.quests ?? []);
    case "scene":
      return extractScene(source.entry, source.journalByFolder);
    case "creature":
      return extractCreature(source.entry, source.journalCrossRef);
    case "item":
      return extractItem(source.entry, source.ownerKeys);
  }
}

function extractJournal(
  entry: WorldJournalEntry,
  sceneFolders: ReadonlySet<string>,
  quests: ReadonlyArray<string>,
): ExtractedKeys {
  const location = journalLocation(entry, sceneFolders);
  const quest = journalQuest(entry, quests);
  const keywords = unique([...titleTokens(entry.name), ...properNouns(entry.text.slice(0, 500))]);
  return compact(location, quest, keywords);
}

function extractScene(
  entry: WorldSceneEntry,
  journalByFolder: ReadonlyMap<string, ExtractedKeys> | undefined,
): ExtractedKeys {
  const inherited = entry.folder !== undefined ? journalByFolder?.get(entry.folder) : undefined;
  const keywords = unique([
    ...titleTokens(entry.name),
    ...(entry.folder !== undefined ? [entry.folder] : []),
    ...(entry.tags ?? []),
  ]);
  return compact(entry.name, inherited?.quest, keywords);
}

function extractCreature(
  entry: WorldCreatureEntry,
  xref: ExtractedKeys | undefined,
): ExtractedKeys {
  const keywords = unique([
    ...titleTokens(entry.name),
    ...(entry.type !== undefined ? [entry.type] : []),
    ...(entry.tags ?? []),
  ]);
  return compact(xref?.location ?? entry.folder, xref?.quest, keywords);
}

function extractItem(entry: WorldItemEntry, owner: ExtractedKeys | undefined): ExtractedKeys {
  const keywords = unique([
    ...titleTokens(entry.name),
    ...(entry.type !== undefined ? [entry.type] : []),
  ]);
  return compact(owner?.location, owner?.quest, keywords);
}

function journalLocation(
  entry: WorldJournalEntry,
  sceneFolders: ReadonlySet<string>,
): string | undefined {
  if (entry.folder !== undefined && sceneFolders.has(entry.folder)) return entry.folder;
  return firstProperNounPhrase(entry.name);
}

function journalQuest(entry: WorldJournalEntry, quests: ReadonlyArray<string>): string | undefined {
  const flagged = entry.pages?.some((p) => isQuestFlag(p.flags));
  if (flagged) {
    const match = quests.find((q) => entry.name.toLowerCase().includes(q.toLowerCase()));
    return match ?? entry.name;
  }
  return quests.find((q) => entry.name.toLowerCase().includes(q.toLowerCase()));
}

function isQuestFlag(flags: Readonly<Record<string, unknown>> | undefined): boolean {
  if (flags === undefined) return false;
  if (flags["quest"] === true) return true;
  const nested = flags["skeinkeeper"];
  return (
    nested !== null &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    (nested as Record<string, unknown>)["quest"] === true
  );
}

function titleTokens(name: string): string[] {
  return name
    .split(/[\s—–\-/,]+/)
    .map((t) => t.replace(/[^A-Za-z0-9']/g, ""))
    .filter(
      (t) =>
        t.length > 0 && !LEADING_ARTICLES.has(t.toLowerCase()) && !INFIX_STOP.has(t.toLowerCase()),
    );
}

function firstProperNounPhrase(title: string): string | undefined {
  const words = title.split(/\s+/).filter((w) => w.length > 0);
  let i = 0;
  while (i < words.length && LEADING_ARTICLES.has(stripPunct(words[i]!).toLowerCase())) i += 1;
  const parts: string[] = [];
  for (; i < words.length; i++) {
    const raw = words[i]!;
    const cleaned = stripPunct(raw);
    if (cleaned.length === 0) break;
    if (isCapitalized(cleaned) || (parts.length > 0 && INFIX_STOP.has(cleaned.toLowerCase()))) {
      parts.push(cleaned);
      continue;
    }
    break;
  }
  const phrase = parts.filter((p) => !LEADING_ARTICLES.has(p.toLowerCase())).join(" ");
  return phrase.length > 0 ? phrase : undefined;
}

function properNouns(text: string): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    const cleaned = stripPunct(w);
    if (cleaned.length === 0) continue;
    if (isCapitalized(cleaned) && !LEADING_ARTICLES.has(cleaned.toLowerCase())) out.push(cleaned);
  }
  return out;
}

function isCapitalized(word: string): boolean {
  return /^[A-Z][A-Za-z0-9']*$/.test(word);
}

function stripPunct(word: string): string {
  return word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, "");
}

function unique(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v.length === 0) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function compact(
  location: string | undefined,
  quest: string | undefined,
  keywords: string[],
): ExtractedKeys {
  const keys: ExtractedKeys = { keywords };
  if (location !== undefined && location.length > 0) keys.location = location;
  if (quest !== undefined && quest.length > 0) keys.quest = quest;
  return keys;
}
