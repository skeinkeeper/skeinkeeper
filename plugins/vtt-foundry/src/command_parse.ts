// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { ConsoleControl } from "@skeinkeeper/orchestrator";

const PREFIX = /^\/skeinkeeper(?:\s+(.*))?$/i;

const KNOWN_VERBS = new Set([
  "session",
  "eagerness",
  "voice",
  "operator",
  "intake",
  "consent",
  "map",
  "pvp",
  "preflight",
]);

export function isSkeinkeeperCommand(text: string): boolean {
  return PREFIX.test(text.trim());
}

export type CommandParseResult =
  | {
      ok: true;
      verb: string;
      args: ReadonlyArray<string>;
      raw: string;
      control: ConsoleControl;
    }
  | { ok: false; verb: string; args: ReadonlyArray<string>; raw: string; error: string };

/** Parse `/skeinkeeper <verb> <args>` (TDD 0034 §6). Unknown verb is a failure. */
export function parseSkeinkeeperCommand(raw: string): CommandParseResult {
  const trimmed = raw.trim();
  const m = PREFIX.exec(trimmed);
  const rest = (m?.[1] ?? "").trim();
  const tokens = rest.length > 0 ? rest.split(/\s+/) : [];
  const verb = tokens[0] ?? "";
  const args = tokens.slice(1);

  if (verb.length === 0) {
    return {
      ok: false,
      verb: "",
      args,
      raw: trimmed,
      error: "Usage: /skeinkeeper <verb> <args>",
    };
  }
  if (!KNOWN_VERBS.has(verb)) {
    return {
      ok: false,
      verb,
      args,
      raw: trimmed,
      error: `Unknown verb '${verb}'. Try session, eagerness, voice, operator, intake, consent, map, pvp, preflight.`,
    };
  }

  const control = mapVerbToControl(verb, args);
  if (control === undefined) {
    return {
      ok: false,
      verb,
      args,
      raw: trimmed,
      error: `Invalid arguments for '${verb}'.`,
    };
  }
  return { ok: true, verb, args, raw: trimmed, control };
}

function mapVerbToControl(verb: string, args: ReadonlyArray<string>): ConsoleControl | undefined {
  switch (verb) {
    case "session": {
      const action = named(args, "action") ?? args[0];
      if (action === "start" || action === "stop" || action === "pause" || action === "resume") {
        return { control: "session", action };
      }
      return undefined;
    }
    case "eagerness": {
      const level = named(args, "level") ?? args[0];
      if (level === undefined) return undefined;
      if (
        level === "low" ||
        level === "medium" ||
        level === "high" ||
        level === "reserved" ||
        level === "balanced" ||
        level === "eager"
      ) {
        return { control: "eagerness", level };
      }
      return undefined;
    }
    case "voice": {
      const action = named(args, "action") ?? args[0];
      if (action === "list") return { control: "voice", action: "list" };
      if (action === "set") {
        const persona = named(args, "persona") ?? args[1];
        if (persona === undefined) return undefined;
        return { control: "voice", action: "set", persona };
      }
      return undefined;
    }
    case "operator": {
      const action = named(args, "action") ?? args[0];
      if (action === "claim" || action === "clear" || action === "show") {
        return { control: "operator", action };
      }
      return undefined;
    }
    case "intake": {
      if (args[0] !== "resolve" || args[1] === undefined || args[2] === undefined) return undefined;
      return { control: "intake", id: args[1], option: args[2] };
    }
    case "consent": {
      const decision = args[0];
      if (decision === "accept" || decision === "decline") {
        return { control: "consent", decision };
      }
      return undefined;
    }
    case "map": {
      const who = args[0];
      const character = args.slice(1).join(" ").trim();
      if (who === undefined || character.length === 0) return undefined;
      return { control: "map", discordUser: who.replace(/^@/, ""), character };
    }
    case "pvp": {
      const v = args[0];
      if (v === "on") return { control: "pvp", enabled: true };
      if (v === "off") return { control: "pvp", enabled: false };
      return undefined;
    }
    case "preflight": {
      if (args[0] !== "verify") return undefined;
      const who = args[1];
      if (who === undefined) return { control: "preflight" };
      return { control: "preflight", player: who.replace(/^@/, "") };
    }
    default:
      return undefined;
  }
}

function named(args: ReadonlyArray<string>, key: string): string | undefined {
  const prefix = `${key}:`;
  for (const a of args) {
    if (a.toLowerCase().startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}
