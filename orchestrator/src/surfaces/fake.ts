// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { Audience } from "./audience.js";
import { AsyncQueue } from "./async_queue.js";
import type { SurfaceInputEvent } from "./events.js";
import type { InboundSurface, OutboundSurface, SurfaceOutput } from "./surface.js";

export class FakeOutboundSurface implements OutboundSurface {
  readonly emits: SurfaceOutput[] = [];
  failWith: Error | undefined;
  delayMs = 0;
  readonly unboundedEmit?: boolean;

  constructor(
    readonly name: string,
    readonly handles: ReadonlyArray<Audience["kind"]>,
    opts?: { unboundedEmit?: boolean },
  ) {
    if (opts?.unboundedEmit === true) this.unboundedEmit = true;
  }

  async emit(output: SurfaceOutput): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith !== undefined) throw this.failWith;
    this.emits.push(output);
  }
}

export class FakeInboundSurface implements InboundSurface {
  private readonly queue = new AsyncQueue<SurfaceInputEvent>();

  constructor(readonly name: string) {}

  push(event: SurfaceInputEvent): void {
    this.queue.push(event);
  }

  close(): void {
    this.queue.close();
  }

  events(): AsyncIterable<SurfaceInputEvent> {
    return this.queue;
  }
}
