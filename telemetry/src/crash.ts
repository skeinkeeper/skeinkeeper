// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import * as Sentry from "@sentry/node";

export interface CrashConfig {
  /** True only if the operator has explicitly enabled crash reporting. */
  enabled: boolean;
  /** Opaque rotating token; never derived from operator identity. */
  installationId: string;
  sentryDsn?: string;
  environment?: string;
  release?: string;
}

export interface CrashContext {
  module?: string;
  sessionId?: string;
}

export interface CrashClient {
  captureError(err: unknown, context?: CrashContext): void;
  flush(): Promise<void>;
}

class NoopCrash implements CrashClient {
  captureError(_err: unknown, _context?: CrashContext): void {
    // Intentional no-op: crash reporting is off.
  }
  async flush(): Promise<void> {
    // No client to flush.
  }
}

class SentryCrash implements CrashClient {
  constructor(private readonly installationId: string) {}

  captureError(err: unknown, context?: CrashContext): void {
    Sentry.withScope((scope) => {
      scope.setUser({ id: this.installationId });
      if (context?.module) scope.setTag("module", context.module);
      if (context?.sessionId) scope.setTag("sessionId", context.sessionId);
      Sentry.captureException(err);
    });
  }

  async flush(): Promise<void> {
    await Sentry.flush(2_000);
  }
}

export function createCrash(config: CrashConfig): CrashClient {
  if (!config.enabled || !config.sentryDsn) return new NoopCrash();
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.environment ?? "production",
    ...(config.release !== undefined ? { release: config.release } : {}),
    // Strip likely-PII from breadcrumbs and events. The operator can tighten
    // this further per the privacy disclosure.
    sendDefaultPii: false,
  });
  return new SentryCrash(config.installationId);
}
