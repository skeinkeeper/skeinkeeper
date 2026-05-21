// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { parseNarrationSegments, type NarrationSegment } from "./markers.js";
import { StreamingNarrationSegmenter } from "./streaming_segmenter.js";

/** Feed a narration as a sequence of chunks; return all emitted segments. */
function run(chunks: ReadonlyArray<string>): NarrationSegment[] {
  const s = new StreamingNarrationSegmenter();
  const out: NarrationSegment[] = [];
  for (const c of chunks) out.push(...s.push(c));
  out.push(...s.flush());
  return out;
}

describe("StreamingNarrationSegmenter", () => {
  it("flushes per sentence so speech starts on sentence one", () => {
    const out = run(["The road is dusty. ", "A cart rumbles past. ", "You smell rain."]);
    expect(out).toEqual([
      { kind: "dm", text: "The road is dusty." },
      { kind: "dm", text: "A cart rumbles past." },
      { kind: "dm", text: "You smell rain." },
    ]);
  });

  it("emits a sentence as soon as the terminator+space arrives, not at flush", () => {
    const s = new StreamingNarrationSegmenter();
    expect(s.push("You open the door.")).toEqual([]); // no trailing space yet
    expect(s.push(" ")).toEqual([{ kind: "dm", text: "You open the door." }]);
    expect(s.push("Light spills out.")).toEqual([]);
    expect(s.flush()).toEqual([{ kind: "dm", text: "Light spills out." }]);
  });

  it("switches voice on a marker and flushes the prior voice immediately", () => {
    const out = run(['The guard steps forward. [NPC:Sildar] "Halt!" ', "[NPC:Klarg] Klarg roars."]);
    expect(out).toEqual([
      { kind: "dm", text: "The guard steps forward." },
      { kind: "npc", npcKey: "sildar", text: '"Halt!"' },
      { kind: "npc", npcKey: "klarg", text: "Klarg roars." },
    ]);
  });

  it("handles a marker split across chunks", () => {
    const out = run(["Sildar turns. [NP", "C:Sild", "ar] ", '"We flee."']);
    expect(out).toEqual([
      { kind: "dm", text: "Sildar turns." },
      { kind: "npc", npcKey: "sildar", text: '"We flee."' },
    ]);
  });

  it("flushes a partial (unterminated) sentence at a voice change", () => {
    const out = run(["The door creaks and [NPC:Sildar] he whispers."]);
    expect(out).toEqual([
      { kind: "dm", text: "The door creaks and" },
      { kind: "npc", npcKey: "sildar", text: "he whispers." },
    ]);
  });

  it("does not split on a decimal or abbreviation mid-number", () => {
    const out = run(["You need a 3.5 on the check. Roll it."]);
    expect(out).toEqual([
      { kind: "dm", text: "You need a 3.5 on the check." },
      { kind: "dm", text: "Roll it." },
    ]);
  });

  it("keeps the boundary after a closing quote following a terminator", () => {
    const out = run(['He shouts "Run!" ', "Then silence."]);
    expect(out).toEqual([
      { kind: "dm", text: 'He shouts "Run!"' },
      { kind: "dm", text: "Then silence." },
    ]);
  });

  it("treats a non-marker bracket as literal text", () => {
    const out = run(["You see a sign [closed]. Move on."]);
    expect(out).toEqual([
      { kind: "dm", text: "You see a sign [closed]." },
      { kind: "dm", text: "Move on." },
    ]);
  });

  it("treats an unterminated marker at end-of-stream as literal", () => {
    const out = run(["A whisper [NPC:Sil"]);
    expect(out).toEqual([{ kind: "dm", text: "A whisper [NPC:Sil" }]);
  });

  it("is equivalent to parseNarrationSegments when joined back per voice", () => {
    // The streamed segments, merged by consecutive same-voice runs, match the
    // batch parser's voice attribution (chunking is finer, attribution identical).
    const narration =
      'You enter the cave. [NPC:Klarg] "Who dares?" The bugbear lifts his axe. [NPC:Sildar] "Easy now."';
    const streamed = run([narration]);

    const merged: NarrationSegment[] = [];
    for (const seg of streamed) {
      const prev = merged[merged.length - 1];
      const sameVoice =
        prev !== undefined &&
        prev.kind === seg.kind &&
        (seg.kind === "dm" || (prev as { npcKey: string }).npcKey === seg.npcKey);
      if (sameVoice) prev!.text += ` ${seg.text}`;
      else merged.push({ ...seg });
    }
    expect(merged).toEqual(parseNarrationSegments(narration));
  });
});
