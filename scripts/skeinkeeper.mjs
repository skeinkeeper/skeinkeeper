#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// Thin wrapper that lets the operator run `pnpm skeinkeeper ...` from the
// repo root during alpha. A proper bin distribution lands with v0.5.

import { runCli } from "@skeinkeeper/server/cli";

const exit = await runCli(process.argv.slice(2));
process.exit(exit);
