# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Skeinkeeper Contributors
#
# Operator-app image (design doc 0020 §7). Runs `pnpm app:start` — the Discord
# gateway + voice loop + local web console. Foundry and the MCP bridge run
# outside the container; point FOUNDRY_URL at them.
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
EXPOSE 3000

CMD ["pnpm", "app:start"]
