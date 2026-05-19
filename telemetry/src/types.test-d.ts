// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// Type-level tests. This file is type-checked but produces no runtime output.
// Each pragma asserts that the very next line MUST fail to compile. If it
// compiles, tsc reports "Unused" and the build fails — the exact signal we
// want for "the type system rejected the PII smuggle attempt."

import { asPII, type PII, type NoPII } from "./types.js";
import type { Events } from "./events.js";

// Sanity: a plain payload satisfies NoPII<T>.
export const okPayload: NoPII<{ a: string; b: number }> = { a: "x", b: 1 };

// A PII-branded value collapses to `never` under NoPII; assigning a real PII
// value to that slot must fail.
type RejectedString = NoPII<PII<string>>;
// @ts-expect-error — PII-branded value must be rejected by NoPII
export const rejectedString: RejectedString = asPII("123");

// Same shape, but extracted from a real registered event's payload type:
// any property that gets a PII brand layered on is un-assignable.
type SessionStartedProps = Events["session.started"]["props"];
type PIISessionProps = SessionStartedProps & { discordId: PII<string> };
type RejectedDiscordId = NoPII<PIISessionProps>["discordId"];
// @ts-expect-error — PII-branded value must be rejected by NoPII
export const rejectedDiscordId: RejectedDiscordId = asPII("123");
