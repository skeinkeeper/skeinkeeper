// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Operator / DM Foundry-user resolution (TDD 0036).
 * Escalation whispers must target a dedicated GM Foundry user, never the
 * operator's player-map login (spoiler path).
 */

export function pickOperatorFoundryUserId(args: {
  dedicatedOperatorFoundryUserId?: string;
  mappedOperatorFoundryUserId?: string;
}): string | undefined {
  return args.dedicatedOperatorFoundryUserId;
}

export function pickDmFoundryUserId(args: {
  campaignDmFoundryUserId?: string;
  dedicatedOperatorFoundryUserId?: string;
  mappedOperatorFoundryUserId?: string;
}): string | undefined {
  return args.campaignDmFoundryUserId ?? args.dedicatedOperatorFoundryUserId;
}
