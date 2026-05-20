// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { STTOptions, Utterance } from "@skeinkeeper/orchestrator";

/**
 * Shared plumbing for the Deepgram/ElevenLabs REST + streaming adapters so the
 * HTTP-error, audio-draining, and utterance-shaping logic lives in one place.
 */

/** Throw a consistent error when a provider HTTP response isn't ok. */
export function assertOk(res: Response, label: string): void {
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
}

/** Concatenate an audio stream into a single byte buffer (prerecorded STT). */
export async function drainBytes(audio: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of audio) {
    chunks.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Concatenate an audio stream into a Blob (multipart STT uploads). */
export async function drainBlob(
  audio: AsyncIterable<Uint8Array>,
  type = "application/octet-stream",
): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  for await (const c of audio) chunks.push(c);
  return new Blob(chunks, { type });
}

/** Assemble a finalized Utterance from STT options + transcript (+ confidence).
 *  Centralizes the optional displayName/confidence/timestamp spread. */
export function buildUtterance(opts: STTOptions, text: string, confidence?: number): Utterance {
  return {
    speaker: opts.speaker,
    ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
    text,
    ...(typeof confidence === "number" ? { confidence } : {}),
    timestamp: Date.now(),
  };
}
