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
    case "createToken":
    case "addActorItems":
      // Token spawn, compendium-to-world import, and inventory writes are the
      // TDD 0042 write surface — they touch v13/v14 APIs that must be validated
      // against a live Foundry. Until that lands, fail loudly with a clear code
      // rather than return null (a silent no-op looked like success to callers).
      throw Object.assign(new Error(`${method} is not implemented yet (TDD 0042)`), {
        code: "not-implemented",
      });
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

function openGateway() {
  if (!game.user?.isGM) return;
  const url = setting("gatewayUrl") || "ws://127.0.0.1:7733";
  const pairingSecret = setting("pairingSecret") || "";
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error(`${MODULE_ID}: failed to open ${url}`, err);
    return;
  }

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        moduleId: MODULE_ID,
        foundryVersion: game.version ?? "",
        worldId: game.world?.id ?? game.world?.title ?? "",
        pairingSecret,
      }),
    );
  });

  ws.addEventListener("message", async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type !== "req") return;
    try {
      const result = await dispatch(msg.method, msg.params ?? {});
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, result }));
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "res",
          id: msg.id,
          ok: false,
          error: { code: err?.code ?? "error", message: err?.message ?? String(err) },
        }),
      );
    }
  });

  Hooks.on("createChatMessage", (message) => {
    if (message.getFlag?.(MODULE_ID, "echo") === true) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    const whisper = message.whisper ?? [];
    ws.send(
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
  openGateway();
});
