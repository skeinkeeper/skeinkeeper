// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Seam for TDD 0036's `verifyIdentityPreflight`. This TDD does not implement
 * the verifier or write Foundry ownership (PRD-rev 59a0fda).
 */
export type VerifyIdentityPreflight = (args: {
  campaignId: string;
  sessionId: string;
}) => Promise<void>;

export async function invokeIdentityPreflight(
  fn: VerifyIdentityPreflight | undefined,
  args: { campaignId: string; sessionId: string },
): Promise<void> {
  if (fn === undefined) return;
  await fn(args);
}
