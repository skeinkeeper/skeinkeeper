// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

export { audienceKind, type Audience } from "./audience.js";
export { type ConsoleControl, type SurfaceInputEvent, type TtsStream } from "./events.js";
export {
  isInboundSurface,
  isOutboundSurface,
  type InboundSurface,
  type OutboundSurface,
  type SurfaceOutput,
} from "./surface.js";
export { AsyncQueue } from "./async_queue.js";
export { FakeInboundSurface, FakeOutboundSurface } from "./fake.js";
export {
  NoHandlingSurfaceError,
  SurfaceRouter,
  type EmitReport,
  type SurfaceRouterOptions,
} from "./router.js";
