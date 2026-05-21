// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { normalizeNpcKey, type NarrationSegment } from "./markers.js";

/**
 * Incremental narration segmenter (design doc 0028 P1). Where
 * `parseNarrationSegments` splits a *complete* narration by `[NPC:name]` voice
 * markers, this consumes the LLM token stream and emits **speakable units** as
 * soon as each is complete — so the table hears segment N while the model is
 * still generating segment N+1.
 *
 * A unit flushes at either boundary:
 *  - a **sentence** end (`.`/`!`/`?`, allowing trailing quotes/brackets, then
 *    whitespace) — so a multi-sentence beat starts playing on sentence one;
 *  - a **voice change** (`[NPC:key]` marker) — the prior voice's remaining text
 *    flushes immediately, even mid-sentence (a voice switch is a hard cut).
 *
 * Robust to markers split across chunks ("[NP" then "C:Sildar]"): a partial
 * marker is held until it completes or is proven not a marker (then it's
 * literal text). Pure/stateful and fully unit-testable; the always-listening
 * loop drives it from `text_delta` events.
 */

const TERMINATORS = new Set([".", "!", "?"]);
// Closing punctuation that may follow a terminator without ending the sentence
// boundary detection (`He said "Run!"` → flush after the quote, not before).
const TRAILING = new Set(['"', "'", "”", "’", ")", "]", "»"]);

export class StreamingNarrationSegmenter {
  private currentNpc: string | null = null;
  /** Accumulated text for the current voice not yet emitted. */
  private seg = "";
  /** When inside a possible `[...]` marker: the interior chars seen after `[`. */
  private marker: string | null = null;
  /** A sentence terminator (or terminator+trailing) is pending a flush. */
  private sawTerminator = false;

  /** Feed a chunk of streamed narration; returns any newly completed segments. */
  push(chunk: string): NarrationSegment[] {
    const out: NarrationSegment[] = [];
    for (const ch of chunk) this.consume(ch, out);
    return out;
  }

  /** End the stream: emit the final pending segment (and any unterminated
   *  marker as literal text). */
  flush(): NarrationSegment[] {
    const out: NarrationSegment[] = [];
    if (this.marker !== null) {
      this.seg += `[${this.marker}`;
      this.marker = null;
    }
    this.emit(out);
    return out;
  }

  private consume(ch: string, out: NarrationSegment[]): void {
    if (this.marker !== null) {
      this.consumeInMarker(ch, out);
      return;
    }
    if (ch === "[") {
      this.marker = "";
      return;
    }
    // Normal text.
    this.seg += ch;
    if (/\s/.test(ch)) {
      if (this.sawTerminator) {
        this.emit(out); // sentence boundary: terminator then whitespace
        this.sawTerminator = false;
      }
    } else if (TERMINATORS.has(ch)) {
      this.sawTerminator = true;
    } else if (!TRAILING.has(ch)) {
      this.sawTerminator = false; // e.g. "3.5" or "Mr.X" — not a sentence end
    }
    // TRAILING chars keep sawTerminator pending.
  }

  private consumeInMarker(ch: string, out: NarrationSegment[]): void {
    const interior = this.marker ?? "";
    if (ch === "]") {
      const key = parseMarkerKey(interior);
      if (key !== null) {
        // Voice change: flush the prior voice's text (even mid-sentence), switch.
        this.emit(out);
        this.sawTerminator = false;
        this.currentNpc = key;
      } else {
        this.seg += `[${interior}]`; // not a marker — literal
      }
      this.marker = null;
      return;
    }
    if (isViableMarkerInterior(interior + ch)) {
      this.marker = interior + ch;
      return;
    }
    // Not a marker after all: the "[" + interior is literal; reprocess ch.
    this.seg += `[${interior}`;
    this.marker = null;
    this.consume(ch, out);
  }

  private emit(out: NarrationSegment[]): void {
    const text = this.seg.trim();
    this.seg = "";
    if (text.length === 0) return;
    out.push(
      this.currentNpc === null
        ? { kind: "dm", text }
        : { kind: "npc", npcKey: this.currentNpc, text },
    );
  }
}

/** Whether the chars seen after `[` could still become a `[NPC:key]` marker. */
function isViableMarkerInterior(interior: string): boolean {
  const prefix = "NPC:";
  if (interior.length <= prefix.length) {
    return prefix.slice(0, interior.length).toLowerCase() === interior.toLowerCase();
  }
  // Past "NPC:" — the rest is the key (any non-"]" chars; "]" is handled before here).
  return interior.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** Extract + normalize the key from a marker interior, or null if not a marker. */
function parseMarkerKey(interior: string): string | null {
  const m = /^NPC:\s*([^\]]+?)\s*$/i.exec(interior);
  return m ? normalizeNpcKey(m[1]!) : null;
}
