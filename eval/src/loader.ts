// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Fixture, Expectation, Scenario } from "./fixture.js";

export function loadFixtures(dir: string): Fixture[] {
  const files = walkEvalYaml(dir);
  return files.map((path) => loadFixture(path));
}

export function loadFixture(path: string): Fixture {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${path}: not a YAML object`);
  }
  const obj = parsed as Record<string, unknown>;

  const name = requireString(obj, "name", path);
  const scenario = parseScenario(obj.scenario, path);
  const expectations = parseExpectations(obj.expectations, path);

  const fixture: Fixture = { path, name, scenario, expectations };
  if (typeof obj.description === "string") fixture.description = obj.description;
  if (typeof obj.behavior_spec_version === "string") {
    fixture.behaviorSpecVersion = obj.behavior_spec_version;
  }
  if (typeof obj.skip === "string" && obj.skip.trim().length > 0) fixture.skip = obj.skip;
  return fixture;
}

function walkEvalYaml(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkEvalYaml(full));
    } else if (full.endsWith(".eval.yaml") || full.endsWith(".eval.yml")) {
      out.push(full);
    }
  }
  return out.sort();
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${path}: missing or invalid "${key}" (expected non-empty string)`);
  }
  return v;
}

function parseScenario(raw: unknown, path: string): Scenario {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${path}: missing "scenario" object`);
  }
  const obj = raw as Record<string, unknown>;
  const turnsRaw = obj.turns;
  if (!Array.isArray(turnsRaw) || turnsRaw.length === 0) {
    throw new Error(`${path}: "scenario.turns" must be a non-empty array`);
  }
  const turns: Array<{ speaker: "player" | "operator" | "system"; text: string }> = turnsRaw.map(
    (t, i) => {
      if (!t || typeof t !== "object") {
        throw new Error(`${path}: scenario.turns[${i}] is not an object`);
      }
      const turn = t as Record<string, unknown>;
      const speaker = turn.speaker;
      if (speaker !== "player" && speaker !== "operator" && speaker !== "system") {
        throw new Error(`${path}: scenario.turns[${i}].speaker must be player|operator|system`);
      }
      if (typeof turn.text !== "string") {
        throw new Error(`${path}: scenario.turns[${i}].text must be a string`);
      }
      return { speaker, text: turn.text };
    },
  );
  const scenario: Scenario = { turns };
  if (obj.state && typeof obj.state === "object") {
    scenario.state = obj.state as Record<string, unknown>;
  }
  return scenario;
}

function parseExpectations(raw: unknown, path: string): Expectation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${path}: "expectations" must be a non-empty array`);
  }
  return raw.map((e, i) => parseExpectation(e, `${path}: expectations[${i}]`));
}

function parseExpectation(raw: unknown, ctx: string): Expectation {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${ctx}: not an object`);
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  const field = typeof obj.field === "string" && obj.field.length > 0 ? obj.field : "narration";
  const description = typeof obj.description === "string" ? obj.description : undefined;
  switch (kind) {
    case "not_empty":
      return { kind, field, ...(description !== undefined ? { description } : {}) };
    case "contains":
    case "not_contains": {
      if (typeof obj.text !== "string") throw new Error(`${ctx}: "${kind}" requires string "text"`);
      return { kind, field, text: obj.text, ...(description !== undefined ? { description } : {}) };
    }
    case "contains_any_of": {
      if (!Array.isArray(obj.texts) || obj.texts.some((t) => typeof t !== "string")) {
        throw new Error(`${ctx}: "contains_any_of" requires string[] "texts"`);
      }
      return {
        kind,
        field,
        texts: obj.texts as string[],
        ...(description !== undefined ? { description } : {}),
      };
    }
    case "regex_match": {
      if (typeof obj.pattern !== "string") {
        throw new Error(`${ctx}: "regex_match" requires string "pattern"`);
      }
      return {
        kind,
        field,
        pattern: obj.pattern,
        ...(description !== undefined ? { description } : {}),
      };
    }
    default:
      throw new Error(`${ctx}: unknown expectation kind "${String(kind)}"`);
  }
}
