import type { AgoraClient } from "agora-agents";
import type { WebSocket } from "ws";

import { AudioTooLong, EmptyAudio, TranscriptionFailed, transcriptionAudio, transcribeAudio, UnsupportedFormat } from "@vibevalley/ai/transcription";
import { abortable, anySignal, isAbort, Queue, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import { type AgoraGrant, type Dictated, defaultOrchestrator, type Validation, type VoiceCall } from "@vibevalley/protocol";
import { decodeMossFrame } from "@vibevalley/provider/moss";
import { TranscriptionRequestError } from "@vibevalley/provider/transcription";

import { ApiError, BizCode, bizError, messageOf } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Orchestrator } from "#/modules/orchestrator/orchestrator.ts";
import type { Account, Provider } from "#/modules/provider/provider.ts";
import type { RealtimeEvents, RealtimeLink, RealtimeTransport } from "#/modules/provider/vendors.ts";
import type { AgoraCredentials, Setting } from "#/modules/setting/setting.ts";
import type { Watch } from "#/modules/watch/watch.ts";

import {
  agentFor,
  alreadyStopping,
  type CallLine,
  callStepFailed,
  clientOf,
  failed,
  newChannel,
  newUid,
  retrying,
  sign,
  speakPieces,
  tokenSeconds,
  unavailable,
  vendorsFor,
  voiceAgentUid,
  voiceUnknown,
} from "./agora.ts";
import { LineFailed, makeVoiceLine, type Tunnel, tunnelAnswers } from "./line.ts";
import { relay } from "./moss-relay.ts";
import { extractMossToolAck, extractMossToolCalls, mossFrame, mossOrchestratorTool } from "./moss-tools.ts";
import { mossInstructions, noticeLine, onCallLine } from "./prompts.ts";

export { agentFor, type CallLine, clientOf, retrying, speakPieces, tokenSeconds, tunnelAnswers, vendorsFor, voiceAgentUid, voiceUnknown };

const plainAgora = (c: AgoraCredentials) => ({ appId: c.appId, appCertificate: c.appCertificate.reveal() });

const sendMoss = (link: RealtimeLink, frame: Parameters<typeof mossFrame>[0]) => {
  const text = mossFrame(frame);
  if (text !== undefined) link.send(text);
};

/** A dictation's own failure, as the user is told it; anything else is not one and goes on up. */
const transcriptionFailure = (e: unknown): unknown => {
  if (e instanceof UnsupportedFormat) return bizError(BizCode.VoiceRefused, t("server.voice.dictation.format", { format: JSON.stringify(e.format) }));
  if (e instanceof EmptyAudio) return bizError(BizCode.VoiceRefused, t("server.voice.dictation.empty"));
  if (e instanceof AudioTooLong) return bizError(BizCode.VoiceRefused, t("server.voice.dictation.tooLong"));
  if (!(e instanceof TranscriptionFailed)) return e;
  const cause = e.cause;
  if (!(cause instanceof TranscriptionRequestError)) return unavailable(t("server.voice.dictation.unreachable", { why: messageOf(cause) }), "dictation");
  switch (cause.reason) {
    case "Unreachable":
      return unavailable(t("server.voice.dictation.unreachable", { why: cause.message }), "dictation");
    case "Cut":
      return unavailable(t("server.voice.dictation.cut", { why: cause.message }), "call");
    case "HttpStatus":
      return unavailable(t("server.voice.dictation.status", { status: cause.status ?? 0, detail: cause.message }));
    case "InvalidResponse":
      return unavailable(t("server.voice.dictation.shape"));
  }
};

type GrantPhase = { readonly _tag: "issued" } | { readonly _tag: "starting" } | { readonly _tag: "on"; readonly agent: string };

type Grant =
  | {
      readonly kind: "agora";
      readonly credentials: AgoraCredentials;
      expires: number;
      phase: GrantPhase;
    }
  | {
      readonly kind: "moss";
      expires: number;
      phase: GrantPhase;
    };

/** Shared between the call and the page relay; queues commentary in `pending` until `session.updated` arrives. */
type MossPhase =
  | { readonly _tag: "waiting"; readonly link?: RealtimeLink; readonly pending: string[] }
  | { readonly _tag: "ready"; readonly link: RealtimeLink }
  | { readonly _tag: "closed" };
interface MossLine {
  phase: MossPhase;
}
const waitingLine = (): MossLine => ({ phase: { _tag: "waiting", pending: [] } });

type CallSession = ReturnType<ReturnType<typeof agentFor>["createSession"]>;

/** What a call holds until it ends: released in the reverse of the order it was taken. */
interface CallScope {
  /** Aborted as soon as hangup starts, so speech and transcripts stop at once. */
  readonly hungUp: AbortSignal;
  /** Marks the call as hanging up, without releasing anything yet. */
  readonly hang: () => void;
  /** A release run at close; added after the close, it runs at once. */
  readonly add: (release: () => void | Promise<void>) => void;
  readonly close: () => Promise<void>;
}

function callScope(): CallScope {
  const hanging = new AbortController();
  const releases: (() => void | Promise<void>)[] = [];
  let closed = false;
  return {
    hungUp: hanging.signal,
    hang: () => hanging.abort(),
    add: (release) => {
      if (!closed) releases.push(release);
      else void release();
    },
    close: async () => {
      hanging.abort();
      if (closed) return;
      closed = true;
      for (const release of releases.toReversed()) await release();
    },
  };
}

interface Call {
  readonly kind: "agora" | "moss";
  readonly grant: string;
  readonly moss?: MossLine;
  readonly client?: AgoraClient | undefined;
  readonly session?: CallSession | undefined;
  /** Throws CallStepFailed. */
  readonly say: (piece: string) => Promise<void>;
  /** Closed on hangup or Voice shutdown. */
  readonly scope: CallScope;
  /** True when an external realtime model answers directly, so transcripts must be mirrored via heard/said. */
  readonly quick: boolean;
  readonly greeting: string;
}
const ending = (call: Call) => call.scope.hungUp.aborted;
const hangUp = (call: Call) => call.scope.close();

export interface RealtimeLine {
  /** Until the page or the vendor ends the line. */
  readonly run: (page: WebSocket) => Promise<void>;
}

export interface Voice {
  readonly session: () => Promise<AgoraGrant>;
  readonly renew: (channel: string, uid: string) => Promise<AgoraGrant>;
  /** signal: the caller gave up on it; what it took is let go, and an agent that joins late is stopped. */
  readonly start: (channel: string, uid: string, about?: string, signal?: AbortSignal) => Promise<VoiceCall>;
  readonly stop: (agentId: string) => Promise<void>;
  readonly heard: (agentId: string, text: string, picked: string, sendKey: string) => Promise<void>;
  readonly heardCurrent: (text: string, picked: string, sendKey: string) => Promise<void>;
  readonly said: (agentId: string, text: string) => Promise<void>;
  /** signal aborts the upload. */
  readonly dictate: (audio: string, format: string, signal?: AbortSignal) => Promise<Dictated>;
  /** Must not capture or transmit audio. */
  readonly verifyMoss: () => Promise<Validation>;
  readonly mossLine: () => Promise<RealtimeLine>;
  readonly visionLine: () => Promise<RealtimeLine>;
  readonly lines: () => number;
  readonly speak: (text: string) => Promise<boolean>;
  /** Every call hung up, the line and its tunnel closed, a brief under way aborted. */
  readonly close: () => Promise<void>;
}

export interface VoiceOptions {
  /** Agora's REST calls; the farm's fetch when absent. */
  readonly fetch?: typeof fetch;
  readonly tunnel?: (port: number) => Promise<Tunnel>;
  readonly gatherMs?: number;
  readonly moss?: RealtimeTransport;
}

export interface VoiceDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly core: Core;
  readonly watch: Watch;
  readonly setting: Setting;
  readonly provider: Provider;
  readonly channel: Channel;
  readonly orchestrator: Orchestrator;
}

interface Told {
  readonly texts: readonly string[];
  readonly ring?: string | undefined;
}

const mergedTold = (all: readonly Told[]) => ({ texts: all.flatMap((t) => t.texts), ring: all.findLast((t) => t.ring)?.ring });

export async function makeVoice(deps: VoiceDeps, options: VoiceOptions = {}): Promise<Voice> {
  const { config, core, watch, clock, provider } = deps;
  const settings = deps.setting;
  const chat = deps.channel;
  const response = deps.orchestrator;
  const log = deps.log.child("voice");
  const agoraFetch = options.fetch ?? deps.fetch;
  const tasks = new TaskGroup({ name: "voice", onError: (task, e) => log.warn(`vibevalley: voice: ${task}`, e) });
  const now = () => clock.now();
  const lineOf = (account: Account) => ({ connect: (on: RealtimeEvents) => account.realtime.connect(on, options.moss), redact: account.realtime.redact });

  const grants = new Map<string, Grant>();
  const calls = new Map<string, Call>();
  let activeMoss: MossLine | undefined;
  let liveLineActive = false;
  let stopped = false;
  const keyOf = (channel: string, uid: string) => channel + "\u0000" + uid;

  // Active calls retain their grant until stop, even past token expiry.
  const prune = () => {
    for (const [k, g] of grants) if (g.phase._tag === "issued" && g.expires <= now()) grants.delete(k);
  };

  const creds = () => {
    const c = settings.agora();
    if (!c) throw unavailable(t("server.voice.noAgora"), "call");
    return c;
  };

  let commentarySequence = 0;
  const deliverMossPiece = (piece: string, link: RealtimeLink) => {
    const characters = Array.from(piece.trim());
    for (let start = 0; start < characters.length; start += 2000)
      sendMoss(link, {
        action: "session.commentary.append",
        content: characters.slice(start, start + 2000).join(""),
        status: "completed",
        event_id: `brief-${now()}-${commentarySequence++}`,
      });
  };

  const voiceLine = await makeVoiceLine({
    port: config.voice.line.port,
    url: config.voice.line.url,
    tunnel: options.tunnel,
    fetch: deps.fetch,
    clock,
    log,
    answerer: response.answerer("phone"),
    isStopped: () => stopped,
  });

  const callOf = (agentId: string) => {
    const call = calls.get(agentId);
    if (!call || ending(call)) throw failed(t("server.voice.hungUp"));
    return call;
  };

  const liveCall = () => [...calls].find(([, c]) => !ending(c))?.[0];

  // APPEND priority queues behind current speech without interrupting the user.
  const speakOn = async (agentId: string, text: string) => {
    try {
      const call = calls.get(agentId);
      if (!call || ending(call)) return false;
      for (const piece of speakPieces(text)) {
        if (stopped || ending(call) || calls.get(agentId) !== call) return false;
        await call.say(piece);
      }
      return true;
    } catch (e) {
      log.warn("vibevalley: voice: the orchestrator's words were not read out: " + messageOf(e));
      return false;
    }
  };

  const gatherMs = options.gatherMs ?? 3000;
  const told = new Queue<Told>();
  const round = async (first: Told, signal: AbortSignal) => {
    try {
      let pending: Told[] = [first, ...told.takeAll()];
      for (let tries = 0; pending.length > 0 && tries < 3;) {
        await clock.sleep(gatherMs, signal);
        pending.push(...told.takeAll());
        const on = liveCall();
        const call = on ? calls.get(on) : undefined;
        if (!on || !call || stopped) break;
        const { texts, ring } = mergedTold(pending);
        // The brief stops as soon as the call hangs up, or Voice closes.
        const briefing = anySignal(signal, call.scope.hungUp);
        let said: string | undefined;
        try {
          said = await abortable(response.brief(onCallLine(texts, ring), briefing), briefing);
        } catch (e) {
          if (signal.aborted) throw e;
          if (!(stopped || ending(call) || calls.get(on) !== call)) throw callStepFailed(e);
          said = undefined;
        }
        if (said === undefined || stopped || ending(call) || calls.get(on) !== call) break;
        if (said) {
          tries = 0;
          await speakOn(on, said);
          pending = told.takeAll();
        } else tries++;
      }
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      log.warn("vibevalley: voice: the update could not be told: " + messageOf(e));
    } finally {
      told.takeAll();
    }
  };
  tasks.run("tell", async (signal) => {
    for (;;) await round(await told.take(signal), signal);
  });
  const tell = (texts: readonly string[], ring?: string) => {
    if (!stopped && (texts.length > 0 || ring)) told.offer({ texts, ring });
  };

  const news = watch.inboxNews();
  tasks.run("inbox news", async (signal) => {
    try {
      for (;;) {
        const next = await news.next(signal);
        if (next.done === true) return;
        if (liveCall()) tell(next.value.map((i) => noticeLine(i.words.title, i.words.body)));
      }
    } finally {
      news.close();
    }
  });

  const heard = async (agentId: string, text: string, picked: string, sendKey: string) => {
    const call = callOf(agentId);
    if (!call.quick) return;
    await chat.say({ source: "voice", text, sendKey, ...(picked ? { picked: { agent: picked } } : {}) });
  };

  /** The account MOSS Live calls on, or why there is none, as the voice page says it. */
  const liveAccount = async () => {
    try {
      return await provider.live();
    } catch (e) {
      if (e instanceof ApiError) throw unavailable(t("server.voice.moss.noKey"), "moss");
      throw e;
    }
  };

  const startMoss = async (channel: string, key: string, g: Grant, about: string | undefined): Promise<VoiceCall> => {
    await liveAccount();
    if (stopped) throw unavailable(t("server.voice.stopped"));
    const voice = settings.voice();
    const id = `moss-${channel}`;
    const scope = callScope();
    g.phase = { _tag: "on", agent: id };
    activeMoss ??= waitingLine();
    const target = activeMoss;
    scope.add(() => {
      const line = target.phase;
      if (line._tag === "closed") return;
      target.phase = { _tag: "closed" };
      line.link?.close();
      if (activeMoss === target) activeMoss = undefined;
    });
    calls.set(id, {
      kind: "moss",
      grant: key,
      moss: target,
      say: async (piece) => {
        const line = target.phase;
        if (line._tag === "closed" || piece.length > 16000 || (line._tag === "waiting" && line.pending.length >= 8))
          throw callStepFailed(new Error("MOSS commentary unavailable or full"));
        if (line._tag === "ready") deliverMossPiece(piece, line.link);
        else line.pending.push(piece);
      },
      scope,
      quick: true,
      greeting: (about ? "" : voice.greeting).trim(),
    });
    if (about) tell([], about);
    core.did({ kind: "talked" });
    return { agentId: id };
  };

  const startAgora = async (
    channel: string,
    uid: string,
    key: string,
    g: Extract<Grant, { kind: "agora" }>,
    about: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<VoiceCall> => {
    g.phase = { _tag: "starting" };
    const scope = callScope();
    let callCommitted = false;
    let id = "";
    scope.add(() => {
      if (!callCommitted && grants.get(key) === g) grants.delete(key);
    });
    try {
      const { voice, keys: vendorKeys, deepseekApiKey } = settings.voiceConfig();
      let callLine: CallLine | undefined;
      if (voice.answer.vendor === "orchestrator") {
        try {
          callLine = await abortable(voiceLine.open(), signal);
        } catch (e) {
          if (e instanceof LineFailed) throw unavailable(t("server.voice.lineFailed", { why: e.message }));
          throw e;
        }
        const opened = callLine;
        scope.add(() => voiceLine.close(opened.id));
      }
      const forCall = about ? { ...voice, greeting: "" } : voice;
      const vendors = vendorsFor(
        forCall,
        { asrKey: vendorKeys.asrKey.reveal(), llmKey: vendorKeys.llmKey.reveal(), ttsKey: vendorKeys.ttsKey.reveal() },
        deepseekApiKey === undefined ? "" : deepseekApiKey.reveal(),
        callLine,
      );
      if (vendors instanceof ApiError) throw vendors;
      const agora = clientOf(plainAgora(g.credentials), voice.area, clock, agoraFetch);
      const session = agentFor(agora, forCall, vendors).createSession({
        channel,
        agentUid: voiceAgentUid,
        remoteUids: [uid],
        idleTimeout: voice.idleSeconds,
        expiresIn: tokenSeconds,
      });
      const pending = session.start();
      scope.add(() => {
        if (callCommitted) return;
        // An agent that joins after the start was given up on is stopped once it has joined.
        tasks.run("late agent", async () => {
          let joined: string;
          try {
            joined = await pending;
          } catch (e) {
            log.debug("vibevalley: voice: the abandoned agent did not join", e);
            return;
          }
          await bestEffort(log, "vibevalley: voice: the late agent could not be stopped", () => agora.stopAgent(joined));
        });
      });
      try {
        id = await abortable(pending, signal);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        throw failed(t("server.voice.joinFailed", { why: messageOf(e) }));
      }
      if (stopped || grants.get(key) !== g) throw unavailable(t("server.voice.stopped"));
      g.phase = { _tag: "on", agent: id };
      calls.set(id, {
        kind: "agora",
        grant: key,
        client: agora,
        session,
        say: async (piece) => {
          try {
            await session.say(piece, { priority: "APPEND", interruptable: true });
          } catch (e) {
            throw callStepFailed(e);
          }
        },
        scope,
        quick: callLine === undefined,
        greeting: forCall.greeting.trim(),
      });
      callCommitted = true;
      if (about) tell([], about);
    } catch (e) {
      if (!callCommitted) await scope.close();
      throw e;
    }
    core.did({ kind: "talked" });
    return { agentId: id };
  };

  const close = async () => {
    stopped = true;
    const active = [...calls.values()];
    calls.clear();
    grants.clear();
    activeMoss = undefined;
    for (const call of active) await hangUp(call);
    await tasks.close();
    told.end();
    await voiceLine.stop();
  };

  return {
    session: async () => {
      const currentVoice = settings.voice();
      const channel = newChannel(now());
      const uid = newUid();
      if (currentVoice.answer.vendor === "moss") {
        await liveAccount();
        if (stopped) throw unavailable(t("server.voice.stopped"));
        prune();
        grants.set(keyOf(channel, uid), {
          kind: "moss",
          expires: now() + tokenSeconds * 1000,
          phase: { _tag: "issued" },
        });
        return { appId: "moss", channel, uid, token: "moss" };
      }
      const c = creds();
      let issued: AgoraGrant;
      try {
        issued = sign(plainAgora(c), channel, uid);
      } catch (e) {
        throw unavailable(t("server.voice.noToken", { why: messageOf(e) }));
      }
      if (stopped) throw unavailable(t("server.voice.stopped"));
      prune();
      grants.set(keyOf(channel, uid), {
        kind: "agora",
        credentials: c,
        expires: now() + tokenSeconds * 1000,
        phase: { _tag: "issued" },
      });
      return issued;
    },
    renew: async (channel, uid) => {
      prune();
      const g = grants.get(keyOf(channel, uid));
      if (!g) throw unavailable(t("server.voice.grantGone"));
      if (g.kind === "moss") {
        g.expires = now() + tokenSeconds * 1000;
        return { appId: "moss", channel, uid, token: "moss" };
      }
      let issued: AgoraGrant;
      try {
        issued = sign(plainAgora(g.credentials), channel, uid);
      } catch (e) {
        throw unavailable(t("server.voice.noToken", { why: messageOf(e) }));
      }
      g.expires = now() + tokenSeconds * 1000;
      return issued;
    },
    start: async (channel, uid, about, signal) => {
      prune();
      const key = keyOf(channel, uid);
      const g = grants.get(key);
      if (!g) throw unavailable(t("server.voice.grantGone"));
      if (g.phase._tag !== "issued") throw unavailable(t("server.voice.connecting"));
      return g.kind === "moss" ? startMoss(channel, key, g, about) : startAgora(channel, uid, key, g, about, signal);
    },
    stop: async (agentId) => {
      const call = calls.get(agentId);
      if (call?.kind === "moss") {
        grants.delete(call.grant);
        await hangUp(call);
        calls.delete(agentId);
        return;
      }
      if (!call && agentId.startsWith("moss-")) return;
      let client: AgoraClient;
      if (call && call.client) {
        grants.delete(call.grant);
        call.scope.hang();
        client = call.client;
      } else client = clientOf(plainAgora(creds()), settings.voice().area, clock, agoraFetch);
      try {
        await client.stopAgent(agentId);
      } catch (e) {
        if (!alreadyStopping(e)) throw failed(t("server.voice.leaveFailed", { why: messageOf(e) }));
      } finally {
        if (call) await hangUp(call);
      }
      calls.delete(agentId);
    },
    heard,
    heardCurrent: async (text, picked, sendKey) => {
      const live = [...calls].filter(([, c]) => !ending(c));
      if (live.length > 1) throw failed(t("server.voice.manyCalls"));
      const [only] = live;
      if (!only) throw failed(t("server.voice.noCall"));
      return heard(only[0], text, picked, sendKey);
    },
    said: async (agentId, text) => {
      const call = callOf(agentId);
      if (call.quick && text.trim() !== call.greeting)
        await bestEffort(log, "vibevalley: voice: the orchestrator's spoken words were not kept", () =>
          chat.post({ from: defaultOrchestrator, channel: chat.defaultChannel(), text: text, spoken: true }),
        );
    },
    verifyMoss: async () => {
      let connection: Account;
      try {
        connection = await provider.live();
      } catch (e) {
        if (e instanceof ApiError) return { problem: t("server.voice.moss.noKey") };
        throw e;
      }
      const r = await connection.realtime.verify(options.moss);
      switch (r.kind) {
        case "ok":
          return { problem: "" };
        case "refused":
          return { problem: t("server.voice.moss.refused", { why: r.why }) };
        case "unreachable":
          return { problem: t("server.voice.moss.unreachable", { why: r.why }) };
        case "failed":
          return { problem: t("server.voice.moss.failed", { why: r.why }) };
        case "silent":
          return { problem: t("server.voice.moss.silent") };
      }
    },
    visionLine: async () => {
      const connection = await provider.vision();
      return { run: (page) => relay(page, lineOf(connection), undefined, clock) };
    },
    mossLine: async () => {
      const connection = await provider.live();
      const executed = new Set<string>();
      const awaitingAck = new Set<string>();
      let active = true;
      let toolsEnabled = false;
      let inFlight = 0;
      const release = async (target: MossLine) => {
        liveLineActive = false;
        active = false;
        awaitingAck.clear();
        target.phase = { _tag: "closed" };
        if (activeMoss === target) activeMoss = undefined;
        const closingCalls: Call[] = [];
        for (const [id, call] of calls) {
          if (call.moss !== target) continue;
          grants.delete(call.grant);
          calls.delete(id);
          closingCalls.push(call);
        }
        for (const call of closingCalls) await hangUp(call);
      };
      return {
        run: async (page) => {
          if (liveLineActive) {
            page.close(1013, "Live session already open");
            return;
          }
          liveLineActive = true;
          activeMoss ??= waitingLine();
          const acquired = activeMoss;
          // The tool answers of this line: stopped when it ends.
          const mossTasks = new TaskGroup({ name: "voice/moss", parent: tasks.signal, onError: (task, e) => log.warn(`vibevalley: voice: ${task}`, e) });
          try {
            await relay(
              page,
              lineOf(connection),
              {
                onOpen: (link) => {
                  const line = acquired.phase;
                  if (line._tag === "closed") {
                    link.close();
                    return;
                  }
                  acquired.phase = line._tag === "waiting" ? { ...line, link } : { _tag: "ready", link };
                  return () => {
                    active = false;
                    awaitingAck.clear();
                  };
                },
                onPageText: (data) => {
                  const decoded = decodeMossFrame(data);
                  if (decoded === undefined || decoded.action !== "session.update") return data;
                  // Inject persona and ask_orchestrator tool when a farm MOSS call is active.
                  const v = settings.voice();
                  if (v.answer.vendor !== "moss" && ![...calls.values()].some((c) => c.kind === "moss" && !ending(c))) return data;
                  toolsEnabled = true;
                  return mossFrame({
                    action: "session.update",
                    session: {
                      persona: { prompt: v.persona },
                      instructions: mossInstructions(v.greeting),
                      tools: [mossOrchestratorTool],
                    },
                  });
                },
                onMossText: (data, link) => {
                  const decoded = decodeMossFrame(data);
                  if (
                    decoded !== undefined &&
                    decoded.action === "session.updated" &&
                    decoded.data?.error === "" &&
                    activeMoss === acquired &&
                    acquired.phase._tag === "waiting"
                  ) {
                    const held = acquired.phase.pending;
                    acquired.phase = { _tag: "ready", link };
                    for (const piece of held) deliverMossPiece(piece, link);
                  }
                  const ack = extractMossToolAck(data);
                  if (ack && awaitingAck.delete(ack)) sendMoss(link, { action: "response.create", response: { call_ids: [ack] } });
                  for (const toolCall of extractMossToolCalls(data)) {
                    if (!active || acquired.phase._tag === "closed" || !toolsEnabled || executed.has(toolCall.callId)) continue;
                    if (executed.size >= 64 || inFlight >= 4) {
                      link.close();
                      return;
                    }
                    executed.add(toolCall.callId);
                    inFlight++;
                    mossTasks.run("ask_orchestrator", async (signal) => {
                      try {
                        let answer: string;
                        try {
                          answer = await response.brief(toolCall.question, signal);
                        } catch (e) {
                          if (isAbort(e, signal)) throw e;
                          answer = t("server.voice.moss.toolFailed");
                        }
                        if (!active || acquired.phase._tag === "closed") return;
                        awaitingAck.add(toolCall.callId);
                        sendMoss(link, {
                          action: "conversation.item.create",
                          item: { type: "function_call_output", call_id: toolCall.callId, output: answer || t("server.voice.moss.toolFailed") },
                        });
                      } finally {
                        inFlight--;
                      }
                    });
                  }
                },
              },
              clock,
            );
          } finally {
            await mossTasks.close();
            await release(acquired);
          }
        },
      };
    },
    dictate: async (audio64, given, signal) => {
      let connection: Awaited<ReturnType<Provider["dictation"]>>;
      try {
        connection = await provider.dictation();
      } catch (e) {
        if (e instanceof ApiError) throw unavailable(e.message, "dictation");
        throw e;
      }
      let input: Awaited<ReturnType<typeof transcriptionAudio>>;
      try {
        input = await transcriptionAudio(audio64, given);
      } catch (e) {
        throw transcriptionFailure(e);
      }
      const selected = await connection.transcriber(input.format);
      try {
        const result = await transcribeAudio(selected, input.audio, signal);
        return { text: result.text };
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        throw transcriptionFailure(e);
      }
    },
    lines: voiceLine.lines,
    speak: async (text) => {
      const on = liveCall();
      return on ? speakOn(on, text) : false;
    },
    close,
  };
}
