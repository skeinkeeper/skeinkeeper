// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import {
  FakeOutboundSurface,
  MockFoundryClient,
  SurfaceRouter,
  type SurfaceInputEvent,
} from "@skeinkeeper/orchestrator";
import { FoundryChatCommandSurface } from "./chat_command.js";
import { FoundryGmChatSurface } from "./gm_chat.js";
import { FoundryPublicChatSurface } from "./public_chat.js";
import { FoundryWhisperSurface } from "./whisper_chat.js";

function recordingAnalytics(): {
  analytics: { track: (n: "surface.command.parsed", p: { verb: string; ok: boolean }) => void };
  events: Array<{ name: string; props: { verb: string; ok: boolean } }>;
} {
  const events: Array<{ name: string; props: { verb: string; ok: boolean } }> = [];
  return {
    analytics: {
      track: (name, props) => events.push({ name, props }),
    },
    events,
  };
}

describe("FoundryPublicChatSurface outbound", () => {
  it("posts table text as public chat", async () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const surface = new FoundryPublicChatSurface({ client });
    await surface.emit({ audience: { kind: "table" }, text: "The door creaks." });
    expect(client.chatPosts).toEqual([{ content: "The door creaks.", mode: "public" }]);
  });
});

describe("FoundryWhisperSurface outbound", () => {
  it("whispers to the resolved Foundry user only", async () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const surface = new FoundryWhisperSurface({
      client,
      resolveFoundryUserId: (id) => (id === "discord-p1" ? "foundry-user-p1" : undefined),
    });
    await surface.emit({ audience: { kind: "player", playerId: "discord-p1" }, text: "psst" });
    expect(client.chatPosts).toEqual([
      { content: "psst", mode: "whisper", whisperTo: ["foundry-user-p1"] },
    ]);
  });

  it("router emit lands a single whisperTo for the mapped player (TDD 0035 Layer 2)", async () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const router = new SurfaceRouter();
    router.register(
      new FoundryWhisperSurface({
        client,
        resolveFoundryUserId: (id) => (id === "discord-p1" ? "foundry-user-p1" : undefined),
      }),
    );
    await router.emit({ audience: { kind: "player", playerId: "discord-p1" }, text: "psst" });
    expect(client.chatPosts).toEqual([
      { content: "psst", mode: "whisper", whisperTo: ["foundry-user-p1"] },
    ]);
  });

  it("router emit for an unmapped player rejects with no Foundry write", async () => {
    const events: Array<{ name: string; props: Record<string, unknown> }> = [];
    const client = new MockFoundryClient({ system: "dnd5e" });
    const router = new SurfaceRouter({
      analytics: {
        track: (name, props) => events.push({ name, props: props as Record<string, unknown> }),
        flush: async () => undefined,
      },
    });
    router.register(
      new FoundryWhisperSurface({
        client,
        resolveFoundryUserId: () => undefined,
      }),
    );
    const report = await router.emit({
      audience: { kind: "player", playerId: "discord-unknown" },
      text: "psst",
    });
    expect(client.chatPosts).toEqual([]);
    expect(report.perSurface).toEqual([
      { surface: "foundry-whisper", status: "failed", error: "unresolved-foundry-user" },
    ]);
    expect(events.some((e) => e.name === "surface.emit.failed")).toBe(true);
  });
});

describe("FoundryGmChatSurface outbound", () => {
  it("posts gm chat and whispers the operator on escalation when known", async () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const surface = new FoundryGmChatSurface({ client, operatorFoundryUserId: "u-op" });
    await surface.emit({
      audience: { kind: "gm" },
      text: "gap",
      meta: { escalation: true },
    });
    expect(client.chatPosts).toEqual([
      { content: "gap", mode: "gm" },
      { content: "gap", mode: "whisper", whisperTo: ["u-op"] },
    ]);
  });

  it("falls back to gm broadcast when the operator Foundry user is unknown", async () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const surface = new FoundryGmChatSurface({ client });
    await surface.emit({
      audience: { kind: "gm" },
      text: "gap",
      meta: { escalation: true },
    });
    expect(client.chatPosts).toEqual([{ content: "gap", mode: "gm" }]);
  });
});

describe("Foundry inbound adapters", () => {
  it("parses a happy-path operator command onto the inbound stream", async () => {
    const { analytics, events } = recordingAnalytics();
    const client = new MockFoundryClient({ system: "dnd5e" });
    const reply = new FakeOutboundSurface("foundry-gm", ["gm"]);
    const surface = new FoundryChatCommandSurface({ client, reply, analytics });
    const ev = await surface.handleChatEvent({
      foundryUserId: "gm1",
      text: "/skeinkeeper eagerness level:high",
      isWhisper: false,
      timestamp: "t0",
    });
    expect(ev).toEqual({
      kind: "chat.command",
      surface: "foundry-chat-command",
      foundryUserId: "gm1",
      verb: "eagerness",
      args: ["level:high"],
      raw: "/skeinkeeper eagerness level:high",
    });
    expect(events).toEqual([
      { name: "surface.command.parsed", props: { verb: "eagerness", ok: true } },
    ]);
    expect(reply.emits).toHaveLength(0);
  });

  it("whispers an inline error for a malformed command and emits no chat.command", async () => {
    const { analytics, events } = recordingAnalytics();
    const client = new MockFoundryClient({ system: "dnd5e" });
    const reply = new FakeOutboundSurface("foundry-gm", ["gm"]);
    const surface = new FoundryChatCommandSurface({ client, reply, analytics });
    const ev = await surface.handleChatEvent({
      foundryUserId: "gm1",
      text: "/skeinkeeper foo bar baz",
      isWhisper: false,
      timestamp: "t0",
    });
    expect(ev).toBeUndefined();
    expect(events).toEqual([{ name: "surface.command.parsed", props: { verb: "foo", ok: false } }]);
    expect(reply.emits).toHaveLength(1);
    expect(reply.emits[0]?.text).toMatch(/unknown verb/i);
    expect(reply.emits[0]?.meta?.replyTo).toBe("gm1");
  });

  it("passes non-/skeinkeeper chat through as chat.public", () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const surface = new FoundryPublicChatSurface({ client });
    const ev = surface.handleChatEvent({
      foundryUserId: "p1",
      text: "I look around the room.",
      isWhisper: false,
      timestamp: "t0",
    });
    expect(ev).toEqual({
      kind: "chat.public",
      surface: "foundry-public",
      foundryUserId: "p1",
      text: "I look around the room.",
    });
    expect(ev && "convention" in ev ? ev.convention : undefined).toBeUndefined();
  });

  it("parses IC/OOC convention markers on chat.public", () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const surface = new FoundryPublicChatSurface({ client, wakePhrase: "Hey DM" });
    const conventionOf = (text: string): "ic" | "ooc" | undefined => {
      const ev = surface.handleChatEvent({
        foundryUserId: "p1",
        text,
        isWhisper: false,
        timestamp: "t0",
      });
      return ev?.kind === "chat.public" ? ev.convention : undefined;
    };
    expect(conventionOf("!ooc let's break for snacks")).toBe("ooc");
    expect(conventionOf("((my player saw that))")).toBe("ooc");
    expect(conventionOf("I open the door")).toBeUndefined();
    expect(conventionOf("Hey DM I open the door")).toBe("ic");
  });

  it("does not emit chat.command for public chat", async () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const reply = new FakeOutboundSurface("foundry-gm", ["gm"]);
    const commands = new FoundryChatCommandSurface({ client, reply });
    const ev = await commands.handleChatEvent({
      foundryUserId: "p1",
      text: "I look around the room.",
      isWhisper: false,
      timestamp: "t0",
    });
    expect(ev).toBeUndefined();
  });

  it("filters whisper-to-AI events on the whisper surface", () => {
    const client = new MockFoundryClient({ system: "dnd5e" });
    const surface = new FoundryWhisperSurface({ client, dmFoundryUserId: "foundry-user-dm" });
    const hit = surface.handleChatEvent({
      foundryUserId: "foundry-user-p1",
      text: "psst",
      isWhisper: true,
      recipients: ["foundry-user-dm"],
      timestamp: "t0",
    });
    expect(hit).toEqual({
      kind: "chat.whisper.player-to-dm",
      surface: "foundry-whisper",
      foundryUserId: "foundry-user-p1",
      text: "psst",
    } satisfies SurfaceInputEvent);
    expect(
      surface.handleChatEvent({
        foundryUserId: "foundry-user-p1",
        text: "not for the DM",
        isWhisper: true,
        recipients: ["someone-else"],
        timestamp: "t1",
      }),
    ).toBeUndefined();
  });
});
