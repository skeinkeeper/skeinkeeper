// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { PresentPlayer } from "./hot_context.js";
import { InterruptedError, type PresenceMember, type VoiceIO } from "./interfaces/voice.js";
import { runTurn, type Session, type TurnInput, type TurnOutput } from "./session.js";
import { TranscriptionBuffer, utteranceToFragment, type BufferFragment } from "./voice/buffer.js";
import { decideShouldRespond, type RespondDecision } from "./voice/decider.js";
import { DEFAULT_EAGERNESS, type Eagerness } from "./voice/eagerness.js";
import { parseNarrationSegments, type NarrationSegment } from "./voice/markers.js";
import { resolveSegmentVoices } from "./voice/assignment.js";
import type { MaskingPool } from "./voice/masking/pool.js";
import type { Filler } from "./voice/masking/filler.js";
import { buildOnboardingDirective, selectOnboardingTargets } from "./voice/onboarding.js";
import { formatSpeakerLine } from "./util/format.js";

/**
 * The always-listening voice loop (design doc 0015). Replaces the naive
 * per-utterance `runVoiceSession` with a capture/respond split:
 *
 *  - Every consented utterance is captured continuously into a transcription
 *    buffer (nothing is dropped while the DM is thinking or speaking).
 *  - On a `lull` signal from the adapter, a cheap orchestration-tier decider
 *    judges whether the DM should respond — biased by the operator's
 *    Eagerness setting.
 *  - Only when it decides "yes" do we drain the buffer and run the expensive
 *    narration turn via `runTurn`, then speak it.
 *
 * The endpointing/VAD/barge-in *timing* lives in the VoiceIO adapter; this
 * loop is the orchestration over its events. The decider and buffer are the
 * unit-testable cores.
 */
export interface AlwaysListeningConfig {
  voiceIO: VoiceIO;
  session: Session;
  /** Consent text shown to players who haven't granted voice processing. */
  consentText: string;
  /**
   * Voice-consent check (design doc 0023). Read fresh so a grant/withdraw mid
   * session takes effect immediately. Used to (a) prompt unconsented members
   * who join the channel and (b) gate onboarding to consented members — the AI
   * can't hear an unconsented player's reply. Defaults to "everyone consented"
   * (for tests / when the caller gates consent entirely in the adapter).
   */
  isConsented?: (discordUserId: string) => boolean;
  /**
   * Current operator Eagerness, read fresh each decision cycle so a
   * mid-session change (Discord command / web UI) takes effect immediately.
   * Defaults to the session config's value, then Balanced.
   */
  getEagerness?: () => Eagerness;
  /** Map a completed turn to a TTS voice ID (default voice if undefined).
   *  Used only when `voiceRouting` is not provided. */
  resolveVoiceId?: (turn: TurnOutput) => string | undefined;
  /**
   * Per-character voice routing (design doc 0017). When present, narration is
   * split on `[NPC:name]` markers and each segment is spoken in its own voice
   * — the DM persona for narration, the persisted/assigned voice for NPCs.
   * The caller wires these to the voice_assignment store + the NPC assigner.
   */
  voiceRouting?: {
    dmVoiceId: string;
    getNpcVoice: (npcKey: string) => string | undefined;
    assignNpcVoice: (npcKey: string) => Promise<string>;
  };
  /** Invoked after each respond-decision (for telemetry / operator UI). */
  onDecision?: (decision: RespondDecision, fragments: ReadonlyArray<BufferFragment>) => void;
  /** Invoked after each turn the DM actually takes. */
  onTurn?: (turn: TurnOutput) => void;
  /**
   * Latency masking (design doc 0028 §P2). When set, if the DM hasn't started
   * speaking within `thresholdMs` of a responding turn, a context-tagged filler
   * is spoken to cover the gap (the *fallback* to the front-loaded opener,
   * behavior §2.6). The pool is topped up off-path during lulls via `generate`.
   * Requires `voiceRouting` (the filler is spoken in the DM voice).
   */
  masking?: {
    pool: MaskingPool;
    /** Play a filler if no narration has started within this long. Default 1200. */
    thresholdMs?: number;
    /** Current scene tags for filler selection (read at fire time). */
    sceneTags?: () => ReadonlyArray<string>;
    /** Off-path generator to refill the pool during lulls. */
    generate?: () => Promise<ReadonlyArray<Filler>>;
  };
}

export interface AlwaysListeningResult {
  /** Turns the DM actually took (responses + onboarding turns). */
  turnCount: number;
  /** Respond-decisions evaluated (a subset trigger turns). */
  decisionCount: number;
  /** Onboarding turns run (a subset of turnCount; design doc 0023). */
  onboardingCount: number;
}

/**
 * Collapse the drained buffer fragments into a single turn input. A single
 * speaker maps cleanly to one attributed turn; multiple overlapping speakers
 * are labeled inline and attributed to the most recent speaker (so identity
 * mapping still resolves to a character). The labeled text preserves all
 * captured side-chatter in the transcript — nothing is dropped (doc 0015 §6).
 */
export function mergeFragmentsToTurnInput(
  fragments: ReadonlyArray<BufferFragment>,
): TurnInput | null {
  if (fragments.length === 0) return null;
  if (fragments.length === 1) {
    const f = fragments[0]!;
    return {
      speaker: f.speaker,
      ...(f.displayName !== undefined ? { displayName: f.displayName } : {}),
      text: f.text,
    };
  }
  const text = fragments.map((f) => formatSpeakerLine(f)).join("\n");
  const last = fragments[fragments.length - 1]!;
  return {
    speaker: last.speaker,
    ...(last.displayName !== undefined ? { displayName: last.displayName } : {}),
    text,
  };
}

export async function runAlwaysListeningSession(
  config: AlwaysListeningConfig,
): Promise<AlwaysListeningResult> {
  const { voiceIO, session } = config;
  const buffer = new TranscriptionBuffer();
  const getEagerness = config.getEagerness ?? (() => session.config.eagerness ?? DEFAULT_EAGERNESS);
  const isConsented = config.isConsented ?? (() => true);

  // Voice-channel roster (design doc 0023): who's present, who we've already
  // welcomed this session, and who we've already asked for consent. Diffed
  // against player_character_map each lull to decide who still needs the
  // onboarding ritual.
  const present = new Map<string, PresenceMember>();
  const greeted = new Set<string>();
  const consentPrompted = new Set<string>();

  // Send one consent prompt per member, deduped across both triggers (a speak
  // burst and a channel join) so a noisy room isn't re-prompted.
  const promptConsentOnce = async (discordId: string): Promise<void> => {
    if (consentPrompted.has(discordId)) return;
    consentPrompted.add(discordId);
    await voiceIO.requestConsent(discordId, config.consentText);
  };

  let turnCount = 0;
  let decisionCount = 0;
  let onboardingCount = 0;

  for await (const event of voiceIO.listen()) {
    if (event.kind === "consent_needed") {
      // The adapter only emits this for an unconsented speaker, so prompt
      // directly (independent of the isConsented predicate, which may lag).
      await promptConsentOnce(event.speaker);
      continue;
    }

    if (event.kind === "presence") {
      present.clear();
      for (const m of event.members) present.set(m.id, m);
      // Front-load consent so newcomers (even silent ones) can opt in before
      // the onboarding ritual reaches them. Re-arm anyone now consented so a
      // later withdrawal re-prompts.
      for (const m of event.members) {
        if (isConsented(m.id)) consentPrompted.delete(m.id);
        else await promptConsentOnce(m.id);
      }
      continue;
    }

    if (event.kind === "utterance") {
      buffer.append(utteranceToFragment(event.utterance));
      continue;
    }

    // event.kind === "lull". Top up the masking pool off-path while the table is
    // quiet (design doc 0028 §P2 — generation never blocks a response).
    const masking = config.masking;
    if (masking?.generate !== undefined && masking.pool.needsRefill()) {
      void masking.pool.refill(masking.generate);
    }

    // Build the table roster fresh (mappings can change as the AI records
    // characters), then decide what to do.
    const roster = buildRoster(session, present);
    const mapped = new Set(
      roster.filter((p) => p.mappedActorId !== undefined).map((p) => p.discordId),
    );
    const consented = new Set([...present.keys()].filter((id) => isConsented(id)));
    const targets = selectOnboardingTargets({
      present: [...present.values()],
      consented,
      mapped,
      greeted,
    });

    // Onboarding is a deliberate ritual, not a judgment call — when someone
    // present still needs a character mapping, run an onboarding turn and skip
    // the "should I respond?" decider entirely (design doc 0023 §2). We fold in
    // anything they just said so the AI can welcome *and* confirm a character
    // in one turn if they already introduced one.
    if (targets.length > 0) {
      const merged = mergeFragmentsToTurnInput(buffer.drain());
      const directive = buildOnboardingDirective(targets);
      const onboardingInput: TurnInput =
        merged === null
          ? { speaker: "orchestrator", text: directive }
          : { ...merged, text: `${merged.text}\n\n${directive}` };

      const turn = await runTurnAndSpeak(config, onboardingInput, roster);
      for (const t of targets) greeted.add(t.id);
      onboardingCount += 1;
      turnCount += 1;
      config.onTurn?.(turn);
      continue;
    }

    // No onboarding pending → normal play. Nothing captured since the last
    // response → nothing to decide on (a quiet/noisy room shouldn't churn the
    // decider on empty buffers).
    const pending = buffer.pending();
    if (pending.length === 0) continue;
    const decision = await decideShouldRespond(session.config.llm, {
      fragments: pending,
      eagerness: getEagerness(),
    });
    decisionCount += 1;
    config.onDecision?.(decision, pending);
    if (!decision.respond) continue;

    const turnInput = mergeFragmentsToTurnInput(buffer.drain());
    if (turnInput === null) continue;

    const turn = await runTurnAndSpeak(config, turnInput, roster);
    turnCount += 1;
    config.onTurn?.(turn);
  }

  return { turnCount, decisionCount, onboardingCount };
}

/**
 * Assemble the current voice-channel roster + character mappings (design doc
 * 0023). Reads `player_character_map` for each present member so the AI sees
 * who is already claimed and who still needs onboarding.
 */
function buildRoster(
  session: Session,
  present: ReadonlyMap<string, PresenceMember>,
): PresentPlayer[] {
  const cfg = session.config;
  const out: PresentPlayer[] = [];
  for (const m of present.values()) {
    const mapping = cfg.tenantDb.playerCharacterMap.currentForPlayer(cfg.campaignId, m.id);
    const p: PresentPlayer = { discordId: m.id };
    if (m.displayName !== undefined) p.displayName = m.displayName;
    if (mapping?.foundryActorId !== undefined) p.mappedActorId = mapping.foundryActorId;
    out.push(p);
  }
  return out;
}

/**
 * Run a turn and speak it. With per-character voice routing (the real path) the
 * narration **streams** (design doc 0028 P1): each speakable segment is spoken
 * in order, on a serial queue, *as the model produces it* — so audio starts
 * ~one sentence in rather than after the whole turn, and segment N+1 generates
 * while segment N plays. Without routing, falls back to speaking the completed
 * narration. Returns the TurnOutput either way.
 */
async function runTurnAndSpeak(
  config: AlwaysListeningConfig,
  input: TurnInput,
  roster: ReadonlyArray<PresentPlayer>,
): Promise<TurnOutput> {
  const routing = config.voiceRouting;
  // Barge-in (design doc 0028 P2): if a segment's playback is interrupted (the
  // player talks over the DM), abort the rest of the turn's generation so we
  // stop talking over them instead of finishing the monologue.
  const abort = new AbortController();

  if (routing === undefined) {
    const turn = await runTurn(config.session, input, {
      presentPlayers: roster,
      signal: abort.signal,
    });
    try {
      await speakTurn(config, turn);
    } catch (err) {
      if (!(err instanceof InterruptedError)) throw err; // playback stopped — fine
    }
    return turn;
  }

  // Serial speaker: each segment chains onto the previous so audio plays FIFO
  // while the model keeps generating. A dropped segment is swallowed; a barge-in
  // interrupt aborts the in-flight generation.
  let speakChain: Promise<void> = Promise.resolve();
  let streamed = false;

  // Latency masking (design doc 0028 §P2): if no narration has started within
  // the threshold, speak one context-tagged filler to cover the gap. It lands on
  // the (still-empty) speak queue first, so the real narration follows it.
  const masking = config.masking;
  const maskTimer =
    masking !== undefined
      ? setTimeout(() => {
          if (streamed) return;
          const filler = masking.pool.select(masking.sceneTags?.() ?? []);
          if (filler === null) return;
          speakChain = speakChain
            .then(() => speakSegment(config.voiceIO, routing, { kind: "dm", text: filler.text }))
            .catch(() => {});
        }, masking.thresholdMs ?? 1200)
      : undefined;

  const turn = await runTurn(config.session, input, {
    presentPlayers: roster,
    signal: abort.signal,
    onNarrationSegment: (seg) => {
      if (!streamed && maskTimer !== undefined) clearTimeout(maskTimer); // real audio beat us to it
      streamed = true;
      speakChain = speakChain
        .then(() => speakSegment(config.voiceIO, routing, seg))
        .catch((err: unknown) => {
          if (err instanceof InterruptedError) {
            abort.abort(); // stop generating; the player is talking
            config.voiceIO.interrupt?.();
          }
        });
    },
  });
  if (maskTimer !== undefined) clearTimeout(maskTimer);
  await speakChain; // drain queued audio before returning
  if (!streamed && turn.narration.length > 0) {
    try {
      await speakTurn(config, turn);
    } catch (err) {
      if (!(err instanceof InterruptedError)) throw err;
    }
  }
  return turn;
}

/** Resolve a single streamed segment's voice and speak it (design doc 0028 P1). */
async function speakSegment(
  voiceIO: VoiceIO,
  routing: NonNullable<AlwaysListeningConfig["voiceRouting"]>,
  seg: NarrationSegment,
): Promise<void> {
  if (seg.text.length === 0) return;
  const voiceId =
    seg.kind === "dm"
      ? routing.dmVoiceId
      : (routing.getNpcVoice(seg.npcKey) ?? (await routing.assignNpcVoice(seg.npcKey)));
  await voiceIO.speak(seg.text, { voiceId });
}

async function speakTurn(config: AlwaysListeningConfig, turn: TurnOutput): Promise<void> {
  if (turn.narration.length === 0) return;

  if (config.voiceRouting) {
    const segments = parseNarrationSegments(turn.narration);
    const resolved = await resolveSegmentVoices(segments, config.voiceRouting);
    for (const seg of resolved) {
      await config.voiceIO.speak(seg.text, { voiceId: seg.voiceId });
    }
    return;
  }

  const voiceId = config.resolveVoiceId?.(turn);
  await config.voiceIO.speak(turn.narration, voiceId !== undefined ? { voiceId } : undefined);
}
