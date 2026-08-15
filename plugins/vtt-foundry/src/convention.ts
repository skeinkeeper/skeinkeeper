// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Foundry public-chat IC/OOC markers (TDD 0034 §5).
 * `!ooc` and `((parens))` are OOC; a configured wake phrase is IC.
 */
export function parseChatConvention(
  text: string,
  opts?: { wakePhrase?: string },
): "ic" | "ooc" | undefined {
  const trimmed = text.trim();
  if (/^!ooc\b/i.test(trimmed)) return "ooc";
  if (/^\(\(.*\)\)$/.test(trimmed)) return "ooc";
  const wake = opts?.wakePhrase?.trim();
  if (wake !== undefined && wake.length > 0) {
    if (trimmed.toLowerCase().startsWith(wake.toLowerCase())) return "ic";
  }
  return undefined;
}
