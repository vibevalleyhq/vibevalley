import { type AgoraClient } from "agora-agents";
import { Clock, Context, Effect, Fiber, FiberSet, Formatter, Layer, Option, Queue, Schema, type Scope, Stream } from "effect";
import { HttpClient } from "effect/http";
import { Socket } from "effect/socket";

import { type AudioFailure, type TranscriptionFailed, transcriptionAudio, transcribeAudio } from "@vibevalley/ai/transcription";
import { t } from "@vibevalley/i18n";
import { type AgoraGrant, type Dictated, defaultOrchestrator, type Validation, type VoiceCall } from "@vibevalley/protocol";
import { type ApiError } from "@vibevalley/protocol/api";
import { decodeMossFrame } from "@vibevalley/provider/moss";
import { type MossLink, type MossTransport, verifyMoss } from "@vibevalley/provider/moss/server";
import { transcriptionModel, TranscriptionRequestError } from "@vibevalley/provider/transcription";

import { messageOf } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Inbox } from "#/inbox/inbox.ts";
import { ServerConfig } from "#/infra/config.ts";
import { bestEffort, callbackLog } from "#/infra/log.ts";
import { Ingress } from "#/ingress/ingress.ts";
import { Orchestrator } from "#/orchestrator/orchestrator.ts";
import { Provider } from "#/provider/provider.ts";
import { type AgoraCredentials, Setting } from "#/setting/setting.ts";

import {
  agentFor,
  alreadyStopping,
  type CallLine,
  type CallStepFailed,
  callStepFailed,
  clientOf,
  failed,
  newChannel,
  newUid,
  type Run,
  retrying,
  sign,
  speakPieces,
  tokenSeconds,
  unavailable,
  vendorsFor,
  voiceAgentUid,
  voiceUnknown,
} from "./agora.ts";
import { type LineFailed, makeVoiceLine, type Tunnel, tunnelAnswers } from "./line.ts";
import { relay } from "./moss-relay.ts";
import { extractMossToolAck, extractMossToolCalls, mossFrame, mossOrchestratorTool } from "./moss-tools.ts";
import { mossInstructions, noticeLine, onCallLine } from "./prompts.ts";

export { agentFor, type CallLine, clientOf, retrying, speakPieces, tokenSeconds, tunnelAnswers, vendorsFor, voiceAgentUid, voiceUnknown };

/** Succeeds once the signal aborts. */
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const done = () => resume(Effect.void);
    signal.addEventListener("abort", done, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", done));
  });

const sendMoss = (link: MossLink, frame: Parameters<typeof mossFrame>[0]) => {
  const text = mossFrame(frame);
  if (Option.isSome(text)) link.send(text.value);
};

const mapTranscriptionFailure = (e: AudioFailure | TranscriptionFailed): ApiError => {
  switch (e._tag) {
    case "UnsupportedFormat":
      return { _tag: "Refused", reason: t("server.voice.dictation.format", { format: Formatter.format(e.format) }) };
    case "EmptyAudio":
      return { _tag: "Refused", reason: t("server.voice.dictation.empty") };
    case "AudioTooLong":
      return { _tag: "Refused", reason: t("server.voice.dictation.tooLong") };
    case "TranscriptionFailed": {
      const cause = e.cause;
      if (!Schema.is(TranscriptionRequestError)(cause)) return unavailable(t("server.voice.dictation.unreachable", { why: messageOf(cause) }), "dictation");
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
    }
  }
};

type Grant =
  | {
      readonly kind: "agora";
      readonly credentials: AgoraCredentials;
      expires: number;
      starting: boolean;
      agent: string;
    }
  | {
      readonly kind: "moss";
      expires: number;
      starting: boolean;
      agent: string;
    };

interface MossLine {
  link?: MossLink;
  ready: boolean;
  closed: boolean;
  readonly pending: string[];
}

/** A call's agent session: what it says goes through it, with the session's own ConvoAI token. */
type CallSession = ReturnType<ReturnType<typeof agentFor>["createSession"]>;

interface Call {
  readonly kind: "agora" | "moss";
  readonly grant: string;
  readonly moss?: MossLine;
  readonly client?: AgoraClient | undefined;
  readonly session?: CallSession | undefined;
  readonly say: (piece: string) => Effect.Effect<void, CallStepFailed>;
  readonly release: () => void;
  /** A quick/realtime model answers on its own, so its words reach the default channel through `said` and the owner's reach `heard`. */
  readonly quick: boolean;
  /** Said at every pickup; not worth keeping in the chat. */
  readonly greeting: string;
  readonly life: AbortController;
  ending: boolean;
}

export interface RealtimeLine {
  readonly run: (page: Socket.Socket) => Effect.Effect<void, never, Scope.Scope>;
}

export class Voice extends Context.Service<
  Voice,
  {
    readonly session: () => Effect.Effect<AgoraGrant, ApiError>;
    readonly renew: (channel: string, uid: string) => Effect.Effect<AgoraGrant, ApiError>;
    /** about: what rang, when the call answers a ring: the orchestrator says it first, in place of the greeting. */
    readonly start: (channel: string, uid: string, about?: string) => Effect.Effect<VoiceCall, ApiError>;
    readonly stop: (agentId: string) => Effect.Effect<void, ApiError>;
    /** What the owner said on a call: the orchestrator overhears it when Agora's model or MOSS answers. */
    readonly heard: (agentId: string, text: string, picked: string, sendKey: string) => Effect.Effect<void, ApiError>;
    /** The relay without a call id: the one call on. */
    readonly heardCurrent: (text: string, picked: string, sendKey: string) => Effect.Effect<void, ApiError>;
    readonly said: (agentId: string, text: string) => Effect.Effect<void, ApiError>;
    readonly dictate: (audio: string, format: string) => Effect.Effect<Dictated, ApiError>;
    /** A credential check must not capture or send audio. */
    readonly verifyMoss: () => Effect.Effect<Validation>;
    readonly mossLine: () => Effect.Effect<RealtimeLine, ApiError>;
    readonly visionLine: () => Effect.Effect<RealtimeLine, ApiError>;
    /** The keys of the lines open now, by call. */
    readonly lines: () => number;
    /** Words read out on the call that is on, queued after what is being said; false when no call is on. */
    readonly speak: (text: string) => Effect.Effect<boolean>;
  }
>()("@vibevalley/server/voice/voice") {
  static readonly layer = (options?: VoiceOptions) => Layer.effect(Voice, make(options));
}

export interface VoiceOptions {
  /** Agora's REST calls go through it; fetch when absent. */
  readonly fetch?: typeof fetch;
  /** A tunnel to the line's port: its public address and how to close it. cloudflared's quick tunnel when absent. */
  readonly tunnel?: (port: number) => Effect.Effect<Tunnel, LineFailed>;
  /** How long what is to be told waits for others to join it before the orchestrator is asked; 3 s when absent. */
  readonly gatherMs?: number;
  /** How MOSS Live is reached; its WebSocket and HTTPS when absent. */
  readonly moss?: MossTransport;
}

/** Something to tell on the call: updates, and what rang when the call answers a ring. */
interface Told {
  readonly texts: readonly string[];
  readonly ring?: string | undefined;
}

/** Everything that waited, as one: the texts in the order they came, and the latest ring. */
const mergedTold = (all: readonly Told[]) => ({ texts: all.flatMap((t) => t.texts), ring: all.findLast((t) => t.ring)?.ring });

const make = (options: VoiceOptions = {}) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    const config = yield* ServerConfig;
    const core = yield* Core;
    const inbox = yield* Inbox;
    const settings = yield* Setting;
    const provider = yield* Provider;
    const chat = yield* Channel;
    const ingress = yield* Ingress;
    const response = yield* Orchestrator;
    const clock = yield* Clock.Clock;
    const httpClient = yield* HttpClient.HttpClient;
    const forkHere = yield* FiberSet.makeRuntime();
    const runHere: Run = yield* FiberSet.makeRuntimePromise();
    const now = () => clock.currentTimeMillisUnsafe();

    const grants = new Map<string, Grant>();
    const calls = new Map<string, Call>();
    let activeMoss: MossLine | undefined;
    let liveLineActive = false;
    let stopped = false;
    const keyOf = (channel: string, uid: string) => channel + "\u0000" + uid;

    // Pending grants have the same validity as their signed token; active calls own their grant until stop.
    const prune = () => {
      for (const [k, g] of grants) if (!g.starting && !g.agent && g.expires <= now()) grants.delete(k);
    };

    // Asked each time: credentials saved from the title screen work without a restart.
    const creds = () => {
      const c = settings.agora();
      return c ? Effect.succeed(c) : Effect.fail(unavailable(t("server.voice.noAgora"), "call"));
    };

    let commentarySequence = 0;
    const deliverMossPiece = (piece: string, link: MossLink) => {
      const characters = Array.from(piece.trim());
      for (let start = 0; start < characters.length; start += 2000)
        sendMoss(link, {
          action: "session.commentary.append",
          content: characters.slice(start, start + 2000).join(""),
          status: "completed",
          event_id: `brief-${now()}-${commentarySequence++}`,
        });
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopped = true;
        for (const call of calls.values()) call.life.abort();
        calls.clear();
        grants.clear();
        activeMoss = undefined;
      }),
    );

    const voiceLine = yield* makeVoiceLine({
      port: config.voice.line.port,
      url: config.voice.line.url,
      tunnel: options.tunnel,
      httpClient,
      answerer: response.answerer("phone"),
      forkHere,
      isStopped: () => stopped,
    });

    const callOf = (agentId: string) => {
      const call = calls.get(agentId);
      return call && !call.ending ? Effect.succeed(call) : Effect.fail(failed(t("server.voice.hungUp")));
    };

    const liveCall = () => [...calls].find(([, c]) => !c.ending)?.[0];

    // Queued after what is being said (APPEND): never over the owner; the owner may talk over it.
    const speakOn = Effect.fnUntraced(
      function* (agentId: string, text: string) {
        const call = calls.get(agentId);
        if (!call || call.ending) return false;
        for (const piece of speakPieces(text)) {
          if (stopped || call.ending || calls.get(agentId) !== call) return false;
          yield* call.say(piece);
        }
        return true;
      },
      (effect) =>
        effect.pipe(
          Effect.catch((e) =>
            Effect.sync(() => {
              logs.warn("vibevalley: voice: the orchestrator's words were not read out: " + messageOf(e));
              return false;
            }),
          ),
        ),
    );

    const gatherMs = options.gatherMs ?? 3000;
    const told = yield* Queue.unbounded<Told>();
    const round = Effect.gen(function* () {
      let pending: Told[] = yield* Queue.takeAll(told);
      for (let tries = 0; pending.length > 0 && tries < 3;) {
        yield* Effect.sleep(gatherMs);
        pending.push(...(yield* Queue.clear(told)));
        const on = liveCall();
        const call = on ? calls.get(on) : undefined;
        if (!on || !call || stopped) break;
        const { texts, ring } = mergedTold(pending);
        const said = yield* response.brief(onCallLine(texts, ring)).pipe(
          Effect.mapError(callStepFailed),
          Effect.raceFirst(Effect.as(aborted(call.life.signal), undefined)),
          Effect.catch((e) => (stopped || call.ending || calls.get(on) !== call ? Effect.undefined : Effect.fail(e))),
        );
        if (said === undefined || stopped || call.ending || calls.get(on) !== call) break;
        if (said) {
          tries = 0;
          yield* speakOn(on, said);
          pending = yield* Queue.clear(told);
        } else tries++;
      }
    }).pipe(
      Effect.catch((e) => Effect.sync(() => logs.warn("vibevalley: voice: the update could not be told: " + messageOf(e)))),
      Effect.catchDefect((d) => Effect.sync(() => logs.warn("vibevalley: voice: the update could not be told: " + messageOf(d)))),
      Effect.ensuring(Queue.clear(told)),
    );
    yield* Effect.forkScoped(Effect.forever(round));
    const tell = (texts: readonly string[], ring?: string) => {
      if (!stopped && (texts.length > 0 || ring)) Queue.offerUnsafe(told, { texts, ring });
    };

    const news2 = yield* inbox.news;
    yield* Effect.forkScoped(
      Stream.runForEach(news2, (items) =>
        Effect.sync(() => {
          if (liveCall()) tell(items.map((i) => noticeLine(i.words.title, i.words.body)));
        }),
      ),
    );

    const heard = Effect.fn("Voice.heard")(function* (agentId: string, text: string, picked: string, sendKey: string) {
      const call = yield* callOf(agentId);
      if (!call.quick) return;
      yield* ingress.owner({ source: "voice", text, envelope: sendKey, ...(picked ? { picked: { agent: picked } } : {}) });
    });

    return Voice.of({
      session: Effect.fn("Voice.session")(function* () {
        const currentVoice = settings.voice();
        const now2 = yield* Clock.currentTimeMillis;
        const channel = newChannel(now2);
        const uid = newUid();
        if (currentVoice.answer.vendor === "moss") {
          yield* provider.live().pipe(Effect.mapError(() => unavailable(t("server.voice.moss.noKey"), "moss")));
          if (stopped) return yield* Effect.fail(unavailable(t("server.voice.stopped")));
          prune();
          grants.set(keyOf(channel, uid), {
            kind: "moss",
            expires: now() + tokenSeconds * 1000,
            starting: false,
            agent: "",
          });
          return { appId: "moss", channel, uid, token: "moss" };
        }
        const c = yield* creds();
        const issued = yield* Effect.try({
          try: () => sign(c, channel, uid),
          catch: (e) => unavailable(t("server.voice.noToken", { why: messageOf(e) })),
        });
        if (stopped) return yield* Effect.fail(unavailable(t("server.voice.stopped")));
        prune();
        grants.set(keyOf(channel, uid), {
          kind: "agora",
          credentials: c,
          expires: now() + tokenSeconds * 1000,
          starting: false,
          agent: "",
        });
        return issued;
      }),
      renew: Effect.fn("Voice.renew")(function* (channel, uid) {
        prune();
        const g = grants.get(keyOf(channel, uid));
        if (!g) return yield* Effect.fail(unavailable(t("server.voice.grantGone")));
        if (g.kind === "moss") {
          g.expires = now() + tokenSeconds * 1000;
          return { appId: "moss", channel, uid, token: "moss" };
        }
        const issued = yield* Effect.try({
          try: () => sign(g.credentials, channel, uid),
          catch: (e) => unavailable(t("server.voice.noToken", { why: messageOf(e) })),
        });
        g.expires = now() + tokenSeconds * 1000;
        return issued;
      }),
      start: Effect.fn("Voice.start")(function* (channel, uid, about) {
        prune();
        const key = keyOf(channel, uid);
        const g = grants.get(key);
        if (!g) return yield* Effect.fail(unavailable(t("server.voice.grantGone")));
        if (g.starting || g.agent) return yield* Effect.fail(unavailable(t("server.voice.connecting")));
        if (g.kind === "moss") {
          yield* provider.live().pipe(Effect.mapError(() => unavailable(t("server.voice.moss.noKey"), "moss")));
          if (stopped) return yield* Effect.fail(unavailable(t("server.voice.stopped")));
          const voice = settings.voice();
          const id = `moss-${channel}`;
          g.agent = id;
          g.starting = false;
          activeMoss ??= { ready: false, closed: false, pending: [] };
          const target = activeMoss;
          calls.set(id, {
            kind: "moss",
            grant: key,
            moss: target,
            say: (piece) =>
              Effect.gen(function* () {
                if (target.closed || piece.length > 16000 || (!target.ready && target.pending.length >= 8))
                  return yield* callStepFailed(new Error("MOSS commentary unavailable or full"));
                if (target.ready && target.link) deliverMossPiece(piece, target.link);
                else target.pending.push(piece);
              }),
            release: () => {
              if (target.closed) return;
              target.closed = true;
              target.pending.length = 0;
              target.link?.close();
              if (activeMoss === target) activeMoss = undefined;
            },
            quick: true,
            greeting: (about ? "" : voice.greeting).trim(),
            // @effect-diagnostics-next-line abortControllerInEffect:off
            life: new AbortController(),
            ending: false,
          });
          if (about) tell([], about);
          yield* core.did({ kind: "talked" });
          return { agentId: id };
        }

        g.starting = true;
        let release = () => {};
        let callLine: CallLine | undefined;
        let openingLine: Fiber.Fiber<CallLine, LineFailed> | undefined;
        let client: AgoraClient | undefined;
        let starting: Promise<string> | undefined;
        let committed = false;
        const started = Effect.gen(function* () {
          const { voice, keys: vendorKeys, deepseekApiKey } = settings.voiceConfig();
          if (voice.answer.vendor === "orchestrator") {
            const opening = forkHere(voiceLine.open);
            openingLine = opening;
            callLine = yield* Fiber.join(opening).pipe(Effect.mapError((e) => unavailable(t("server.voice.lineFailed", { why: e.message }))));
            const opened = callLine;
            let once = false;
            release = () => {
              if (once) return;
              once = true;
              voiceLine.close(opened.id);
            };
          }
          const forCall = about ? { ...voice, greeting: "" } : voice;
          const vendors = vendorsFor(forCall, vendorKeys, deepseekApiKey, callLine);
          if ("_tag" in vendors) return yield* Effect.fail(vendors);
          const agora = clientOf(g.credentials, voice.area, runHere, options.fetch);
          client = agora;
          const session = agentFor(agora, forCall, vendors).createSession({
            channel,
            agentUid: voiceAgentUid,
            remoteUids: [uid],
            idleTimeout: voice.idleSeconds,
            expiresIn: tokenSeconds,
          });
          const pending = session.start();
          starting = pending;
          const id = yield* Effect.tryPromise({
            try: () => pending,
            catch: (e) => failed(t("server.voice.joinFailed", { why: messageOf(e) })),
          });
          if (stopped || grants.get(key) !== g) return yield* Effect.fail(unavailable(t("server.voice.stopped")));
          g.agent = id;
          g.starting = false;
          calls.set(id, {
            kind: "agora",
            grant: key,
            client: agora,
            session,
            say: (piece) =>
              Effect.tryPromise({
                try: () => session.say(piece, { priority: "APPEND", interruptable: true }),
                catch: callStepFailed,
              }),
            release,
            quick: callLine === undefined,
            greeting: forCall.greeting.trim(),
            // @effect-diagnostics-next-line abortControllerInEffect:off
            life: new AbortController(),
            ending: false,
          });
          committed = true;
          if (about) tell([], about);
          return { agentId: id };
        });
        const agent = yield* started.pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (committed) return;
              release();
              if (grants.get(key) === g) grants.delete(key);
              const opening = openingLine;
              if (opening && !callLine)
                forkHere(
                  Effect.ignore(
                    Effect.map(Fiber.join(opening), (opened) => voiceLine.close(opened.id)),
                    { log: "Debug" },
                  ),
                );
              const pending = starting;
              const agora = client;
              if (pending && agora)
                forkHere(
                  Effect.tryPromise({ try: () => pending, catch: callStepFailed }).pipe(
                    Effect.option,
                    Effect.flatMap((joined) =>
                      joined._tag === "None"
                        ? Effect.void
                        : Effect.tryPromise({ try: () => agora.stopAgent(joined.value), catch: callStepFailed }).pipe(
                            bestEffort("vibevalley: voice: the late agent could not be stopped"),
                          ),
                    ),
                  ),
                );
            }),
          ),
        );
        yield* core.did({ kind: "talked" });
        return agent;
      }),
      stop: Effect.fn("Voice.stop")(function* (agentId) {
        const call = calls.get(agentId);
        if (call?.kind === "moss") {
          grants.delete(call.grant);
          call.ending = true;
          call.life.abort();
          call.release();
          calls.delete(agentId);
          return;
        }
        if (!call && agentId.startsWith("moss-")) return;
        let client: AgoraClient;
        if (call && call.client) {
          grants.delete(call.grant);
          call.ending = true;
          call.life.abort();
          client = call.client;
        } else {
          const credentials = yield* creds();
          client = clientOf(credentials, settings.voice().area, runHere, options.fetch);
        }
        const stopping = Effect.tryPromise({
          try: () => client.stopAgent(agentId),
          catch: callStepFailed,
        }).pipe(Effect.catch((e) => (alreadyStopping(e.cause) ? Effect.void : Effect.fail(failed(t("server.voice.leaveFailed", { why: messageOf(e) }))))));
        yield* Effect.ensuring(
          stopping,
          Effect.sync(() => call?.release()),
        );
        calls.delete(agentId);
      }),
      heard,
      heardCurrent: Effect.fn("Voice.heardCurrent")(function* (text, picked, sendKey) {
        const live = [...calls].filter(([, c]) => !c.ending);
        if (live.length > 1) return yield* Effect.fail(failed(t("server.voice.manyCalls")));
        const [only] = live;
        if (!only) return yield* Effect.fail(failed(t("server.voice.noCall")));
        return yield* heard(only[0], text, picked, sendKey);
      }),
      said: Effect.fn("Voice.said")(function* (agentId, text) {
        const call = yield* callOf(agentId);
        if (call.quick && text.trim() !== call.greeting)
          yield* Effect.ignore(chat.spoken(defaultOrchestrator, text, ""), {
            log: "Warn",
            message: "vibevalley: voice: the orchestrator's spoken words were not kept",
          });
      }),
      verifyMoss: Effect.fn("Voice.verifyMoss")(function* () {
        const connection = yield* provider.live().pipe(Effect.option);
        if (connection._tag === "None") return { problem: t("server.voice.moss.noKey") };
        const r = yield* verifyMoss(connection.value.key, options.moss, connection.value.model);
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
      }),
      visionLine: Effect.fn("Voice.visionLine")(function* () {
        const connection = yield* provider.vision();
        return { run: (page: Socket.Socket) => relay(page, connection.key, options.moss, undefined, connection.model) };
      }),
      mossLine: Effect.fn("Voice.mossLine")(function* () {
        const connection = yield* provider.live();
        const executed = new Set<string>();
        const awaitingAck = new Set<string>();
        let active = true;
        let toolsEnabled = false;
        let inFlight = 0;
        return {
          run: (page: Socket.Socket) =>
            Effect.gen(function* () {
              const acquired = yield* Effect.acquireRelease(
                Effect.sync(() => {
                  if (liveLineActive) return undefined;
                  liveLineActive = true;
                  activeMoss ??= { ready: false, closed: false, pending: [] };
                  return activeMoss;
                }),
                (target) =>
                  Effect.sync(() => {
                    if (!target) return;
                    liveLineActive = false;
                    active = false;
                    awaitingAck.clear();
                    target.closed = true;
                    target.ready = false;
                    target.pending.length = 0;
                    if (activeMoss === target) activeMoss = undefined;
                    for (const [id, call] of calls) {
                      if (call.moss !== target) continue;
                      call.ending = true;
                      call.life.abort();
                      grants.delete(call.grant);
                      calls.delete(id);
                    }
                  }),
              );
              if (!acquired) {
                const writer = yield* page.writer;
                // The writer waits for reader acquisition, including when refusing an upgraded socket.
                yield* page.reader.pipe(
                  Effect.andThen(() => writer.write(new Socket.CloseEvent(1013, "Live session already open"))),
                  Effect.ignore({ log: "Debug" }),
                );
                return;
              }
              const forkMoss = yield* FiberSet.makeRuntime();
              yield* relay(
                page,
                connection.key,
                options.moss,
                {
                  onOpen: (link) => {
                    if (acquired.closed) {
                      link.close();
                      return;
                    }
                    acquired.link = link;
                    return () => {
                      active = false;
                      awaitingAck.clear();
                    };
                  },
                  onPageText: (data) => {
                    const decoded = decodeMossFrame(data);
                    if (decoded._tag === "None" || decoded.value.action !== "session.update") return data;
                    // When a farm call is on (or will be), attach the farm's persona and the ask_orchestrator tool.
                    const v = settings.voice();
                    if (v.answer.vendor !== "moss" && ![...calls.values()].some((c) => c.kind === "moss" && !c.ending)) return data;
                    toolsEnabled = true;
                    return Option.getOrUndefined(
                      mossFrame({
                        action: "session.update",
                        session: {
                          persona: { prompt: v.persona },
                          instructions: mossInstructions(v.greeting),
                          tools: [mossOrchestratorTool],
                        },
                      }),
                    );
                  },
                  onMossText: (data, link) => {
                    const decoded = decodeMossFrame(data);
                    if (
                      decoded._tag === "Some" &&
                      decoded.value.action === "session.updated" &&
                      decoded.value.data?.error === "" &&
                      activeMoss === acquired &&
                      !acquired.closed
                    ) {
                      acquired.ready = true;
                      for (const piece of acquired.pending.splice(0)) deliverMossPiece(piece, link);
                    }
                    const ack = extractMossToolAck(data);
                    if (ack && awaitingAck.delete(ack)) sendMoss(link, { action: "response.create", response: { call_ids: [ack] } });
                    for (const toolCall of extractMossToolCalls(data)) {
                      if (!active || acquired.closed || !toolsEnabled || executed.has(toolCall.callId)) continue;
                      if (executed.size >= 64 || inFlight >= 4) {
                        link.close();
                        return;
                      }
                      executed.add(toolCall.callId);
                      inFlight++;
                      forkMoss(
                        response.brief(toolCall.question).pipe(
                          Effect.orElseSucceed(() => t("server.voice.moss.toolFailed")),
                          Effect.tap((answer) =>
                            Effect.sync(() => {
                              if (!active || acquired.closed) return;
                              awaitingAck.add(toolCall.callId);
                              sendMoss(link, {
                                action: "conversation.item.create",
                                item: { type: "function_call_output", call_id: toolCall.callId, output: answer || t("server.voice.moss.toolFailed") },
                              });
                            }),
                          ),
                          Effect.ignore({ log: "Warn", message: "vibevalley: voice: ask_orchestrator tool result failed" }),
                          Effect.ensuring(
                            Effect.sync(() => {
                              inFlight--;
                            }),
                          ),
                        ),
                      );
                    }
                  },
                },
                connection.model,
              );
            }),
        };
      }),
      dictate: Effect.fn("Voice.dictate")(function* (audio64, given) {
        const connection = yield* provider.dictation().pipe(Effect.mapError((error) => unavailable(error.reason, "dictation")));
        const input = yield* transcriptionAudio(audio64, given).pipe(Effect.mapError(mapTranscriptionFailure));
        const selected = yield* transcriptionModel(connection, input.format).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        const result = yield* transcribeAudio(selected, input.audio).pipe(Effect.mapError(mapTranscriptionFailure));
        return { text: result.text };
      }, Effect.scoped),
      lines: voiceLine.lines,
      speak: Effect.fn("Voice.speak")(function* (text) {
        const on = liveCall();
        return on ? yield* speakOn(on, text) : false;
      }),
    });
  });
