# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Skeinkeeper Contributors
#
# Operator-app image (design doc 0020 §7). Runs `pnpm app:start` — the Discord
# gateway + voice loop + local web console. Foundry runs outside the container,
# on the operator's own machine; there is no third-party connector (ADR-0029).
# The first-party Skeinkeeper add-on runs in the GM's browser and dials this
# app's WebSocket gateway, so the gateway port is published to the host and the
# app binds it with FOUNDRY_GATEWAY_BIND=container (TDD 0043 / 0044) — see
# docker-compose.yml. `COPY . .` below trusts .dockerignore to keep `.env` and
# `data/` out of the image; do not build without it.
#
# LIVE-VALIDATION: not built/run in CI; validated by an operator.
FROM node:22-bookworm-slim

# ffmpeg for voice audio; ca-certificates for TLS to the providers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ENV SKEINKEEPER_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000 7733

CMD ["pnpm", "app:start"]
