// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  DiscordConsentSurface,
  DiscordVoiceIO,
  DiscordVoiceSurface,
  type PresenceSource,
} from "@skeinkeeper/voice-discord";
import {
  FoundryChatCommandSurface,
  FoundryGmChatSurface,
  FoundryPublicChatSurface,
  FoundryWhisperSurface,
  parseSkeinkeeperCommand,
  registerFoundrySystemTools,
} from "@skeinkeeper/vtt-foundry";
import {
  DEFAULT_PAUSE_ANNOUNCEMENT,
  DEFAULT_RESUME_ANNOUNCEMENT,
  Mutex,
  PVP_SETTING_KEY,
  PausedInputBuffer,
  SideChannelCoordinator,
  SideChannelIdentityMap,
  SurfaceRouter,
  ToolDispatcher,
  createLifecycleController,
  formatIdentityPreflightReport,
  prepareLifecycleAnnouncements,
  runResumePreflight,
  startFoundryHeartbeat,
  type BufferFragment,
  type FoundryHeartbeat,
  type LifecycleController,
  type LifecyclePreflightOutcome,
  type ResumeResult,
  type SessionLifecycleState,
  activateScene,
  archiveSession,
  announceReadyAllowed,
  applyIntakeResolution,
  createSessionRunState,
  assignNpcVoice as assignNpcVoiceLLM,
  createDefaultRegistry,
  isEagerness,
  createIntakeResolutionState,
  executePreflightVerify,
  formatIntakeReportForOperator,
  identityFindingSeverity,
  kickExtendedIntake,
  loadIntakeConfig,
  runIdentityPreflight,
  startFoundryPresencePoll,
  type FoundryPresencePoller,
  type IdentityPreflightResult,
  NullFoundryEventStream,
  persistFindingResolution,
  persistSurfacedFindings,
  runSessionStartIntake,
  saveIntakeConfig,
  endSession,
  findDefaultBehaviorSpec,
  loadBehaviorSpec,
  pvpEnabledFromSetting,
  runAlwaysListeningSession,
  startSession,
  VOICE_CONSENT_TEXT,
  type ConsoleControl,
  type Eagerness,
  type ExtendedIntakeResult,
  type IntakeFinding,
  type IntakeResolutionState,
  type IntakeResolveResult,
  type FoundryClient,
  type MemoryStore,
  type PresenceMember,
  type Session,
  type VoiceIO,
} from "@skeinkeeper/orchestrator";
import type { TenantDb } from "@skeinkeeper/server";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { AppConfig } from "./config.js";
import type { ConsentService } from "./consent.js";
import type { FoundrySource } from "./foundry_source.js";
import { pickDmFoundryUserId, pickOperatorFoundryUserId } from "./foundry_identity.js";
import { formatPauseDm, shouldSendPauseDm } from "./lifecycle_notification.js";
import {
  OperatorService,
  operatorActionIsPrivileged,
  resolveOperatorFromMembers,
} from "./operator.js";
import { dmPersonas, resolveDmPersonaVoice } from "./personas.js";
import type { AppProviders } from "./providers.js";
import {
  CONSENT_CUSTOM_ID,
  consentButtonIntent,
  parseSlashCommand,
  type SlashCommand,
} from "./slash_router.js";

/** Live-view events the web UI subscribes to (design docs 0020 §4, 0024). */
export type AppEvent =
  | { kind: "status"; status: "starting" | "running" | "stopped" }
  | { kind: "decision"; respond: boolean; reason: string; heard: string }
  | { kind: "turn"; narration: string; tools: ReadonlyArray<string> }
  | { kind: "consent_prompt"; speaker: string }
  /** Live voice-channel roster for the operator picker (design doc 0024). */
  | {
      kind: "roster";
      members: ReadonlyArray<{ id: string; displayName?: string; isOperator: boolean }>;
    }
  /** The current operator changed (any designation path; design doc 0024). */
  | { kind: "operator"; operatorUserId?: string; displayName?: string }
  /** A control changed from any surface — keeps console ↔ slash in sync
   *  without a refresh (design doc 0025). */
  | { kind: "eagerness"; eagerness: Eagerness }
  | { kind: "dmVoice"; voiceId: string; personaId?: string }
  /** PvP toggle changed from any surface (design doc 0026 §6). */
  | { kind: "pvp"; enabled: boolean }
  /** Intake report / resolution changed (TDD 0031). */
  | { kind: "intake"; ready: boolean; findings: IntakeView["findings"] }
  /** Degraded-fallback echo when no operator Foundry user is known (TDD 0036). */
  | { kind: "operatorEscalation"; message: string; severity: "info" | "warning" | "critical" }
  | {
      kind: "preflight";
      status: "ok" | "critical-gaps" | "warnings-only";
      findingCount: number;
      criticalCount: number;
    }
  /** Session lifecycle transition (design doc 0039): the console shows the
   *  pause indicator + Resume button on `paused-foundry-down`. */
  | {
      kind: "lifecycleStateChanged";
      state: "active" | "paused-foundry-down";
      cause?: "addon-gone" | "emit-failure" | "heartbeat-failure";
      since?: string;
    }
  /** Operator pause-notification DM consent changed (design doc 0039). */
  | { kind: "operatorDmConsent"; consented: boolean };

export interface IntakeViewFinding {
  id: number;
  code: string;
  kind: string;
  summary: string;
  detail?: string;
  dmOnly: boolean;
  options: ReadonlyArray<{ id: string; label: string }>;
}

export interface IntakeView {
  ready: boolean;
  findings: ReadonlyArray<IntakeViewFinding>;
}

export interface SessionManagerDeps {
  config: AppConfig;
  tenantDb: TenantDb;
  providers: AppProviders;
  /** Mechanical state. Production Start uses the first-party add-on
   *  (TDD 0041). Tests inject MockFoundryClient at this seam. */
  foundry: FoundrySource;
  consent: ConsentService;
  memoryStore: MemoryStore;
  campaignId: string;
  onEvent?: (event: AppEvent) => void;
  /** Opt-in telemetry sink (ADR-0009). Threaded to the session + dispatcher so
   *  llm.completed / tool.called / error.captured actually fire when enabled. */
  analytics?: AnalyticsClient;
}

/**
 * Reply to an interaction, swallowing the rejection a late/duplicate reply
 * throws (Discord's 3s ack window) so it never becomes an unhandledRejection.
 */
async function reply(
  interaction: { reply: (options: { content: string; ephemeral: boolean }) => Promise<unknown> },
  content: string,
): Promise<void> {
  try {
    await interaction.reply({ content, ephemeral: true });
  } catch {
    // Interaction expired or was already answered; nothing more to do.
  }
}

/**
 * The operator app's composition root (design doc 0020 §2). Owns the Discord
 * gateway client, joins voice, wires DiscordVoiceIO + the Session + memory +
 * per-character voice routing, and runs the always-listening loop. The web UI
 * (app/src/web) drives it: `setEagerness` is read each decision cycle, and
 * start/stop are in-process calls.
 *
 * LIVE-VALIDATION REQUIRED — real gateway + voice I/O. The testable logic
 * (config, consent) lives in its own modules.
 */
export class SessionManager {
  private readonly controls: { eagerness: Eagerness; dmVoiceId: string; pvpEnabled: boolean };
  /** The single per-campaign serialized writer (design doc 0026 §3): every
   *  world-mutating tool call — table loop or side-channel — funnels through
   *  this so concurrent conversations never race shared state. */
  private readonly writeSerializer = new Mutex();
  /** Operator designation (design doc 0024): persisted snowflake + env fallback. */
  private readonly operator: OperatorService;
  private client: Client | null = null;
  private connection: VoiceConnection | null = null;
  private voiceIO: VoiceIO | null = null;
  private session: Session | null = null;
  private loopPromise: Promise<void> | null = null;
  private running = false;
  /** Set during a session: the guild + live presence source, used to resolve a
   *  typed @username and to render the operator picker. */
  private guild: Guild | null = null;
  /** The play voice channel — used to authorize `/skeinkeeper operator` against
   *  the Manage Channel permission scoped to this channel (design doc 0024 §5). */
  private voiceChannel: VoiceBasedChannel | null = null;
  private presenceSource: PresenceSource | null = null;
  private unsubscribeRoster: (() => void) | null = null;
  /** Live voice-routing object; its dmVoiceId is mutated by setDmVoice so a
   *  DM-voice change applies on the next turn without a restart. */
  private routing: {
    dmVoiceId: string;
    getNpcVoice: (key: string) => string | undefined;
    assignNpcVoice: (key: string) => Promise<string>;
  } | null = null;
  /** In-memory intake findings + resolutions for the live session (TDD 0031). */
  private intakeState: IntakeResolutionState = createIntakeResolutionState([]);
  private intakeReadyFlag = true;
  private extendedStarted = false;
  private runState = createSessionRunState();
  private surfaces: SurfaceRouter | null = null;
  private consentSurface: DiscordConsentSurface | null = null;
  private identity = new SideChannelIdentityMap();
  private coordinator: SideChannelCoordinator | null = null;
  private foundryPresence: FoundryPresencePoller | null = null;
  /** Foundry-down session lifecycle (design doc 0039); per-session. */
  private lifecycle: LifecycleController | null = null;
  private heartbeat: FoundryHeartbeat | null = null;
  private goneUnsub: (() => void) | null = null;
  private lifecycleUnsub: (() => void) | null = null;
  private voicePausedInputs = new PausedInputBuffer<BufferFragment>();
  private whisperPausedInputs = new PausedInputBuffer<{ playerId: string; text: string }>();
  /** Rate-limit: one operator pause DM per pause episode (`since` key). */
  private lastPauseDmEpisode: string | null = null;

  constructor(private readonly deps: SessionManagerDeps) {
    this.controls = {
      eagerness: deps.config.eagerness,
      dmVoiceId: deps.config.dmVoiceId,
      // PvP is per-campaign, persisted, default OFF (design doc 0026 §6).
      pvpEnabled: pvpEnabledFromSetting(
        deps.tenantDb.settings.get(deps.campaignId, PVP_SETTING_KEY)?.value,
      ),
    };
    this.operator = new OperatorService(
      deps.tenantDb,
      deps.campaignId,
      deps.config.discord.operatorUserId,
    );
    this.intakeState = createIntakeResolutionState(
      [],
      loadIntakeConfig(deps.tenantDb, deps.campaignId),
    );
  }

  get eagerness(): Eagerness {
    return this.controls.eagerness;
  }
  /** Set eagerness from any surface (console or slash). Emits so the other
   *  surface updates live (design doc 0025). */
  setEagerness(eagerness: Eagerness): void {
    this.controls.eagerness = eagerness;
    this.deps.onEvent?.({ kind: "eagerness", eagerness });
  }
  get pvpEnabled(): boolean {
    return this.controls.pvpEnabled;
  }
  /** Toggle PvP from any surface (console or slash). Persists the per-campaign
   *  setting and emits so the other surface updates live (design docs 0026 §6,
   *  0025 / ADR-0016). Read-at-initiation: a side-channel action already
   *  underway completes under the value in effect when it began. */
  setPvpEnabled(enabled: boolean): void {
    this.controls.pvpEnabled = enabled;
    this.deps.tenantDb.settings.set({
      campaignId: this.deps.campaignId,
      key: PVP_SETTING_KEY,
      value: enabled ? "true" : "false",
      updatedAt: Date.now(),
    });
    this.deps.onEvent?.({ kind: "pvp", enabled });
  }

  getIntakeView(): IntakeView {
    return toIntakeView(this.intakeState);
  }

  /**
   * Single write path for intake finding resolution (TDD 0031).
   * TDD 0040 will add the Foundry chat-command
   * `/skeinkeeper intake resolve <session-finding-id> <option-id>` against
   * this same method. Discord text is consent-only under the surface model.
   */
  async resolveIntakeFinding(findingId: number, optionId: string): Promise<IntakeResolveResult> {
    const foundry = this.session?.config.foundry;
    const result = await applyIntakeResolution(this.intakeState, findingId, optionId, {
      ...(foundry !== undefined
        ? { foundry, onSceneChoice: (sceneId) => activateScene(foundry, sceneId) }
        : {}),
    });
    if (this.session !== null) this.session.config.intake = this.intakeState.intake;
    saveIntakeConfig(this.deps.tenantDb, this.deps.campaignId, this.intakeState.intake);
    if (result.status === "resolved") {
      persistFindingResolution(this.deps.tenantDb, findingId, optionId);
      const row = this.deps.tenantDb.sessionIntakeFindings.get(findingId);
      this.deps.analytics?.track("intake.finding.resolved", {
        campaignId: this.deps.campaignId,
        sessionId: this.session?.config.sessionId ?? "none",
        findingCode: result.finding?.code ?? "unknown",
        resolutionId: optionId,
        latencyMs: row !== undefined ? Math.max(0, Date.now() - row.createdAt) : 0,
      });
    }
    const nowReady = announceReadyAllowed(this.intakeState);
    if (!this.intakeReadyFlag && nowReady) {
      this.intakeReadyFlag = true;
      this.startExtendedIfNeeded();
    }
    this.emitIntakeEvent();
    return result;
  }

  /**
   * Single write path for `/skeinkeeper preflight verify` (TDD 0036).
   * TDD 0040 owns the rest of the Foundry-chat parity table.
   */
  async verifyPreflight(player?: string): Promise<IdentityPreflightResult> {
    const session = this.session;
    if (session === null) {
      return { status: "warnings-only", findings: [{ kind: "bridge-listusers-unavailable" }] };
    }
    const deps = this.intakeDeps();
    const ctx = deps?.ctx ?? {
      campaignId: this.deps.campaignId,
      sessionId: session.config.sessionId,
      sessionConfig: { intake: this.intakeState.intake },
    };
    const result = await executePreflightVerify({
      ctx,
      tenantDb: this.deps.tenantDb,
      foundry: session.config.foundry,
      ...(player !== undefined && player.length > 0 ? { player } : {}),
      emit: async (text) => {
        const operatorId = this.resolveOperatorFoundryUserId();
        await this.surfaces?.emit({
          audience: { kind: "gm" },
          text,
          meta: operatorId !== undefined ? { replyTo: operatorId } : { escalation: false },
        });
      },
      onTelemetry: (name, props) => this.trackIntake(name, props),
    });
    this.bindIdentityFromPersistentMap();
    this.deps.onEvent?.({
      kind: "preflight",
      status: result.status,
      findingCount: result.findings.length,
      criticalCount: result.findings.filter((f) => identityFindingSeverity(f) === "critical")
        .length,
    });
    return result;
  }

  /**
   * Operator commands typed as `/skeinkeeper <verb> <args>` in Foundry chat —
   * the second operator-control surface under ADR-0025 / ADR-0028 (supersedes
   * the Discord-slash surface of ADR-0016). Authorized by the invoker's Foundry
   * GM role; dispatched to the same `SessionManager` write paths as the console
   * (one write path, parity per ADR-0028 / TDD 0040). `consent` is a player
   * self-action and exempt from the GM gate.
   */
  private async handleFoundryCommand(event: {
    verb: string;
    args: ReadonlyArray<string>;
    raw: string;
    foundryUserId: string;
  }): Promise<void> {
    const parsed = parseSkeinkeeperCommand(event.raw);
    // The surface only forwards ok-parsed commands (it answers parse errors
    // inline); this is a defensive guard.
    if (!parsed.ok) return;
    const control = parsed.control;
    if (control.control !== "consent" && !(await this.foundryUserIsGm(event.foundryUserId))) {
      await this.replyToInvoker(
        event.foundryUserId,
        "Unauthorized: /skeinkeeper commands require a GM-role Foundry user.",
      );
      return;
    }
    const ack = await this.dispatchOperatorControl(control, event.foundryUserId);
    if (ack !== undefined) await this.replyToInvoker(event.foundryUserId, ack);
  }

  /** Whether a Foundry user holds a GM-class role (GAMEMASTER/ASSISTANT).
   *  Fails closed if listUsers is unavailable (ADR-0024 silence-is-success). */
  private async foundryUserIsGm(foundryUserId: string): Promise<boolean> {
    const foundry = this.session?.config.foundry;
    if (foundry === undefined) return false;
    try {
      const users = await foundry.listUsers();
      const u = users.find((x) => x.id === foundryUserId);
      return u !== undefined && (u.role === "GAMEMASTER" || u.role === "ASSISTANT");
    } catch {
      this.deps.analytics?.track("error.captured", {
        errorClass: "listusers-unavailable",
        module: "app:operator_command_auth",
      });
      return false;
    }
  }

  /** Inline ack/error whispered to the invoking Foundry user via GM chat. */
  private async replyToInvoker(foundryUserId: string, text: string): Promise<void> {
    try {
      await this.surfaces?.emit({
        audience: { kind: "gm" },
        text,
        meta: { replyTo: foundryUserId },
      });
    } catch {
      // inline ack is best-effort
    }
  }

  /** Dispatch a parsed control to the shared SessionManager write path. Returns
   *  the inline ack text, or undefined when a sub-handler replies itself. */
  private async dispatchOperatorControl(
    control: ConsoleControl,
    invokerFoundryUserId: string,
  ): Promise<string | undefined> {
    switch (control.control) {
      case "session":
        if (control.action === "stop") {
          await this.stop();
          return "Session stopped.";
        }
        if (control.action === "start") {
          return "Session start is console-only at v0.5 (cold-start) — open the operator console.";
        }
        if (control.action === "resume") {
          // Design doc 0039 §4: same SessionManager.resume() write path as the
          // console's Resume button (parity per ADR-0028).
          const result = await this.resume();
          switch (result.kind) {
            case "ok":
              return "Session resumed.";
            case "already-active":
              return "Session is already active — nothing to resume.";
            case "preflight-failed":
              return `Resume blocked: pre-flight found ${result.findings.length} finding(s); see the escalation report.`;
            case "not-running":
              return "No session is running — cold-start from the operator console.";
          }
        }
        // action === "pause": detector-driven only at v0.5 (design doc 0039).
        return "There's no operator-initiated pause — the session pauses itself when Foundry becomes unreachable, and you resume it here or from the console.";
      case "operator-dm-consent":
        this.setOperatorDmConsent(control.enabled);
        return control.enabled
          ? "Pause-notification DMs enabled — you'll get one Discord DM per Foundry-down pause."
          : "Pause-notification DMs disabled.";
      case "eagerness": {
        const level = normalizeEagerness(control.level);
        if (level === undefined) {
          return `Invalid eagerness '${control.level}'. Use reserved, balanced, or eager.`;
        }
        this.setEagerness(level);
        return `Eagerness → ${level}`;
      }
      case "voice":
        if (control.action === "list") {
          return `DM voices:\n${this.listPersonas()
            .map((p) => `• ${p.label} — ${p.description}`)
            .join("\n")}`;
        }
        {
          const r = this.setDmVoiceByPersona(control.persona);
          return r.ok ? `DM voice → ${control.persona}` : (r.error ?? "unknown persona");
        }
      case "operator":
        return this.handleOperatorControlFromFoundry(control.action, invokerFoundryUserId);
      case "pvp":
        this.setPvpEnabled(control.enabled);
        return `PvP → ${control.enabled ? "ON" : "OFF"}`;
      case "intake": {
        const id = Number(control.id);
        if (!Number.isInteger(id) || id <= 0) return `Invalid finding id '${control.id}'.`;
        const result = await this.resolveIntakeFinding(id, control.option);
        return `Intake ${control.id}: ${result.status}`;
      }
      case "preflight": {
        const result = await this.verifyPreflight(control.player);
        return `Pre-flight: ${result.status} (${result.findings.length} finding(s)).`;
      }
      case "map":
        return "Map override isn't available via Foundry chat yet — use the operator console.";
      case "consent":
        return this.handleConsentFromFoundry(control.decision, invokerFoundryUserId);
    }
  }

  /** `/skeinkeeper operator claim|clear|show` — sets the dedicated Foundry user
   *  that receives escalation whispers (TDD 0040 §2). GM-gated by the caller. */
  private handleOperatorControlFromFoundry(
    action: "claim" | "clear" | "show",
    invokerFoundryUserId: string,
  ): string {
    const KEY = "operator.foundry_user_id";
    if (action === "show") {
      const cur = this.deps.tenantDb.settings.get(this.deps.campaignId, KEY)?.value;
      return cur !== undefined && cur.length > 0
        ? `Escalation whispers go to Foundry user ${cur}.`
        : "No operator Foundry user is set; escalations broadcast to GM chat.";
    }
    const value = action === "claim" ? invokerFoundryUserId : "";
    this.deps.tenantDb.settings.set({
      campaignId: this.deps.campaignId,
      key: KEY,
      value,
      updatedAt: Date.now(),
    });
    return action === "claim"
      ? "You'll receive Skeinkeeper escalations as whispers here."
      : "Cleared the operator Foundry user; escalations broadcast to GM chat.";
  }

  /** `/skeinkeeper consent accept|decline` from Foundry chat — a player
   *  self-action. Resolves the invoker's Discord id via the 3-way map. */
  private handleConsentFromFoundry(decision: "accept" | "decline", foundryUserId: string): string {
    const discordId = this.identity.discordIdForFoundryUser(foundryUserId);
    if (discordId === undefined) {
      return "Couldn't match your Foundry user to a Discord identity — grant consent from the Discord prompt.";
    }
    if (decision === "accept") {
      this.deps.consent.grant(discordId);
      return "Voice consent granted — thanks!";
    }
    this.deps.consent.withdraw(discordId);
    return "Voice consent withdrawn.";
  }

  /** Replace the live intake findings after a minimum/extended run. */
  installIntakeFindings(findings: ReadonlyArray<IntakeFinding>, sessionId?: string): void {
    const prior = this.intakeState.intake;
    const sid = sessionId ?? this.session?.config.sessionId ?? "pending";
    const persisted = persistSurfacedFindings(
      this.deps.tenantDb,
      this.deps.campaignId,
      sid,
      findings,
    );
    this.intakeState = createIntakeResolutionState(persisted, prior);
    this.emitIntakeEvent();
  }

  private emitIntakeEvent(): void {
    const view = this.getIntakeView();
    this.deps.onEvent?.({ kind: "intake", ready: view.ready, findings: view.findings });
  }

  private trackIntake(name: string, props?: Record<string, unknown>): void {
    if (this.deps.analytics === undefined || props === undefined) return;
    // Event names are registered in telemetry/src/events.ts (TDD 0031).
    (this.deps.analytics.track as (n: string, p: Record<string, unknown>) => void)(name, props);
  }

  private intakeDeps() {
    const session = this.session;
    if (session === null) return null;
    const expectedPlayers = this.intakeExpectedPlayers();
    const dmFoundryUserId = this.resolvedDmFoundryUserId();
    const operatorFoundryUserId = this.resolveOperatorFoundryUserId();
    return {
      ctx: {
        campaignId: this.deps.campaignId,
        sessionId: session.config.sessionId,
        sessionConfig: { intake: this.intakeState.intake },
        ...(expectedPlayers.length > 0 ? { expectedPlayers } : {}),
        ...(dmFoundryUserId !== undefined ? { dmFoundryUserId } : {}),
        ...(operatorFoundryUserId !== undefined ? { operatorFoundryUserId } : {}),
      },
      foundry: session.config.foundry,
      memory: this.deps.memoryStore,
      tenantDb: this.deps.tenantDb,
      embed: this.deps.providers.embed,
      worldContent: this.deps.foundry.worldContent(),
      runState: this.runState,
      onTelemetry: (name: string, props?: Record<string, unknown>) => this.trackIntake(name, props),
    };
  }

  /** Seated consented roster ∪ persistent 3-way map (TDD 0036 start check). */
  private intakeExpectedPlayers(): Array<{ discordUserId: string; displayName?: string }> {
    const out: Array<{ discordUserId: string; displayName?: string }> = [];
    const seen = new Set<string>();
    for (const row of this.deps.tenantDb.playerCharacterMap.listByCampaign(this.deps.campaignId)) {
      seen.add(row.discordUserId);
      const player: { discordUserId: string; displayName?: string } = {
        discordUserId: row.discordUserId,
      };
      if (row.displayName !== null && row.displayName.length > 0) {
        player.displayName = row.displayName;
      }
      out.push(player);
    }
    for (const member of this.presenceSource?.current() ?? []) {
      if (seen.has(member.id)) continue;
      if (!this.deps.consent.isGranted(member.id)) continue;
      seen.add(member.id);
      const player: { discordUserId: string; displayName?: string } = { discordUserId: member.id };
      if (member.displayName !== undefined) player.displayName = member.displayName;
      out.push(player);
    }
    return out;
  }

  private async runIntakeAtStart(): Promise<void> {
    const deps = this.intakeDeps();
    if (deps === null) return;
    const result = await runSessionStartIntake(deps);
    this.intakeState = result.state;
    this.intakeReadyFlag = result.ready;
    this.emitIntakeEvent();
    if (result.report.text.length > 0) {
      try {
        await this.emitOperatorNote(result.report.text);
      } catch {
        // notify_operator reports undelivered; gate still blocks
      }
    }
    if (result.extended !== undefined) {
      this.extendedStarted = true;
      void result.extended.then((ext) => this.onExtendedDone(ext));
    }
  }

  private startExtendedIfNeeded(): void {
    if (this.extendedStarted) return;
    const deps = this.intakeDeps();
    if (deps === null) return;
    this.extendedStarted = true;
    void kickExtendedIntake(deps).then((ext) => this.onExtendedDone(ext));
  }

  private onExtendedDone(extended: ExtendedIntakeResult): void {
    const session = this.session;
    if (session === null) return;
    const persisted = persistSurfacedFindings(
      this.deps.tenantDb,
      this.deps.campaignId,
      session.config.sessionId,
      extended.findings,
    );
    const merged = [...this.intakeState.findings, ...persisted.filter((f) => f.id !== undefined)];
    this.intakeState = createIntakeResolutionState(merged, this.intakeState.intake);
    this.intakeReadyFlag = announceReadyAllowed(this.intakeState);
    this.emitIntakeEvent();
    const report = formatIntakeReportForOperator(persisted, {
      ...(extended.actions !== undefined ? { actions: extended.actions } : {}),
    });
    if (report.text.length > 0) {
      void this.emitOperatorNote(report.text).catch(() => undefined);
    }
  }

  get dmVoiceId(): string {
    return this.controls.dmVoiceId;
  }
  /**
   * Set the DM voice from any surface (design doc 0025). Mutates the live
   * routing, persists the assignment, and emits so the other surface updates
   * live. The single write path for the DM voice.
   */
  setDmVoice(voiceId: string, personaId?: string): void {
    this.controls.dmVoiceId = voiceId;
    if (this.routing !== null) this.routing.dmVoiceId = voiceId;
    this.deps.tenantDb.voiceAssignments.upsert({
      campaignId: this.deps.campaignId,
      subjectKind: "dm",
      subjectKey: "dm",
      providerVoiceId: voiceId,
      ...(personaId !== undefined ? { personaId } : {}),
      source: "operator",
      assignedAt: Date.now(),
    });
    this.deps.onEvent?.({
      kind: "dmVoice",
      voiceId,
      ...(personaId !== undefined ? { personaId } : {}),
    });
  }
  /** Resolve a persona to its voice and apply it. Returns the outcome so the
   *  caller (console API / slash command) can report success or a bad id. */
  setDmVoiceByPersona(personaId: string): { ok: boolean; voiceId?: string; error?: string } {
    const voiceId = resolveDmPersonaVoice(personaId);
    if (voiceId === undefined) return { ok: false, error: `unknown persona: ${personaId}` };
    this.setDmVoice(voiceId, personaId);
    return { ok: true, voiceId };
  }
  /** The DM voice personas the operator can choose from (console + slash). */
  listPersonas(): ReturnType<typeof dmPersonas> {
    return dmPersonas();
  }
  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      await this.doStart();
    } catch (err) {
      // A partial start (bad channel id, voice-join timeout, Foundry connect
      // failure) must not orphan a logged-in client + open voice connection.
      // Tear down what we built and report stopped, then surface the error.
      await this.cleanupPartialStart();
      this.deps.onEvent?.({ kind: "status", status: "stopped" });
      throw err;
    }
  }

  /** Destroy any half-built client/connection + reset state after a failed
   *  start so a retry begins clean and no logged-in bot is left dangling. */
  private async cleanupPartialStart(): Promise<void> {
    if (this.unsubscribeRoster) this.unsubscribeRoster();
    try {
      this.connection?.destroy();
    } catch {
      // connection may never have reached a destroyable state
    }
    try {
      await this.client?.destroy();
    } catch {
      // client may never have logged in
    }
    this.running = false;
    this.voiceIO = null;
    this.loopPromise = null;
    this.unsubscribeRoster = null;
    this.presenceSource = null;
    this.guild = null;
    this.voiceChannel = null;
    this.client = null;
    this.connection = null;
    this.foundryPresence?.stop();
    this.foundryPresence = null;
    this.coordinator?.stop();
    this.coordinator = null;
    this.surfaces = null;
    this.consentSurface = null;
    this.teardownLifecycle();
  }

  /** Lifecycle state is per-session in-memory (design doc 0039 §Data): a
   *  Skeinkeeper stop/restart discards it; the audit rows are the record. */
  private teardownLifecycle(): void {
    this.heartbeat?.stop();
    this.heartbeat = null;
    this.goneUnsub?.();
    this.goneUnsub = null;
    this.lifecycleUnsub?.();
    this.lifecycleUnsub = null;
    this.lifecycle = null;
    this.lastPauseDmEpisode = null;
    this.voicePausedInputs.drain();
    this.whisperPausedInputs.drain();
  }

  private async doStart(): Promise<void> {
    this.deps.onEvent?.({ kind: "status", status: "starting" });
    const { config, providers } = this.deps;

    // TDD 0041 FR-F6: fail closed before the Discord bot joins voice.
    let foundry;
    try {
      foundry = await this.deps.foundry.connect();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Refusing to Start: Foundry add-on is not connected. ${reason}`);
    }

    // Foundry-down session lifecycle (design doc 0039). The controller fuses
    // add-on `evt gone`, Foundry-surface emit-failure storms, and the periodic
    // heartbeat; only SessionManager.resume() transitions back to active.
    this.voicePausedInputs = new PausedInputBuffer<BufferFragment>();
    this.whisperPausedInputs = new PausedInputBuffer<{ playerId: string; text: string }>();
    this.lastPauseDmEpisode = null;
    const lifecycle = createLifecycleController({
      preflight: () => this.resumePreflight(foundry),
      audit: (eventType, payload) => {
        const sessionId = this.session?.config.sessionId ?? "pending";
        this.deps.tenantDb.auditLog.append({
          sessionId,
          turnId: `${sessionId}-lifecycle-${Date.now()}`,
          actor: "app:lifecycle",
          eventType,
          payloadJson: JSON.stringify(payload),
          timestamp: Date.now(),
        });
      },
      bufferedInputs: () => this.voicePausedInputs.size + this.whisperPausedInputs.size,
      ...(this.deps.analytics !== undefined ? { analytics: this.deps.analytics } : {}),
    });
    this.lifecycle = lifecycle;
    this.lifecycleUnsub = lifecycle.onTransition((next, prev) =>
      this.onLifecycleTransition(next, prev),
    );
    this.goneUnsub =
      this.deps.foundry.onGone?.(() =>
        lifecycle.reportAddonGone("Foundry add-on disconnected (evt gone)"),
      ) ?? null;
    this.heartbeat = startFoundryHeartbeat({ client: foundry, lifecycle });

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        // Consent DMs + the one-time courtesy redirect (TDD 0034).
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // DM channels/messages arrive uncached; partials let the events fire.
      partials: [Partials.Channel, Partials.Message],
    });
    this.client = client;
    this.registerConsentOnlyDms(client);
    const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
    await client.login(config.discord.botToken);
    await ready;

    const channel = await client.channels.fetch(config.discord.voiceChannelId);
    if (!channel || !channel.isVoiceBased()) {
      throw new Error(`channel ${config.discord.voiceChannelId} is not a voice channel`);
    }
    const guild = channel.guild;
    this.guild = guild;
    this.voiceChannel = channel;
    await this.registerSlashCommands(guild.id);
    this.registerInteractions(client);

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection = connection;
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    // Voice-channel roster for the onboarding ritual (design doc 0023). The
    // app owns the gateway client, so it supplies presence (the transport stays
    // gateway-free). Excludes the bot + other bots.
    const botId = client.user?.id;
    const currentMembers = (): PresenceMember[] =>
      [...channel.members.values()]
        .filter((m) => !m.user.bot && m.id !== botId)
        .map((m) => ({ id: m.id, displayName: m.displayName }));
    const presence: PresenceSource = {
      current: currentMembers,
      subscribe: (onChange) => {
        const handler = (oldState: VoiceState, newState: VoiceState): void => {
          if (oldState.channelId === channel.id || newState.channelId === channel.id) {
            onChange(currentMembers());
          }
        };
        client.on(Events.VoiceStateUpdate, handler);
        return () => client.off(Events.VoiceStateUpdate, handler);
      },
    };
    this.presenceSource = presence;

    const base = new DiscordVoiceIO({
      connection,
      stt: providers.stt,
      tts: providers.tts,
      isConsented: (id) => this.deps.consent.isGranted(id),
      resolveDisplayName: (id) => guild.members.cache.get(id)?.displayName,
      language: "en",
      presence,
    });
    // Wrap so consent prompts are delivered as Discord DMs (the transport
    // itself doesn't own the gateway client).
    const voiceIO: VoiceIO = {
      name: "discord-operator",
      listen: () => base.listen(),
      speak: (text, opts) => base.speak(text, opts),
      close: () => base.close(),
      requestConsent: async (subjectId, consentText) => {
        this.deps.onEvent?.({ kind: "consent_prompt", speaker: subjectId });
        try {
          const user = await client.users.fetch(subjectId);
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(CONSENT_CUSTOM_ID.grant)
              .setLabel("Grant voice consent")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(CONSENT_CUSTOM_ID.withdraw)
              .setLabel("Withdraw")
              .setStyle(ButtonStyle.Secondary),
          );
          await user.send({ content: consentText, components: [row] });
        } catch {
          // DM may be closed; the player can still use /skeinkeeper consent.
        }
      },
    };
    this.voiceIO = voiceIO;

    const registry = createDefaultRegistry();
    // System-scoped mechanical-write tools (TDD 0042) register once the
    // connected world's system is known; dnd5e is the validated system.
    registerFoundrySystemTools(registry, foundry.system);
    const dispatcher = new ToolDispatcher({
      registry,
      // Single serialized writer so the table loop and side-channel turns never
      // race shared world-state (design doc 0026 §3).
      writeSerializer: this.writeSerializer,
      // Design doc 0039: no tool dispatches while paused-foundry-down.
      lifecycle,
      ...(this.deps.analytics !== undefined ? { analytics: this.deps.analytics } : {}),
    });
    const behaviorSpec = loadBehaviorSpec(findDefaultBehaviorSpec(import.meta.dirname));
    const routing = {
      dmVoiceId: this.controls.dmVoiceId,
      getNpcVoice: (key: string) =>
        this.deps.tenantDb.voiceAssignments.get(this.deps.campaignId, "npc", key)?.providerVoiceId,
      assignNpcVoice: async (key: string) => {
        const voices = await providers.voiceLibrary.list();
        const a = await assignNpcVoiceLLM(providers.llm, {
          npcKey: key,
          npcDescription: key,
          library: voices,
        });
        this.deps.tenantDb.voiceAssignments.upsert({
          campaignId: this.deps.campaignId,
          subjectKind: "npc",
          subjectKey: key,
          providerVoiceId: a.providerVoiceId,
          source: "ai",
          assignedAt: Date.now(),
        });
        return a.providerVoiceId;
      },
    };
    this.routing = routing;
    this.bindIdentityFromPersistentMap();
    const surfaces = this.buildSurfaceRouter(foundry, voiceIO, client, routing, lifecycle);
    this.surfaces = surfaces;
    // Operator escalations land in Foundry GM chat (TDD 0034). The router
    // fans `gm` + escalation to GM chat and, when known, a whisper.
    this.session = startSession({
      sessionId: `sess-${Date.now()}`,
      campaignId: this.deps.campaignId,
      behaviorSpec,
      llm: providers.llm,
      dispatcher,
      foundry,
      tenantDb: this.deps.tenantDb,
      eagerness: this.controls.eagerness,
      memory: { embed: providers.embed, store: this.deps.memoryStore },
      notifyOperator: (message) => this.emitOperatorNote(message),
      intake: this.intakeState.intake,
      runState: this.runState,
      foundryEvents: new NullFoundryEventStream(),
      perceptionKind: "null",
      isPlayerConsented: (id) => this.deps.consent.isGranted(id),
      notifyTable: async (text) => {
        await surfaces.emit({ audience: { kind: "table" }, text });
      },
      whisperPlayer: async (playerId, text) => {
        await surfaces.emit({ audience: { kind: "player", playerId }, text });
      },
      surfaces,
      identity: this.identity,
      onOperatorEscalation: (event) => {
        if (this.resolveOperatorFoundryUserId() === undefined) {
          this.deps.onEvent?.({ kind: "operatorEscalation", ...event });
        }
      },
      operatorFoundryUserKnown: () => this.resolveOperatorFoundryUserId() !== undefined,
      ...(this.deps.analytics !== undefined ? { analytics: this.deps.analytics } : {}),
    });
    this.coordinator = new SideChannelCoordinator({
      session: this.session,
      router: surfaces,
      identity: this.identity,
      onOperatorCommand: (event) => this.handleFoundryCommand(event),
      // Design doc 0039: whisper turns buffer while paused; commands still flow
      // so `/skeinkeeper session action:resume` works once the add-on is back.
      lifecycle,
      pausedInputs: this.whisperPausedInputs,
    });
    void this.coordinator.start();
    // Pause/resume TTS announcements: one-shot generation + pre-render, cached
    // on the run state so pause-time needs no LLM call (design doc 0039). Off
    // the Start critical path; the defaults cover a pause that beats it.
    void prepareLifecycleAnnouncements({
      llm: providers.llm,
      tts: providers.tts,
      config: this.session.config,
      voiceId: this.controls.dmVoiceId,
    })
      .then((announcements) => {
        this.runState.lifecycleAnnouncements = announcements;
      })
      .catch(() => undefined);
    await this.runIntakeAtStart();
    this.startFoundryPresenceWatch(foundry);

    // Resolve a username typed before the bot was online (design doc 0024 §1),
    // and surface the initial operator + voice roster to the console.
    await this.resolvePendingOperator();
    this.emitOperatorEvent();
    const emitRoster = (members: ReadonlyArray<PresenceMember>): void => this.emitRoster(members);
    emitRoster(presence.current());
    this.unsubscribeRoster = presence.subscribe(emitRoster);

    this.running = true;
    this.session.releasePerception();
    this.deps.onEvent?.({ kind: "status", status: "running" });

    this.loopPromise = runAlwaysListeningSession({
      voiceIO,
      session: this.session,
      consentText: VOICE_CONSENT_TEXT,
      // Design doc 0039: gate the loop + buffer utterances across a pause.
      lifecycle,
      pausedInputs: this.voicePausedInputs,
      getEagerness: () => this.controls.eagerness,
      isConsented: (id) => this.deps.consent.isGranted(id),
      intakeReady: () => this.intakeReadyFlag,
      identityPreflight: {
        verifyPlayer: (player) => this.verifyVoiceJoinIdentity(player),
        onCriticalGap: (player) => this.onVoiceJoinIdentityGap(player),
        onWarning: (player) => this.onVoiceJoinIdentityWarning(player),
      },
      voiceRouting: this.routing,
      onDecision: (d, frags) =>
        this.deps.onEvent?.({
          kind: "decision",
          respond: d.respond,
          reason: d.reason,
          heard: frags.map((f) => f.text).join(" | "),
        }),
      onTurn: (turn) =>
        this.deps.onEvent?.({
          kind: "turn",
          narration: turn.narration,
          tools: turn.toolCalls.map((t) => t.name),
        }),
    })
      .catch(() => undefined)
      .then(() => {
        this.running = false;
      });
  }

  async stop(): Promise<void> {
    if (this.voiceIO === null && this.loopPromise === null) return;
    if (this.unsubscribeRoster) this.unsubscribeRoster();
    await this.voiceIO?.close();
    await this.loopPromise?.catch(() => undefined);
    if (this.session !== null) {
      await archiveSession(this.session);
      endSession(this.session);
    }
    await this.deps.foundry.close();
    this.connection?.destroy();
    await this.client?.destroy();
    this.running = false;
    this.voiceIO = null;
    this.loopPromise = null;
    this.unsubscribeRoster = null;
    this.presenceSource = null;
    this.guild = null;
    this.voiceChannel = null;
    this.foundryPresence?.stop();
    this.foundryPresence = null;
    this.coordinator?.stop();
    this.coordinator = null;
    this.surfaces = null;
    this.consentSurface = null;
    this.teardownLifecycle();
    this.extendedStarted = false;
    this.intakeReadyFlag = true;
    this.runState = createSessionRunState();
    this.deps.onEvent?.({ kind: "status", status: "stopped" });
  }

  // ---- Foundry-down session lifecycle (design doc 0039) ----

  /** Current lifecycle state, or null when no session is running. */
  lifecycleState(): SessionLifecycleState | null {
    return this.lifecycle?.current() ?? null;
  }

  /**
   * Single write path for operator resume (design doc 0039 §4): the web
   * console's Resume button and `/skeinkeeper session action:resume` both land
   * here (parity per ADR-0028). Re-runs the pre-flight verifier; on critical
   * gaps the state stays paused and the findings surface to the operator.
   */
  async resume(): Promise<ResumeResult | { kind: "not-running" }> {
    const lifecycle = this.lifecycle;
    if (lifecycle === null) return { kind: "not-running" };
    const result = await lifecycle.requestResume();
    if (result.kind === "preflight-failed") {
      const report = formatIdentityPreflightReport({
        status: "critical-gaps",
        findings: result.findings,
      });
      const message = `Resume blocked — Foundry pre-flight failed.\n${report}`;
      // Console always sees it (SSE); Foundry GM chat sees it if chat is back
      // (a still-down Foundry short-circuits the emit to a no-op).
      this.deps.onEvent?.({ kind: "operatorEscalation", message, severity: "warning" });
      void this.surfaces
        ?.emit({ audience: { kind: "gm" }, text: message, meta: { escalation: true } })
        .catch(() => undefined);
    }
    return result;
  }

  /** Operator DM-consent for pause notifications (design doc 0039 step 9) —
   *  single write path; both surfaces call this. */
  setOperatorDmConsent(consented: boolean): void {
    this.operator.setDmConsent(consented);
    this.deps.onEvent?.({ kind: "operatorDmConsent", consented });
  }

  get operatorDmConsented(): boolean {
    return this.operator.dmConsentedAt() !== undefined;
  }

  private onLifecycleTransition(next: SessionLifecycleState, prev: SessionLifecycleState): void {
    if (next.kind === "paused-foundry-down") {
      this.deps.onEvent?.({
        kind: "lifecycleStateChanged",
        state: "paused-foundry-down",
        cause: next.cause,
        since: next.since,
      });
      // One TTS announce per pause episode; bypasses the input buffer (it's
      // TTS-only, not a turn). notify_operator is NOT used — it writes to the
      // very surface that's down; the DM below is the out-of-band signal.
      void this.speakLifecycleAnnouncement("pauseFoundryDown");
      void this.sendOperatorPauseDm(next);
      return;
    }
    if (prev.kind === "paused-foundry-down") {
      this.deps.onEvent?.({ kind: "lifecycleStateChanged", state: "active" });
      void this.speakLifecycleAnnouncement("resumeOk");
    }
  }

  /** Speak the cached announcement text (the only thing TTS'd at pause-time —
   *  no LLM call; design doc 0039 §3 step 3). */
  private async speakLifecycleAnnouncement(which: "pauseFoundryDown" | "resumeOk"): Promise<void> {
    const cached = this.runState.lifecycleAnnouncements?.[which];
    const text =
      cached?.text ??
      (which === "pauseFoundryDown" ? DEFAULT_PAUSE_ANNOUNCEMENT : DEFAULT_RESUME_ANNOUNCEMENT);
    try {
      await this.voiceIO?.speak(text, { voiceId: this.controls.dmVoiceId });
    } catch {
      // Voice may be down too (concurrent outage): logged path only —
      // nothing else to do (design doc 0039 §Failure modes).
      console.warn(`[lifecycle] ${which} announcement failed to play`);
    }
  }

  /** One Discord DM per pause episode, gated on operator DM-consent — the
   *  second narrow exception to "Discord DM = one-time consent only". */
  private async sendOperatorPauseDm(state: SessionLifecycleState): Promise<void> {
    const decision = shouldSendPauseDm({
      state,
      operatorUserId: this.operator.get(),
      dmConsented: this.operator.dmConsentedAt() !== undefined,
      lastNotifiedEpisode: this.lastPauseDmEpisode,
    });
    if (!decision.send) return;
    this.lastPauseDmEpisode = decision.episode;
    const operatorId = this.operator.get();
    if (operatorId === undefined || this.client === null) return;
    try {
      const user = await this.client.users.fetch(operatorId);
      await user.send({ content: formatPauseDm(state) });
    } catch {
      // DM is best-effort; the console escalation pane still carries the pause.
    }
  }

  /** Resume-side pre-flight (TDD 0036 §3a re-run; design doc 0039 §4 step 1). */
  private async resumePreflight(foundry: FoundryClient): Promise<LifecyclePreflightOutcome> {
    const deps = this.intakeDeps();
    const ctx = deps?.ctx ?? {
      campaignId: this.deps.campaignId,
      sessionId: this.session?.config.sessionId ?? "pending",
      sessionConfig: { intake: this.intakeState.intake },
    };
    return runResumePreflight({
      foundry,
      tenantDb: this.deps.tenantDb,
      ctx,
      onTelemetry: (name, props) => this.trackIntake(name, props),
    });
  }

  // ---- operator designation (design doc 0024) ----

  /**
   * Handle `/skeinkeeper operator claim|clear|show` (design doc 0024 §5).
   * `claim`/`clear` mutate the designation, so they're gated behind the Manage
   * Channel permission on the play voice channel — preventing any guild member
   * from hijacking or clearing who receives setup DMs. `show` is read-only.
   */
  private async handleOperatorSlash(
    interaction: ChatInputCommandInteraction,
    action: string | null,
  ): Promise<void> {
    if (
      operatorActionIsPrivileged(action) &&
      !(await this.memberCanManageVoice(interaction.user.id))
    ) {
      await reply(
        interaction,
        "You need the **Manage Channel** permission on the Skeinkeeper voice channel to change the operator.",
      );
      return;
    }
    if (action === "claim") {
      this.setOperator(interaction.user.id);
      await reply(
        interaction,
        "✅ You're now the Skeinkeeper operator — I'll DM you setup notes here.",
      );
    } else if (action === "clear") {
      this.clearOperator();
      await reply(interaction, "Operator cleared.");
    } else if (action === "show") {
      const id = this.operatorUserId;
      await reply(
        interaction,
        id !== undefined ? `Current operator: <@${id}>` : "No operator is set.",
      );
    } else {
      await reply(interaction, "Use action: claim, clear, or show.");
    }
  }

  /** Toggle PvP from the slash surface — operator-gated (Manage Channel),
   *  since it controls whether players can act against each other (design doc
   *  0026 §6). Mirrors the console toggle via the same setPvpEnabled write. */
  private async handlePvpSlash(
    interaction: ChatInputCommandInteraction,
    enabled: boolean,
  ): Promise<void> {
    if (!(await this.memberCanManageVoice(interaction.user.id))) {
      await reply(
        interaction,
        "You need the **Manage Channel** permission on the Skeinkeeper voice channel to change PvP.",
      );
      return;
    }
    this.setPvpEnabled(enabled);
    await reply(interaction, `PvP → ${enabled ? "ON" : "OFF"}`);
  }

  /** Whether a user holds Manage Channel on the play voice channel (admins
   *  pass via Discord's admin override). Best-effort; false if unresolved. */
  private async memberCanManageVoice(userId: string): Promise<boolean> {
    if (this.guild === null || this.voiceChannel === null) return false;
    try {
      const member = await this.guild.members.fetch(userId);
      return (
        this.voiceChannel.permissionsFor(member)?.has(PermissionFlagsBits.ManageChannels) ?? false
      );
    } catch {
      return false;
    }
  }

  /** The effective operator snowflake (persisted, else env fallback). */
  get operatorUserId(): string | undefined {
    return this.operator.get();
  }

  /** A friendly name for the operator, if resolvable from the guild cache. */
  operatorDisplayName(): string | undefined {
    const id = this.operator.get();
    if (id === undefined) return undefined;
    return this.guild?.members.cache.get(id)?.displayName;
  }

  /** Current voice-channel roster for the console picker (operator flagged). */
  currentRoster(): ReadonlyArray<{ id: string; displayName?: string; isOperator: boolean }> {
    const op = this.operator.get();
    return (this.presenceSource?.current() ?? []).map((m) => ({
      id: m.id,
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      isOperator: m.id === op,
    }));
  }

  /** Designate the operator by Discord snowflake (picker / slash command). */
  setOperator(discordUserId: string): void {
    this.operator.set(discordUserId);
    this.afterOperatorChange();
  }

  /** Remove the persisted designation (falls back to the env var). */
  clearOperator(): void {
    this.operator.clear();
    this.afterOperatorChange();
  }

  /**
   * Designate the operator by typed @username (design doc 0024 §1). Resolves
   * against the guild when a session is running; otherwise stores it pending to
   * resolve at the next session start.
   */
  async setOperatorByUsername(
    username: string,
  ): Promise<{ ok: boolean; pending?: boolean; reason?: string; displayName?: string }> {
    if (this.guild === null) {
      this.operator.setPendingUsername(username);
      return { ok: true, pending: true };
    }
    const members = await this.fetchResolvableMembers(username);
    const r = resolveOperatorFromMembers(members, username);
    if (r.kind === "match") {
      this.setOperator(r.id);
      return r.displayName !== undefined ? { ok: true, displayName: r.displayName } : { ok: true };
    }
    if (r.kind === "ambiguous") {
      return { ok: false, reason: `"${username}" matches more than one member — use the picker.` };
    }
    return {
      ok: false,
      reason: `Couldn't find "${username}". Use the picker, or /skeinkeeper operator claim in Discord.`,
    };
  }

  /** Fetch guild members matching a query (best-effort; needs a live client). */
  private async fetchResolvableMembers(
    query: string,
  ): Promise<ReadonlyArray<{ id: string; username?: string; displayName?: string }>> {
    if (this.guild === null) return [];
    try {
      const fetched = await this.guild.members.fetch({ query: query.replace(/^@/, ""), limit: 10 });
      return [...fetched.values()].map((m) => ({
        id: m.id,
        username: m.user.username,
        displayName: m.displayName,
      }));
    } catch {
      // Search may need the privileged Server Members intent; fall back to cache.
      return [...this.guild.members.cache.values()].map((m) => ({
        id: m.id,
        username: m.user.username,
        displayName: m.displayName,
      }));
    }
  }

  /** Resolve a pending username (typed before the bot was online) at start. */
  private async resolvePendingOperator(): Promise<void> {
    const pending = this.operator.getPendingUsername();
    if (pending === undefined || this.guild === null) return;
    const members = await this.fetchResolvableMembers(pending);
    const r = resolveOperatorFromMembers(members, pending);
    if (r.kind === "match") this.operator.set(r.id); // set() clears the pending key
    // If unresolved, leave it pending to retry next start.
  }

  private afterOperatorChange(): void {
    this.emitOperatorEvent();
    if (this.presenceSource !== null) this.emitRoster(this.presenceSource.current());
  }

  private emitOperatorEvent(): void {
    const operatorUserId = this.operator.get();
    const displayName = this.operatorDisplayName();
    this.deps.onEvent?.({
      kind: "operator",
      ...(operatorUserId !== undefined ? { operatorUserId } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    });
  }

  private emitRoster(members: ReadonlyArray<PresenceMember>): void {
    const op = this.operator.get();
    this.deps.onEvent?.({
      kind: "roster",
      members: members.map((m) => ({
        id: m.id,
        ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
        isOperator: m.id === op,
      })),
    });
  }

  private buildSurfaceRouter(
    foundry: FoundryClient,
    voiceIO: VoiceIO,
    client: Client,
    voiceRouting: NonNullable<SessionManager["routing"]>,
    lifecycle: LifecycleController,
  ): SurfaceRouter {
    // Only Foundry-side surfaces feed the Foundry-down detector (design doc
    // 0039 §2b); a Discord voice/consent hiccup says nothing about Foundry.
    const foundrySurfaces = new Set(["foundry-public", "foundry-whisper", "foundry-gm"]);
    const router = new SurfaceRouter({
      ...(this.deps.analytics !== undefined ? { analytics: this.deps.analytics } : {}),
      hashPlayerId: (id) => this.deps.tenantDb.piiCrypto.hash(id),
      onEmitResult: (surface, status, reason) => {
        if (!foundrySurfaces.has(surface)) return;
        if (status === "ok") lifecycle.reportEmitSuccess(surface);
        else lifecycle.reportEmitFailure(surface, reason ?? "emit failed");
      },
    });
    const consent = new DiscordConsentSurface({
      sendDm: async (discordId, text) => {
        const user = await client.users.fetch(discordId);
        await user.send({ content: text });
      },
    });
    this.consentSurface = consent;
    const gm = new FoundryGmChatSurface({
      client: foundry,
      operatorFoundryUserId: () => this.resolveOperatorFoundryUserId(),
      lifecycle,
    });
    router.register(new DiscordVoiceSurface(voiceIO, voiceRouting));
    router.register(consent);
    router.register(new FoundryPublicChatSurface({ client: foundry, lifecycle }));
    router.register(
      new FoundryWhisperSurface({
        client: foundry,
        resolveFoundryUserId: (id) => this.identity.foundryUserIdForDiscord(id),
        lifecycle,
      }),
    );
    router.register(gm);
    router.register(
      new FoundryChatCommandSurface({
        client: foundry,
        reply: gm,
        ...(this.deps.analytics !== undefined ? { analytics: this.deps.analytics } : {}),
      }),
    );
    return router;
  }

  /**
   * Operator notes via Foundry GM chat (TDD 0034). Logs and throws when the
   * emit has no successful surface so notify_operator reports undelivered.
   */
  private async emitOperatorNote(message: string): Promise<void> {
    const router = this.surfaces;
    if (router === null) {
      console.warn(`[operator note — no surface router] ${message}`);
      throw new Error("no operator surface");
    }
    const report = await router.emit({
      audience: { kind: "gm" },
      text: message,
      meta: { escalation: true },
    });
    if (this.resolveOperatorFoundryUserId() === undefined) {
      this.deps.onEvent?.({ kind: "operatorEscalation", message, severity: "info" });
    }
    if (report.perSurface.every((p) => p.status === "failed")) {
      console.warn(`[operator note — emit failed] ${message}`);
      throw new Error(report.perSurface[0]?.error ?? "surface emit failed");
    }
  }

  /** Dedicated GM Foundry user for escalation whispers — never the player map. */
  resolveOperatorFoundryUserId(): string | undefined {
    const dedicated = this.deps.tenantDb.settings.get(
      this.deps.campaignId,
      "operator.foundry_user_id",
    )?.value;
    const discordId = this.operator.get();
    const mapped =
      discordId !== undefined ? this.identity.foundryUserIdForDiscord(discordId) : undefined;
    return pickOperatorFoundryUserId({
      // An empty stored value means "cleared" — treat it as absent so the
      // escalation path falls back to GM-broadcast rather than whispering "".
      ...(dedicated !== undefined && dedicated.length > 0
        ? { dedicatedOperatorFoundryUserId: dedicated }
        : {}),
      ...(mapped !== undefined ? { mappedOperatorFoundryUserId: mapped } : {}),
    });
  }

  /** Same DM identity at Start and voice-join; persist the resolved campaign setting. */
  resolvedDmFoundryUserId(): string | undefined {
    const campaignDm = this.deps.tenantDb.settings.get(
      this.deps.campaignId,
      "campaign.dm_foundry_user_id",
    )?.value;
    const dedicated = this.deps.tenantDb.settings.get(
      this.deps.campaignId,
      "operator.foundry_user_id",
    )?.value;
    const picked = pickDmFoundryUserId({
      ...(campaignDm !== undefined && campaignDm.length > 0
        ? { campaignDmFoundryUserId: campaignDm }
        : {}),
      ...(dedicated !== undefined && dedicated.length > 0
        ? { dedicatedOperatorFoundryUserId: dedicated }
        : {}),
    });
    if (picked !== undefined && campaignDm === undefined) {
      this.deps.tenantDb.settings.set({
        campaignId: this.deps.campaignId,
        key: "campaign.dm_foundry_user_id",
        value: picked,
        updatedAt: Date.now(),
      });
    }
    return picked;
  }

  private async verifyVoiceJoinIdentity(player: {
    discordUserId: string;
    displayName?: string;
  }): Promise<"ok" | "critical-gaps" | "warnings-only"> {
    const session = this.session;
    if (session === null) return "ok";
    const dmFoundryUserId = this.resolvedDmFoundryUserId();
    const operatorFoundryUserId = this.resolveOperatorFoundryUserId();
    const { result } = await runIdentityPreflight({
      ctx: {
        campaignId: this.deps.campaignId,
        sessionId: session.config.sessionId,
        sessionConfig: { intake: this.intakeState.intake },
        expectedPlayers: [player],
        ...(dmFoundryUserId !== undefined ? { dmFoundryUserId } : {}),
        ...(operatorFoundryUserId !== undefined ? { operatorFoundryUserId } : {}),
      },
      tenantDb: this.deps.tenantDb,
      foundry: session.config.foundry,
      trigger: "voice-join",
      expectedPlayers: [player],
      onTelemetry: (name, props) => this.trackIntake(name, props),
    });
    return result.status;
  }

  private async onVoiceJoinIdentityGap(player: {
    discordUserId: string;
    displayName?: string;
  }): Promise<void> {
    const name = player.displayName ?? player.discordUserId;
    try {
      await this.consentSurface?.sendIdentityCourtesy(player.discordUserId);
    } catch {
      // courtesy DM is best-effort
    }
    const mention = player.displayName ?? player.discordUserId;
    try {
      await this.emitOperatorNote(
        `Player ${name} joined voice; their Foundry user / actor ownership isn't configured — please add and \`/skeinkeeper preflight verify @${mention}\`.`,
      );
    } catch {
      // escalation undelivered; player still stays off the onboarding set
    }
  }

  private async onVoiceJoinIdentityWarning(player: {
    discordUserId: string;
    displayName?: string;
  }): Promise<void> {
    const name = player.displayName ?? player.discordUserId;
    try {
      await this.emitOperatorNote(
        `Identity pre-flight warning for ${name} — they can play; check Foundry user / ownership when you can.`,
      );
    } catch {
      // warning undelivered; onboarding still proceeds
    }
  }

  private startFoundryPresenceWatch(foundry: FoundryClient): void {
    this.foundryPresence?.stop();
    this.foundryPresence = startFoundryPresencePoll({
      listUsers: () => foundry.listUsers(),
      mappedFoundryUserIds: () => {
        const ids = new Set<string>();
        for (const row of this.deps.tenantDb.playerCharacterMap.listByCampaign(
          this.deps.campaignId,
        )) {
          if (row.foundryUserId !== null && row.foundryUserId.length > 0) {
            ids.add(row.foundryUserId);
          }
        }
        return ids;
      },
      onTransition: (transition) => {
        const hashed = this.deps.tenantDb.piiCrypto.hash(transition.foundryUserId);
        this.deps.analytics?.track(
          transition.kind === "dropped" ? "presence.foundry.dropped" : "presence.foundry.restored",
          { foundryUserIdHashed: hashed },
        );
        if (transition.kind === "dropped") {
          void this.emitOperatorNote(
            `Foundry user ${transition.foundryUserId} went inactive. Voice continues; their table-text mirror will catch up when they reconnect.`,
          ).catch(() => undefined);
        }
      },
    });
    void this.foundryPresence.tick();
  }

  /** Load TDD 0035's ephemeral map from the persistent 3-way rows. */
  bindIdentityFromPersistentMap(): void {
    const rows = this.deps.tenantDb.playerCharacterMap.listByCampaign(this.deps.campaignId);
    for (const row of rows) {
      if (row.foundryUserId !== null && row.foundryUserId.length > 0) {
        this.identity.bind(row.discordUserId, row.foundryUserId);
      }
    }
  }

  /**
   * Discord DMs after the surface narrowing: consent buttons stay on the
   * interaction path; free-text DMs get a one-time courtesy redirect.
   * Nothing here dispatches a side-channel turn (TDD 0035).
   */
  private registerConsentOnlyDms(client: Client): void {
    client.on(Events.MessageCreate, (message) => {
      void this.handleConsentOnlyDm(message);
    });
  }

  private async handleConsentOnlyDm(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.guildId !== null) return;
    if (message.content.trim().length === 0) return;
    if (!this.running) return;
    const authorId = message.author.id;
    if (!this.isTableParticipant(authorId)) return;
    try {
      await this.consentSurface?.handleNonConsentDm(authorId);
    } catch {
      // courtesy reply is best-effort
    }
  }

  /** Whether a DM author is an actual participant at the table — present in the
   *  voice channel now, or already mapped to a character this campaign. */
  private isTableParticipant(userId: string): boolean {
    const present = this.presenceSource?.current().some((m) => m.id === userId) ?? false;
    if (present) return true;
    return (
      this.deps.tenantDb.playerCharacterMap.currentForPlayer(this.deps.campaignId, userId) !==
      undefined
    );
  }

  private async registerSlashCommands(guildId: string): Promise<void> {
    try {
      const guild = await this.client?.guilds.fetch(guildId);
      // Discord is voice + one-time consent ONLY (ADR-0025 surface model).
      // Operator controls moved to Foundry chat commands (ADR-0028 / TDD 0040)
      // and the web console. Registering only `consent` replaces any previously
      // registered operator subcommands, so they disappear from Discord's UI on
      // the next start. `/skeinkeeper consent` is a player self-action, exempt
      // from operator-control parity.
      await guild?.commands.set([
        {
          name: "skeinkeeper",
          description: "Skeinkeeper — voice consent",
          options: [
            {
              type: 1, // SUB_COMMAND
              name: "consent",
              description: "Grant or withdraw voice-processing consent",
              options: [
                { type: 3, name: "action", description: "grant or withdraw", required: true },
              ],
            },
          ],
        },
      ]);
    } catch {
      // Command registration is best-effort; operator can register manually.
    }
  }

  private registerInteractions(client: Client): void {
    client.on(Events.InteractionCreate, (interaction) => {
      // One-click consent buttons from the DM prompt (primary path).
      if (interaction.isButton()) {
        const intent = consentButtonIntent(interaction.customId);
        if (intent === "grant") {
          this.deps.consent.grant(interaction.user.id);
          void reply(interaction, "✅ Voice consent granted — thanks!");
        } else if (intent === "withdraw") {
          this.deps.consent.withdraw(interaction.user.id);
          void reply(interaction, "Voice consent withdrawn.");
        }
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "skeinkeeper") return;

      const cmd = parseSlashCommand({
        sub: interaction.options.getSubcommand(false),
        action: interaction.options.getString("action"),
        level: interaction.options.getString("level"),
        persona: interaction.options.getString("persona"),
      });
      this.executeSlashCommand(interaction, cmd);
    });
  }

  /** Execute the parsed slash command (the side-effecting half; routing +
   *  validation live in the pure parseSlashCommand). Operator controls mirror
   *  the console via the same manager methods + AppEvent bus (design doc 0025). */
  private executeSlashCommand(interaction: ChatInputCommandInteraction, cmd: SlashCommand): void {
    // Operator controls moved to Foundry chat commands + the web console
    // (ADR-0025 / ADR-0028; TDD 0040). Discord now carries only the player
    // consent self-action. If a stale operator subcommand still fires (one a
    // pre-migration boot registered, before registerSlashCommands narrowed the
    // set), redirect the operator to the current surfaces rather than acting.
    if (!cmd.kind.startsWith("consent")) {
      void reply(
        interaction,
        "Operator controls moved to Foundry chat (`/skeinkeeper …`) and the web console. Discord is voice + consent only now.",
      );
      return;
    }
    switch (cmd.kind) {
      case "operator":
        void this.handleOperatorSlash(interaction, cmd.action);
        return;
      case "session.stop":
        void reply(interaction, "Stopping the session…").then(() => this.stop());
        return;
      case "session.start_blocked":
        void reply(
          interaction,
          "A session is already running (the bot must be online to take this command). Cold-start from the operator console.",
        );
        return;
      case "eagerness.set":
        this.setEagerness(cmd.level);
        void reply(interaction, `Eagerness → ${cmd.level}`);
        return;
      case "eagerness.usage":
        void reply(interaction, "Use level: reserved, balanced, or eager.");
        return;
      case "voice.list":
        void reply(
          interaction,
          `DM voices:\n${this.listPersonas()
            .map((p) => `• **${p.label}** — ${p.description}`)
            .join("\n")}`,
        );
        return;
      case "voice.set": {
        const r = this.setDmVoiceByPersona(cmd.personaId);
        void reply(
          interaction,
          r.ok ? `DM voice → ${cmd.personaId}` : (r.error ?? "unknown persona"),
        );
        return;
      }
      case "voice.set_missing":
        void reply(interaction, "Choose a persona to set.");
        return;
      case "voice.usage":
        void reply(interaction, "Use action: list or set.");
        return;
      case "pvp.set":
        void this.handlePvpSlash(interaction, cmd.enabled);
        return;
      case "pvp.show":
        void reply(interaction, `PvP is currently ${this.pvpEnabled ? "ON" : "OFF"}.`);
        return;
      case "pvp.usage":
        void reply(interaction, "Use action: on, off, or show.");
        return;
      case "consent.grant":
        this.deps.consent.grant(interaction.user.id);
        void reply(interaction, "✅ Voice consent granted — thanks!");
        return;
      case "consent.withdraw":
        this.deps.consent.withdraw(interaction.user.id);
        void reply(interaction, "Voice consent withdrawn.");
        return;
      case "consent.usage":
        void reply(interaction, "Use action: grant or withdraw.");
        return;
    }
  }
}

/** Accept both the console idiom (reserved/balanced/eager) and the low/medium/high
 *  aliases the Foundry command parser allows; return the canonical Eagerness. */
function normalizeEagerness(level: string): Eagerness | undefined {
  const mapped =
    level === "low"
      ? "reserved"
      : level === "medium"
        ? "balanced"
        : level === "high"
          ? "eager"
          : level;
  return isEagerness(mapped) ? (mapped as Eagerness) : undefined;
}

function toIntakeView(state: IntakeResolutionState): IntakeView {
  return {
    ready: announceReadyAllowed(state),
    findings: state.findings
      .filter((f): f is IntakeFinding & { id: number } => f.id !== undefined)
      .map((f) => ({
        id: f.id,
        code: f.code,
        kind: f.kind,
        summary: f.summary,
        ...(f.detail !== undefined ? { detail: f.detail } : {}),
        dmOnly: f.dmOnly,
        options: f.resolution?.options ?? [],
      })),
  };
}
