// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Foundry-presence polling (TDD 0036 §6). A single-player Foundry logout
 * is not a session-pause; only the add-on/bridge dropping is (TDD 0039).
 */

export const FOUNDRY_PRESENCE_INTERVAL_MS = 60_000;

export interface FoundryPresenceUser {
  id: string;
  isActive?: boolean;
}

export interface FoundryPresenceTransition {
  kind: "dropped" | "restored";
  foundryUserId: string;
}

export function applyFoundryPresenceTick(
  previous: ReadonlyMap<string, boolean>,
  users: ReadonlyArray<FoundryPresenceUser>,
  mappedFoundryUserIds?: ReadonlySet<string>,
): { next: Map<string, boolean>; transitions: FoundryPresenceTransition[] } {
  const next = new Map(previous);
  const transitions: FoundryPresenceTransition[] = [];
  for (const user of users) {
    if (mappedFoundryUserIds !== undefined && !mappedFoundryUserIds.has(user.id)) continue;
    const active = user.isActive === true;
    const was = previous.get(user.id);
    next.set(user.id, active);
    if (was === true && !active) {
      transitions.push({ kind: "dropped", foundryUserId: user.id });
    } else if (was === false && active) {
      transitions.push({ kind: "restored", foundryUserId: user.id });
    }
  }
  return { next, transitions };
}

export interface FoundryPresencePollerOptions {
  listUsers: () => Promise<ReadonlyArray<FoundryPresenceUser>>;
  mappedFoundryUserIds?: () => ReadonlySet<string>;
  onTransition: (transition: FoundryPresenceTransition) => void;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface FoundryPresencePoller {
  tick: () => Promise<FoundryPresenceTransition[]>;
  stop: () => void;
}

export function startFoundryPresencePoll(
  opts: FoundryPresencePollerOptions,
): FoundryPresencePoller {
  let state = new Map<string, boolean>();
  const intervalMs = opts.intervalMs ?? FOUNDRY_PRESENCE_INTERVAL_MS;
  const setInt = opts.setIntervalFn ?? setInterval;
  const clearInt = opts.clearIntervalFn ?? clearInterval;

  const tick = async (): Promise<FoundryPresenceTransition[]> => {
    let users: ReadonlyArray<FoundryPresenceUser>;
    try {
      users = await opts.listUsers();
    } catch {
      return [];
    }
    const mapped = opts.mappedFoundryUserIds?.();
    const applied = applyFoundryPresenceTick(state, users, mapped);
    state = applied.next;
    for (const t of applied.transitions) opts.onTransition(t);
    return applied.transitions;
  };

  const handle = setInt(() => {
    void tick();
  }, intervalMs);

  return {
    tick,
    stop: () => {
      clearInt(handle);
    },
  };
}
