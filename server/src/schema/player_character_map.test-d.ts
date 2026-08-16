// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { asPII, type NoPII, type PII } from "@skeinkeeper/core";
import type { PlayerCharacterMapPii } from "./player_character_map.js";

type Discord = PlayerCharacterMapPii["discordUserId"];
type FoundryUser = PlayerCharacterMapPii["foundryUserId"];

type RejectedDiscord = NoPII<Discord>;
// @ts-expect-error — discordUserId is PII
export const rejectedDiscord: RejectedDiscord = asPII("discord:1");

type RejectedFoundry = NoPII<FoundryUser>;
// @ts-expect-error — foundryUserId is PII
export const rejectedFoundry: RejectedFoundry = asPII("foundry-user-1") as PII<string> | null;
