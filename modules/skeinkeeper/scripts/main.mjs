// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors
//
// GM-session add-on. Player clients load the package and do nothing.
// Foundry v13/v14. No outbound URL except the operator-set gateway.

const MODULE_ID = "skeinkeeper";

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function actorPayload(actor) {
  if (!actor) return null;
  return {
    id: actor.id,
    name: actor.name,
    type: actor.type,
    system: actor.system ?? {},
    flags: actor.flags ?? {},
  };
}

function scenePayload(scene) {
  if (!scene) return null;
  const tokens = [];
  for (const t of scene.tokens ?? []) {
    tokens.push({
      actorId: t.actorId,
      name: t.name,
      disposition: t.disposition,
      id: t.id,
      hidden: t.hidden,
      x: t.x,
      y: t.y,
    });
  }
  return { id: scene.id, name: scene.name, active: scene.active, tokens };
}

function roleOf(user) {
  const ROLE = CONST?.USER_ROLES ?? {};
  if (user.role === ROLE.GAMEMASTER) return "GAMEMASTER";
  if (user.role === ROLE.ASSISTANT) return "ASSISTANT";
  if (user.role === ROLE.TRUSTED) return "TRUSTED";
  return "PLAYER";
}

function chatStyle(mode) {
  const CONSTS = CONST ?? {};
  const types = CONSTS.CHAT_MESSAGE_STYLES ?? CONSTS.CHAT_MESSAGE_TYPES ?? {};
  if (mode === "whisper") return types.WHISPER ?? types.OTHER ?? 0;
  if (mode === "gm") return types.OTHER ?? types.OOC ?? 0;
  return types.OTHER ?? types.OOC ?? 0;
}

async function dispatch(method, params) {
  switch (method) {
    case "listPartyActors":
      return [...game.actors]
        .filter((a) => a.hasPlayerOwner && a.type === "character")
        .map(actorPayload);
    case "listWorldActors":
      return [...game.actors].map(actorPayload);
    case "getActor":
      return actorPayload(game.actors.get(params.actorId));
    case "getActiveScene":
      return scenePayload(game.scenes.active);
    case "listScenes":
      return [...game.scenes].map((s) => ({ id: s.id, name: s.name, active: s.active }));
    case "listSceneActors": {
      const scene = game.scenes.get(params.sceneId) ?? game.scenes.active;
      if (!scene) return [];
      const out = [];
      for (const t of scene.tokens ?? []) {
        const actor = t.actor ?? game.actors.get(t.actorId);
        if (actor) out.push(actorPayload(actor));
      }
      return out;
    }
    case "setActiveScene": {
      const scene =
        game.scenes.get(params.sceneIdOrName) ??
        game.scenes.find((s) => s.name === params.sceneIdOrName);
      if (scene) await scene.activate();
      return null;
    }
    case "getWorldInfo": {
      const sys = game.system;
      return {
        connected: true,
        system: sys ? { id: sys.id, name: sys.title ?? sys.id } : null,
        modules: [...game.modules].map(([id, m]) => ({
          id,
          title: m.title ?? id,
          active: m.active === true,
        })),
      };
    }
    case "listUsers":
      return [...game.users].map((u) => ({
        id: u.id,
        name: u.name,
        role: roleOf(u),
        isActive: u.active === true,
        // Ownership must be evaluated per user `u`. `actor.isOwner` reflects the
        // *current* (GM) session, so a GM would appear to own every actor and the
        // 3-way pre-flight verifier (owners.length === 1) would flag correctly
        // configured worlds. testUserPermission(u, "OWNER") is the per-user check.
        ownedActorIds: [...game.actors]
          .filter((a) => a.testUserPermission?.(u, "OWNER") === true)
          .map((a) => a.id),
      }));
    case "listCompendiumPacks":
      return [...game.packs].map((p) => ({
        id: p.collection ?? p.metadata?.id ?? p.metadata?.name,
        label: p.metadata?.label ?? p.title ?? "",
        type: p.metadata?.type,
      }));
    case "searchCompendium": {
      const q = String(params.query ?? "").toLowerCase();
      const wantType = params.packType;
      const hits = [];
      for (const pack of game.packs) {
        const type = pack.metadata?.type ?? pack.documentName;
        if (wantType && type !== wantType) continue;
        const index = await pack.getIndex();
        for (const e of index) {
          if (q.length === 0 || (e.name ?? "").toLowerCase().includes(q)) {
            hits.push({ id: e._id ?? e.id, name: e.name, packId: pack.collection, type });
          }
        }
      }
      return hits;
    }
    case "listCreaturesByCriteria": {
      const name = String(params.name ?? "").toLowerCase();
      const wantType = params.type;
      const hits = [];
      for (const pack of game.packs) {
        const type = pack.metadata?.type ?? pack.documentName;
        if (type !== "Actor") continue;
        const index = await pack.getIndex();
        for (const e of index) {
          const nm = (e.name ?? "").toLowerCase();
          if (name.length > 0 && !nm.includes(name)) continue;
          if (wantType && e.type !== undefined && e.type !== wantType) continue;
          hits.push({ id: e._id ?? e.id, name: e.name, packId: pack.collection, type: e.type });
        }
      }
      return hits;
    }
    case "searchJournals": {
      const q = String(params.query ?? "").toLowerCase();
      const hits = [];
      for (const j of game.journal ?? []) {
        if (q.length === 0 || (j.name ?? "").toLowerCase().includes(q)) {
          hits.push({ id: j.id, name: j.name });
        }
      }
      return hits;
    }
    case "getJournal": {
      const j = game.journal?.get(params.journalId);
      if (!j) return null;
      const pages = [];
      for (const p of j.pages ?? []) {
        pages.push({ id: p.id, name: p.name, text: p.text?.content ?? "" });
      }
      const text = pages
        .map((p) => p.text)
        .filter((t) => t && t.length > 0)
        .join("\n\n");
      return { id: j.id, name: j.name, text, pages };
    }
    case "getTokenDetails": {
      const found = findTokenDoc(params.tokenId);
      if (!found) return null;
      const { token, scene } = found;
      return {
        id: token.id,
        actorId: token.actorId,
        name: token.name,
        hidden: token.hidden === true,
        x: token.x,
        y: token.y,
        sceneId: scene.id,
        disposition: token.disposition,
      };
    }
    case "updateToken": {
      const found = findTokenDoc(params.tokenId);
      if (!found) throw Object.assign(new Error("not-found"), { code: "not-found" });
      const patch = {};
      if (typeof params.hidden === "boolean") patch.hidden = params.hidden;
      if (typeof params.x === "number") patch.x = params.x;
      if (typeof params.y === "number") patch.y = params.y;
      await found.token.update(patch);
      return null;
    }
    case "moveToken": {
      const found = findTokenDoc(params.tokenId);
      if (!found) throw Object.assign(new Error("not-found"), { code: "not-found" });
      await found.token.update({ x: params.x, y: params.y });
      return null;
    }
    case "createActorFromCompendium":
      return createActorFromCompendium(params);
    case "createToken":
      return createToken(params);
    case "addActorItems":
      return addActorItems(params);
    case "manageCombat":
      return manageCombat(params);
    case "applyDamage":
      return applyDamage(params);
    case "manageFog":
      return manageFog(params);
    case "applyActorUpdate": {
      const actor = game.actors.get(params.actorId);
      if (!actor) throw Object.assign(new Error("not-found"), { code: "not-found" });
      const update = params.update ?? {};
      if (typeof update.condition === "string") {
        const token = actor.getActiveTokens?.()?.[0];
        if (token?.toggleEffect)
          await token.toggleEffect(update.condition, { active: update.active !== false });
        return null;
      }
      if (update.position && tokenOrFirst(actor)) {
        const token = tokenOrFirst(actor);
        await token.document.update({ x: update.position.x, y: update.position.y });
      }
      return null;
    }
    case "postChatMessage": {
      const data = {
        content: params.content,
        style: chatStyle(params.mode),
        flags: { skeinkeeper: { echo: true } },
      };
      if (params.mode === "whisper" && Array.isArray(params.whisperTo)) {
        data.whisper = [...params.whisperTo];
      }
      if (params.mode === "gm") {
        data.whisper = [...game.users].filter((u) => u.isGM).map((u) => u.id);
      }
      if (params.speaker) data.speaker = params.speaker;
      const msg = await ChatMessage.create(data);
      return { messageId: msg?.id ?? "" };
    }
    case "rollDice": {
      const roll = await new Roll(params.formula).evaluate();
      const rollMode =
        params.mode === "gm"
          ? "gmroll"
          : params.mode === "blind"
            ? "blindroll"
            : params.mode === "whisperTo"
              ? "whisper"
              : "publicroll";
      const msg = await roll.toMessage(
        {
          flavor: params.flavor,
          speaker: params.speaker ? { alias: params.speaker } : undefined,
          flags: { skeinkeeper: { echo: true } },
        },
        { rollMode },
      );
      return {
        total: roll.total,
        rolls: roll.dice?.flatMap((d) => d.results?.map((r) => r.result) ?? []) ?? [roll.total],
        formula: params.formula,
        messageId: msg?.id,
      };
    }
    case "deleteChatMessages": {
      // Per-scope predicate. An UNRECOGNIZED scope matches nothing (fail safe):
      // the previous fall-through pushed every message and would have wiped the
      // whole chat log on an unhandled scope such as "by-time-range".
      const scope = params.scope;
      const since = params.since ? Date.parse(params.since) : undefined;
      const until = params.until ? Date.parse(params.until) : undefined;
      const matches = (m) => {
        if (scope === "by-author") return m.author?.id === params.authorFoundryUserId;
        if (scope === "by-recipient")
          return (m.whisper ?? []).includes(params.recipientFoundryUserId);
        if (scope === "by-time-range") {
          const t = typeof m.timestamp === "number" ? m.timestamp : Date.parse(m.timestamp ?? "");
          if (Number.isNaN(t)) return false;
          if (since !== undefined && !Number.isNaN(since) && t < since) return false;
          if (until !== undefined && !Number.isNaN(until) && t > until) return false;
          return true;
        }
        return false;
      };
      const ids = [];
      for (const m of game.messages) if (matches(m)) ids.push(m.id);
      if (ids.length > 0) await ChatMessage.deleteDocuments(ids);
      return { deletedCount: ids.length };
    }
    default:
      throw Object.assign(new Error(`unknown method ${method}`), { code: "unknown-method" });
  }
}

function tokenOrFirst(actor) {
  return actor.getActiveTokens?.()?.[0];
}

/** Locate a token document by id across all scenes (tokens live on scenes in
 *  v13/v14). Returns the token doc + its scene, or null. */
function findTokenDoc(tokenId) {
  for (const scene of game.scenes ?? []) {
    const token = scene.tokens?.get?.(tokenId);
    if (token) return { token, scene };
  }
  return null;
}

// ---- TDD 0042: mechanical writes (combat, damage, fog, tokens) ----

function opError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** "pack.entry" → { packId, itemId }: pack ids contain dots, the entry never
 *  does, so the last segment is the entry (mirrors orchestrator parseCompendiumRef). */
function splitCompendiumRef(ref) {
  const parts = String(ref).split(".");
  if (parts.length < 2) return { packId: "", itemId: String(ref) };
  return { packId: parts.slice(0, -1).join("."), itemId: parts[parts.length - 1] };
}

function resolveScene(sceneId) {
  const scene = sceneId ? game.scenes.get(sceneId) : game.scenes.active;
  if (!scene) throw opError("not-found", `scene ${sceneId ?? "(active)"} not found`);
  return scene;
}

async function createActorFromCompendium(params) {
  const pack = game.packs.get(params.packId);
  if (!pack) throw opError("not-found", `compendium pack ${params.packId} is not loaded`);
  const entry = await pack.getDocument(params.itemId).catch(() => null);
  if (!entry) throw opError("not-found", `entry ${params.itemId} not in pack ${params.packId}`);
  // The orchestrator dedupes re-imports by flags.core.sourceId with exactly
  // this "Compendium.<pack>.<entry>" shape, so record it explicitly rather
  // than rely on version-dependent _stats.compendiumSource.
  const actor = await game.actors.importFromCompendium(pack, params.itemId, {
    flags: { core: { sourceId: `Compendium.${params.packId}.${params.itemId}` } },
  });
  return actorPayload(actor);
}

async function createToken(params) {
  if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
    throw opError("bad-args", "x and y must be finite scene-pixel coordinates");
  }
  let actorId = params.actorId;
  if (!actorId && params.compendiumRef) {
    const created = await createActorFromCompendium(splitCompendiumRef(params.compendiumRef));
    actorId = created.id;
  }
  if (!actorId) throw opError("bad-args", "actorId or compendiumRef required");
  const actor = game.actors.get(actorId);
  if (!actor) throw opError("not-found", `actor ${actorId} not found`);
  const scene = resolveScene(params.sceneId);
  // Build from the prototype token so image/size/vision carry over.
  const tokenDoc = await actor.getTokenDocument({
    x: params.x,
    y: params.y,
    hidden: params.hidden === true,
  });
  const data = tokenDoc.toObject();
  data.actorId = actor.id;
  if (typeof params.disposition === "string") {
    const D = CONST?.TOKEN_DISPOSITIONS ?? { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 };
    data.disposition =
      params.disposition === "hostile"
        ? D.HOSTILE
        : params.disposition === "friendly"
          ? D.FRIENDLY
          : D.NEUTRAL;
  }
  const [token] = await scene.createEmbeddedDocuments("Token", [data]);
  if (!token) throw opError("error", "token creation returned no document");
  return { tokenId: token.id, actorId: actor.id };
}

async function addActorItems(params) {
  const actor = game.actors.get(params.actorId);
  if (!actor) throw opError("not-found", `actor ${params.actorId} not found`);
  const toCreate = [];
  for (const item of params.items ?? []) {
    const quantity = Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 1;
    let source;
    if (item.compendiumId) {
      const { packId, itemId } = splitCompendiumRef(item.compendiumId);
      const pack = game.packs.get(packId);
      if (!pack) throw opError("not-found", `compendium pack ${packId} is not loaded`);
      source = await pack.getDocument(itemId).catch(() => null);
      if (!source) throw opError("not-found", `item ${item.compendiumId} not found`);
    } else if (item.itemId) {
      source = game.items.get(item.itemId);
      if (!source) throw opError("not-found", `world item ${item.itemId} not found`);
    } else {
      throw opError("bad-args", "each item requires compendiumId or itemId");
    }
    const data = source.toObject();
    // dnd5e (the validated system) tracks stack size at system.quantity.
    if (data.system && typeof data.system === "object") data.system.quantity = quantity;
    toCreate.push(data);
  }
  if (toCreate.length > 0) await actor.createEmbeddedDocuments("Item", toCreate);
  return null;
}

function combatSnapshot(combat) {
  if (!combat) return { combatId: null, round: 0, turn: 0, currentCombatantId: null };
  const current = combat.combatant ?? null;
  return {
    combatId: combat.id,
    round: combat.round ?? 0,
    turn: combat.turn ?? 0,
    currentCombatantId: current ? (current.tokenId ?? current.actorId ?? current.id) : null,
  };
}

/** Resolve caller-supplied token-or-actor ids to scene token docs. */
function resolveCombatTokens(scene, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [...(scene?.tokens ?? [])];
  return ids.map((id) => {
    const token = scene?.tokens?.get?.(id) ?? scene?.tokens?.find?.((t) => t.actorId === id);
    if (!token) throw opError("not-found", `no token for ${id} on scene ${scene?.id}`);
    return token;
  });
}

async function addCombatants(combat, tokens) {
  const existing = new Set([...(combat.combatants ?? [])].map((c) => c.tokenId));
  const data = tokens
    .filter((t) => !existing.has(t.id))
    .map((t) => ({ tokenId: t.id, actorId: t.actorId, sceneId: t.parent?.id }));
  if (data.length > 0) await combat.createEmbeddedDocuments("Combatant", data);
}

async function manageCombat(params) {
  const action = params.action;
  const combat = game.combat ?? game.combats?.active ?? null;
  switch (action) {
    case "start": {
      // Idempotent: a second start returns the running encounter, it never
      // creates a second one (TDD 0042).
      if (combat) return combatSnapshot(combat);
      const scene = game.scenes.active;
      const created = await Combat.create({ scene: scene?.id, active: true });
      await addCombatants(created, resolveCombatTokens(scene, params.combatantIds));
      await created.startCombat();
      return combatSnapshot(created);
    }
    case "end": {
      // Missing combat is success, not an error: end is idempotent.
      if (!combat) return combatSnapshot(null);
      const snap = {
        combatId: combat.id,
        round: combat.round ?? 0,
        turn: combat.turn ?? 0,
        currentCombatantId: null,
      };
      // Combat#endCombat opens a GM confirmation dialog, which would stall a
      // headless req; delete() is the same document removal without the prompt.
      await combat.delete();
      return snap;
    }
    case "add": {
      if (!Array.isArray(params.combatantIds) || params.combatantIds.length === 0) {
        throw opError("bad-args", "add requires combatantIds");
      }
      if (!combat) throw opError("not-found", "no active combat");
      const scene = game.scenes.get(combat.scene?.id) ?? game.scenes.active;
      await addCombatants(combat, resolveCombatTokens(scene, params.combatantIds));
      return combatSnapshot(combat);
    }
    case "roll-initiative": {
      if (!combat) throw opError("not-found", "no active combat");
      if (Array.isArray(params.combatantIds) && params.combatantIds.length > 0) {
        const combatantIds = params.combatantIds.map((id) => {
          const c = [...combat.combatants].find(
            (x) => x.id === id || x.tokenId === id || x.actorId === id,
          );
          if (!c) throw opError("not-found", `no combatant for ${id}`);
          return c.id;
        });
        await combat.rollInitiative(combatantIds);
      } else {
        await combat.rollAll();
      }
      return combatSnapshot(combat);
    }
    case "next-turn": {
      if (!combat) return combatSnapshot(null);
      await combat.nextTurn();
      return combatSnapshot(combat);
    }
    case "previous-turn": {
      if (!combat) return combatSnapshot(null);
      await combat.previousTurn();
      return combatSnapshot(combat);
    }
    default:
      throw opError("bad-args", `unknown combat action ${action}`);
  }
}

async function applyDamage(params) {
  const actor = game.actors.get(params.actorId);
  if (!actor) throw opError("not-found", `actor ${params.actorId} not found`);
  const amount = Number(params.amount);
  if (!Number.isFinite(amount)) throw opError("bad-args", "amount must be a finite number");
  if (typeof actor.applyDamage === "function") {
    // dnd5e: route through the system's damage application so temp HP,
    // resistances, and death saves behave (TDD 0042; negative amounts heal).
    await actor.applyDamage(amount);
  } else {
    const hp = foundry.utils.getProperty(actor, "system.attributes.hp");
    if (!hp || typeof hp.value !== "number") {
      throw opError("bad-args", "actor has no system.attributes.hp to write");
    }
    const max = typeof hp.max === "number" ? hp.max : hp.value;
    const next = Math.min(max, Math.max(0, hp.value - amount));
    await actor.update({ "system.attributes.hp.value": next });
  }
  const hp = foundry.utils.getProperty(actor, "system.attributes.hp") ?? {};
  const result = { hp: typeof hp.value === "number" ? hp.value : 0 };
  if (typeof hp.temp === "number") result.tempHp = hp.temp;
  return result;
}

/** Core-fog reset shim: FogManager is per-viewed-scene, so view the target
 *  first; the method name gets a v13/v14 fallback like the chat-style shim. */
async function resetSceneFog(scene) {
  if (canvas?.scene?.id !== scene.id && typeof scene.view === "function") {
    await scene.view();
  }
  const fog = canvas?.fog;
  if (typeof fog?.reset === "function") return fog.reset();
  if (typeof fog?.clear === "function") return fog.clear();
  throw opError("error", "no core fog reset API on this Foundry version");
}

async function manageFog(params) {
  const scene = resolveScene(params.sceneId);
  if (params.action === "reveal-scene") {
    // Core fog, not Simple Fog (TDD 0042): disabling fog exploration lifts
    // the fog overlay for every player on the scene.
    await scene.update({ "fog.exploration": false });
    return { sceneId: scene.id };
  }
  if (params.action === "reset") {
    // Fog covers the scene again and prior exploration is discarded.
    await scene.update({ "fog.exploration": true });
    await resetSceneFog(scene);
    return { sceneId: scene.id };
  }
  throw opError("bad-args", `unknown fog action ${params.action}`);
}

// Reconnect-with-backoff state (module scope so overlapping close/error events
// don't stack timers, and so the once-registered chat hook can reach the live
// socket). The add-on redials the operator gateway after any drop, so a
// Foundry-down -> back-up cycle recovers without a manual GM reload — the
// resume path in design doc 0039 depends on it.
let currentSocket = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
const RECONNECT_MAX_MS = 30000;

function scheduleReconnect() {
  if (!game.user?.isGM) return;
  if (reconnectTimer !== null) return; // one pending attempt at a time
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  console.info(`${MODULE_ID}: gateway disconnected; reconnecting in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openGateway();
  }, delay);
}

function openGateway() {
  if (!game.user?.isGM) return;
  const url = setting("gatewayUrl") || "ws://127.0.0.1:7733";
  const pairingSecret = setting("pairingSecret") || "";
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.error(`${MODULE_ID}: failed to open ${url}`, err);
    scheduleReconnect();
    return;
  }
  currentSocket = socket;

  socket.addEventListener("open", () => {
    reconnectDelayMs = 1000; // a healthy connection resets the backoff
    socket.send(
      JSON.stringify({
        type: "hello",
        moduleId: MODULE_ID,
        foundryVersion: game.version ?? "",
        worldId: game.world?.id ?? game.world?.title ?? "",
        pairingSecret,
      }),
    );
  });

  socket.addEventListener("message", async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type !== "req") return;
    try {
      const result = await dispatch(msg.method, msg.params ?? {});
      socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true, result }));
    } catch (err) {
      socket.send(
        JSON.stringify({
          type: "res",
          id: msg.id,
          ok: false,
          error: { code: err?.code ?? "error", message: err?.message ?? String(err) },
        }),
      );
    }
  });

  // Redial on any drop. `error` is followed by `close` in browsers;
  // scheduleReconnect is idempotent, so calling from both is safe.
  socket.addEventListener("close", () => {
    if (currentSocket === socket) currentSocket = null;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    scheduleReconnect();
  });
}

// Registered ONCE, not per-connection (a per-connection registration would
// stack duplicate hooks on every reconnect). Relays chat through whichever
// socket is currently live.
function registerChatRelay() {
  Hooks.on("createChatMessage", (message) => {
    if (message.getFlag?.(MODULE_ID, "echo") === true) return;
    const socket = currentSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const whisper = message.whisper ?? [];
    socket.send(
      JSON.stringify({
        type: "evt",
        event: "chat",
        payload: {
          foundryUserId: message.author?.id ?? message.user ?? "",
          text: message.content ?? "",
          isWhisper: whisper.length > 0,
          recipients: whisper,
          timestamp: message.timestamp
            ? new Date(message.timestamp).toISOString()
            : new Date().toISOString(),
        },
      }),
    );
  });
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "gatewayUrl", {
    name: "Skeinkeeper gateway URL",
    hint: "WebSocket URL of the operator's Skeinkeeper process. Default ws://127.0.0.1:7733.",
    scope: "world",
    config: true,
    type: String,
    default: "ws://127.0.0.1:7733",
    restricted: true,
  });
  game.settings.register(MODULE_ID, "pairingSecret", {
    name: "Pairing secret",
    hint: "Must match FOUNDRY_PAIRING_SECRET on a non-loopback gateway.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true,
  });
});

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  registerChatRelay();
  openGateway();
});
