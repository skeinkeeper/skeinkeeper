// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Per-session transient flags (TDD 0032). Distinct from durable SessionConfig
 * intake and from SessionManager operator-control state.
 */
export interface SessionRunState {
  /** False at session start; true after refreshIndex first-completes. */
  coldIndexReady: boolean;
}

export function createSessionRunState(): SessionRunState {
  return { coldIndexReady: false };
}
