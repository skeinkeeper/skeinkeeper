// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { AppEvent } from "../session_manager.js";

/**
 * Tiny pub/sub bridging the SessionManager's `onEvent` callback to the web
 * UI's Server-Sent Events stream (design doc 0020 §4). Synchronous fan-out;
 * subscribe returns an unsubscribe.
 */
export class EventBus {
  private readonly subscribers = new Set<(event: AppEvent) => void>();

  emit(event: AppEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // a bad subscriber must not break the others
      }
    }
  }

  subscribe(fn: (event: AppEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  get size(): number {
    return this.subscribers.size;
  }
}
