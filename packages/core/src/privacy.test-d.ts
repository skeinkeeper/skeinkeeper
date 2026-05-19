// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// Type-level tests for the PII brand. Each pragma asserts the next line
// must fail to compile.

import { asPII, type PII, type NoPII } from "./privacy.js";

export const okPayload: NoPII<{ a: string; b: number }> = { a: "x", b: 1 };

type RejectedString = NoPII<PII<string>>;
// @ts-expect-error — PII-branded value must be rejected by NoPII
export const rejectedString: RejectedString = asPII("123");

type WithNestedPII = { user: { id: PII<string>; name: string } };
type RejectedNested = NoPII<WithNestedPII>["user"]["id"];
// @ts-expect-error — nested PII is also rejected
export const rejectedNestedField: RejectedNested = asPII("123");
