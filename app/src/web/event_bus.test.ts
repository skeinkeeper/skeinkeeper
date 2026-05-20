// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { EventBus } from "./event_bus.js";
import type { AppEvent } from "../session_manager.js";

describe("EventBus", () => {
  it("fans out to subscribers and supports unsubscribe", () => {
    const bus = new EventBus();
    const got: AppEvent[] = [];
    const unsub = bus.subscribe((e) => got.push(e));
    bus.emit({ kind: "status", status: "running" });
    expect(got).toHaveLength(1);
    unsub();
    bus.emit({ kind: "status", status: "stopped" });
    expect(got).toHaveLength(1);
    expect(bus.size).toBe(0);
  });

  it("isolates a throwing subscriber from the rest", () => {
    const bus = new EventBus();
    const got: AppEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad subscriber");
    });
    bus.subscribe((e) => got.push(e));
    bus.emit({ kind: "consent_prompt", speaker: "discord:1" });
    expect(got).toHaveLength(1);
  });
});
