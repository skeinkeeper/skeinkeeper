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
import { DiscordVoiceIO, type PresenceSource } from "@skeinkeeper/voice-discord";
import {
  Mutex,
  PVP_SETTING_KEY,
  ToolDispatcher,
  archiveSession,
  announceReadyAllowed,
  applyIntakeResolution,
  assignNpcVoice as assignNpcVoiceLLM,
  createDefaultRegistry,
  createIntakeResolutionState,
  formatIntakeReportForOperator,
  kickExtendedIntake,
  loadIntakeConfig,
  MockFoundryClient,
  persistFindingResolution,
  persistSurfacedFindings,
  runSessionStartIntake,
  saveIntakeConfig,
  endSession,
  findDefaultBehaviorSpec,
  loadBehaviorSpec,
  pvpEnabledFromSetting,
  runAlwaysListeningSession,
  runTurn,
  startSession,
  VOICE_CONSENT_TEXT,
  type Eagerness,
  type ExtendedIntakeResult,
  type IntakeFinding,
  type IntakeResolutionState,
  type IntakeResolveResult,
  type MemoryStore,
  type PresenceMember,
  type Session,
  type VoiceIO,
} from "@skeinkeeper/orchestrator";
import { playerAudience, playerConversation, type TenantDb } from "@skeinkeeper/server";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { AppConfig } from "./config.js";
import type { ConsentService } from "./consent.js";
import type { FoundrySource } from "./foundry_source.js";
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
  | { kind: "intake"; ready: boolean; findings: IntakeView["findings"] };

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
  /** Mechanical state. Resolved at session start: the real OSS MCP bridge
   *  (over stdio) when FOUNDRY_MCP_COMMAND is set, else a mock. */
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
    const result = await applyIntakeResolution(this.intakeState, findingId, optionId, {
      ...(this.session !== null ? { foundry: this.session.config.foundry } : {}),
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
    return {
      ctx: {
        campaignId: this.deps.campaignId,
        sessionId: session.config.sessionId,
        sessionConfig: { intake: this.intakeState.intake },
      },
      foundry: session.config.foundry,
      memory: this.deps.memoryStore,
      tenantDb: this.deps.tenantDb,
      onTelemetry: (name: string, props?: Record<string, unknown>) => this.trackIntake(name, props),
    };
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
        await this.dmOperator(result.report.text);
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
    const report = formatIntakeReportForOperator(persisted);
    if (report.text.length > 0) {
      void this.dmOperator(report.text).catch(() => undefined);
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
  }

  private async doStart(): Promise<void> {
    this.deps.onEvent?.({ kind: "status", status: "starting" });
    const { config, providers } = this.deps;

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        // Inbound player DMs are the side-channel transport (design doc 0026 §7).
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // DM channels/messages arrive uncached; partials let the events fire.
      partials: [Partials.Channel, Partials.Message],
    });
    this.client = client;
    this.registerSideChannelDms(client);
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

    const dispatcher = new ToolDispatcher({
      registry: createDefaultRegistry(),
      // Single serialized writer so the table loop and side-channel turns never
      // race shared world-state (design doc 0026 §3).
      writeSerializer: this.writeSerializer,
      ...(this.deps.analytics !== undefined ? { analytics: this.deps.analytics } : {}),
    });
    const behaviorSpec = loadBehaviorSpec(findDefaultBehaviorSpec(import.meta.dirname));
    let foundry;
    try {
      foundry = await this.deps.foundry.connect();
    } catch {
      // Minimum intake fails fast as FOUNDRY_NOT_CONNECTED (TDD 0031).
      foundry = new MockFoundryClient({ system: "", connected: false });
    }
    // Operator escalations reach the human via Discord DM (design docs 0023,
    // 0024). The closure reads the operator live, so a designation set/changed
    // mid-session (console or slash command) takes effect immediately.
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
      notifyOperator: (message) => this.dmOperator(message),
      intake: this.intakeState.intake,
      ...(this.deps.analytics !== undefined ? { analytics: this.deps.analytics } : {}),
    });
    await this.runIntakeAtStart();

    // Resolve a username typed before the bot was online (design doc 0024 §1),
    // and surface the initial operator + voice roster to the console.
    await this.resolvePendingOperator();
    this.emitOperatorEvent();
    const emitRoster = (members: ReadonlyArray<PresenceMember>): void => this.emitRoster(members);
    emitRoster(presence.current());
    this.unsubscribeRoster = presence.subscribe(emitRoster);

    this.running = true;
    this.deps.onEvent?.({ kind: "status", status: "running" });

    this.routing = {
      dmVoiceId: this.controls.dmVoiceId,
      getNpcVoice: (key) =>
        this.deps.tenantDb.voiceAssignments.get(this.deps.campaignId, "npc", key)?.providerVoiceId,
      assignNpcVoice: async (key) => {
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

    this.loopPromise = runAlwaysListeningSession({
      voiceIO,
      session: this.session,
      consentText: VOICE_CONSENT_TEXT,
      getEagerness: () => this.controls.eagerness,
      isConsented: (id) => this.deps.consent.isGranted(id),
      intakeReady: () => this.intakeReadyFlag,
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
    this.extendedStarted = false;
    this.intakeReadyFlag = true;
    this.deps.onEvent?.({ kind: "status", status: "stopped" });
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

  /**
   * DM the operator a setup note (design docs 0023, 0024). Reads the operator
   * live so a mid-session designation works. Throws when no operator is set so
   * the notify_operator tool reports undelivered; logs a degraded fallback.
   */
  private async dmOperator(message: string): Promise<void> {
    const id = this.operator.get();
    if (id === undefined || this.client === null) {
      // Degraded fallback when no operator is designated (design doc 0024 §4).
      console.warn(`[operator note — no operator set] ${message}`);
      throw new Error("no operator designated");
    }
    const user = await this.client.users.fetch(id);
    await user.send({ content: `🧵 **Skeinkeeper (operator note):** ${message}` });
  }

  /**
   * Inbound side-channel transport (design doc 0026 §7): a player DMs the bot.
   * Each DM is routed to that player's 1:1 conversation and run as a private
   * side-channel turn (player audience + conversationId, orchestration tier),
   * with the answer delivered back in the DM. The structural audience scoping
   * (design doc 0026 §10) keeps other players' private content and `gm` secrets
   * out of the turn entirely. LIVE-VALIDATION REQUIRED.
   */
  private registerSideChannelDms(client: Client): void {
    client.on(Events.MessageCreate, (message) => {
      void this.handleSideChannelDm(message);
    });
  }

  private async handleSideChannelDm(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.guildId !== null) return; // DMs only, never a guild channel
    const text = message.content.trim();
    if (text.length === 0) return;
    const session = this.session;
    if (session === null || !this.running) return;

    const authorId = message.author.id;
    // Only actual table participants get a side-channel — a random DM to the bot
    // shouldn't spin up a turn.
    if (!this.isTableParticipant(authorId)) return;

    try {
      if ("sendTyping" in message.channel) {
        await message.channel.sendTyping(); // the "thinking…" signal (0026 §10)
      }
    } catch {
      // typing indicator is best-effort
    }

    const displayName =
      this.guild?.members.cache.get(authorId)?.displayName ?? message.author.username;
    // Read PvP once, at initiation (0026 §6), and surface it so the model can
    // apply the §11.3 gate for any PC-targeting action it's asked to resolve.
    const pvpNote = this.controls.pvpEnabled
      ? "PvP is ENABLED for this campaign."
      : "PvP is DISABLED for this campaign — do not resolve an action against another player's character in private; refuse and redirect to the group.";

    try {
      const turn = await runTurn(
        session,
        { speaker: authorId, displayName, text },
        {
          conversation: {
            id: playerConversation(this.deps.tenantDb.piiCrypto, authorId),
            audience: playerAudience(this.deps.tenantDb.piiCrypto, authorId),
          },
          modelTier: "orchestration",
          systemNote: pvpNote,
        },
      );
      if (turn.narration.trim().length > 0) {
        await message.reply(turn.narration);
      }
    } catch {
      try {
        await message.reply(
          "(Something went wrong handling that privately — try again, or raise it at the table.)",
        );
      } catch {
        // give up if even the fallback reply fails
      }
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
      await guild?.commands.set([
        {
          name: "skeinkeeper",
          description: "Skeinkeeper controls",
          options: [
            {
              type: 1, // SUB_COMMAND
              name: "consent",
              description: "Grant or withdraw voice-processing consent",
              options: [
                { type: 3, name: "action", description: "grant or withdraw", required: true },
              ],
            },
            {
              type: 1, // SUB_COMMAND
              name: "operator",
              description: "Designate yourself (or clear/show) the operator who gets setup DMs",
              options: [
                { type: 3, name: "action", description: "claim, clear, or show", required: true },
              ],
            },
            {
              type: 1, // SUB_COMMAND
              name: "session",
              description: "Start or stop the session",
              options: [
                {
                  type: 3,
                  name: "action",
                  description: "start or stop",
                  required: true,
                  choices: [
                    { name: "start", value: "start" },
                    { name: "stop", value: "stop" },
                  ],
                },
              ],
            },
            {
              type: 1, // SUB_COMMAND
              name: "eagerness",
              description: "Set how readily the DM speaks",
              options: [
                {
                  type: 3,
                  name: "level",
                  description: "reserved, balanced, or eager",
                  required: true,
                  choices: [
                    { name: "reserved", value: "reserved" },
                    { name: "balanced", value: "balanced" },
                    { name: "eager", value: "eager" },
                  ],
                },
              ],
            },
            {
              type: 1, // SUB_COMMAND
              name: "voice",
              description: "List the DM voices or set the active one",
              options: [
                {
                  type: 3,
                  name: "action",
                  description: "list or set",
                  required: true,
                  choices: [
                    { name: "list", value: "list" },
                    { name: "set", value: "set" },
                  ],
                },
                {
                  type: 3,
                  name: "persona",
                  description: "which DM voice to make active (for set)",
                  required: false,
                  choices: this.listPersonas()
                    .slice(0, 25)
                    .map((p) => ({ name: p.label, value: p.id })),
                },
              ],
            },
            {
              type: 1, // SUB_COMMAND
              name: "pvp",
              description: "Turn player-vs-player on/off, or show it (operator only)",
              options: [
                {
                  type: 3,
                  name: "action",
                  description: "on, off, or show",
                  required: true,
                  choices: [
                    { name: "on", value: "on" },
                    { name: "off", value: "off" },
                    { name: "show", value: "show" },
                  ],
                },
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
