// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { LifecycleAnnouncements } from "../sessions/cached-announcements.js";

/**
 * Per-session transient flags (TDD 0032). Distinct from durable SessionConfig
 * intake and from SessionManager operator-control state.
 */
export interface SessionRunState {
  /** False at session start; true after refreshIndex first-completes. */
  coldIndexReady: boolean;
  /** Pause/resume TTS announcements, generated once at session start
   *  (design doc 0039). Absent until generation completes; the defaults
   *  cover a pause that fires first. */
  lifecycleAnnouncements?: LifecycleAnnouncements;
}

export function createSessionRunState(): SessionRunState {
  return { coldIndexReady: false };
}
