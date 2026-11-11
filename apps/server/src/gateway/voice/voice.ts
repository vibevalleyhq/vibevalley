import { type AgoraClient } from "agora-agents";
import { Clock, Context, Deferred, Effect, Exit, FiberSet, Formatter, Layer, Option, Queue, Redacted, Schema, Scope, Stream } from "effect";
import { HttpClient } from "effect/http";
import { Socket } from "effect/socket";

import { type AudioFailure, type TranscriptionFailed, transcriptionAudio, transcribeAudio } from "@vibevalley/ai/transcription";
import { t } from "@vibevalley/i18n";
import { type AgoraGrant, type Dictated, defaultOrchestrator, type Validation, type VoiceCall } from "@vibevalley/protocol";
import { decodeMossFrame } from "@vibevalley/provider/moss";
import { TranscriptionRequestError } from "@vibevalley/provider/transcription";

import { ApiError, BizCode, bizError, messageOf } from "#/base/errors.ts";
import { Core } from "#/core/core.ts";
import { ServerConfig } from "#/infra/config.ts";
import { bestEffort, callbackLog } from "#/infra/log.ts";
import { Channel } from "#/modules/channel/channel.ts";
import { Inbox } from "#/modules/inbox/inbox.ts";
import { Orchestrator } from "#/modules/orchestrator/orchestrator.ts";
import { type Account, Provider } from "#/modules/provider/provider.ts";
import type { RealtimeEvents, RealtimeLink, RealtimeTransport } from "#/modules/provider/vendors.ts";
import { type AgoraCredentials, Setting } from "#/modules/setting/setting.ts";

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

const plainAgora = (c: AgoraCredentials) => ({ appId: c.appId, appCertificate: Redacted.value(c.appCertificate) });

const sendMoss = (link: RealtimeLink, frame: Parameters<typeof mossFrame>[0]) => {
  const text = mossFrame(frame);
  if (Option.isSome(text)) link.send(text.value);
};

const mapTranscriptionFailure = (e: AudioFailure | TranscriptionFailed): ApiError => {
  switch (e._tag) {
    case "UnsupportedFormat":
      return bizError(BizCode.VoiceRefused, t("server.voice.dictation.format", { format: Formatter.format(e.format) }));
    case "EmptyAudio":
      return bizError(BizCode.VoiceRefused, t("server.voice.dictation.empty"));
    case "AudioTooLong":
      return bizError(BizCode.VoiceRefused, t("server.voice.dictation.tooLong"));
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

interface Call {
  readonly kind: "agora" | "moss";
  readonly grant: string;
  readonly moss?: MossLine;
  readonly client?: AgoraClient | undefined;
  readonly session?: CallSession | undefined;
  readonly say: (piece: string) => Effect.Effect<void, CallStepFailed>;
  /** Closed on hangup or Voice shutdown; releases call-owned resources in LIFO order. */
  readonly scope: Scope.Closeable;
  /** Completed as soon as hangup starts so speech and transcripts stop immediately. */
  readonly hungUp: Deferred.Deferred<void>;
  /** True when an external realtime model answers directly, so transcripts must be mirrored via heard/said. */
  readonly quick: boolean;
  readonly greeting: string;
}
const ending = (call: Call) => Deferred.isDoneUnsafe(call.hungUp);
const hangUp = (call: Call) => Effect.andThen(Deferred.succeed(call.hungUp, undefined), Scope.close(call.scope, Exit.void));

export interface RealtimeLine {
  readonly run: (page: Socket.Socket) => Effect.Effect<void, never, Scope.Scope>;
}

export class Voice extends Context.Service<
  Voice,
  {
    readonly session: () => Effect.Effect<AgoraGrant, ApiError>;
    readonly renew: (channel: string, uid: string) => Effect.Effect<AgoraGrant, ApiError>;
    readonly start: (channel: string, uid: string, about?: string) => Effect.Effect<VoiceCall, ApiError>;
    readonly stop: (agentId: string) => Effect.Effect<void, ApiError>;
    readonly heard: (agentId: string, text: string, picked: string, sendKey: string) => Effect.Effect<void, ApiError>;
    readonly heardCurrent: (text: string, picked: string, sendKey: string) => Effect.Effect<void, ApiError>;
    readonly said: (agentId: string, text: string) => Effect.Effect<void, ApiError>;
    readonly dictate: (audio: string, format: string) => Effect.Effect<Dictated, ApiError>;
    /** Must not capture or transmit audio. */
    readonly verifyMoss: () => Effect.Effect<Validation>;
    readonly mossLine: () => Effect.Effect<RealtimeLine, ApiError>;
    readonly visionLine: () => Effect.Effect<RealtimeLine, ApiError>;
    readonly lines: () => number;
    readonly speak: (text: string) => Effect.Effect<boolean>;
  }
>()("@vibevalley/server/gateway/voice/voice") {
  static readonly layer = (options?: VoiceOptions) => Layer.effect(Voice, make(options));
}

export interface VoiceOptions {
  readonly fetch?: typeof fetch;
  readonly tunnel?: (port: number) => Effect.Effect<Tunnel, LineFailed>;
  readonly gatherMs?: number;
  readonly moss?: RealtimeTransport;
}

interface Told {
  readonly texts: readonly string[];
  readonly ring?: string | undefined;
}

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
    const response = yield* Orchestrator;
    const clock = yield* Clock.Clock;
    const httpClient = yield* HttpClient.HttpClient;
    const forkHere = yield* FiberSet.makeRuntime();
    const runHere: Run = yield* FiberSet.makeRuntimePromise();
    const now = () => clock.currentTimeMillisUnsafe();
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
      return c ? Effect.succeed(c) : Effect.fail(unavailable(t("server.voice.noAgora"), "call"));
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

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        stopped = true;
        const active = [...calls.values()];
        calls.clear();
        grants.clear();
        activeMoss = undefined;
        return Effect.forEach(active, hangUp, { discard: true });
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
      return call && !ending(call) ? Effect.succeed(call) : Effect.fail(failed(t("server.voice.hungUp")));
    };

    const liveCall = () => [...calls].find(([, c]) => !ending(c))?.[0];

    // APPEND priority queues behind current speech without interrupting the user.
    const speakOn = Effect.fnUntraced(
      function* (agentId: string, text: string) {
        const call = calls.get(agentId);
        if (!call || ending(call)) return false;
        for (const piece of speakPieces(text)) {
          if (stopped || ending(call) || calls.get(agentId) !== call) return false;
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
          Effect.raceFirst(Effect.as(Deferred.await(call.hungUp), undefined)),
          Effect.catch((e) => (stopped || ending(call) || calls.get(on) !== call ? Effect.undefined : Effect.fail(e))),
        );
        if (said === undefined || stopped || ending(call) || calls.get(on) !== call) break;
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
      yield* chat.user({ source: "voice", text, envelope: sendKey, ...(picked ? { picked: { agent: picked } } : {}) });
    });

    return Voice.of({
      session: Effect.fn("Voice.session")(function* () {
        const currentVoice = settings.voice();
        const now2 = yield* Clock.currentTimeMillis;
        const channel = newChannel(now2);
        const uid = newUid();
        if (currentVoice.answer.vendor === "moss") {
          yield* provider.live().pipe(Effect.mapError(() => unavailable(t("server.voice.moss.noKey"), "moss")));
          if (stopped) return yield* unavailable(t("server.voice.stopped"));
          prune();
          grants.set(keyOf(channel, uid), {
            kind: "moss",
            expires: now() + tokenSeconds * 1000,
            phase: { _tag: "issued" },
          });
          return { appId: "moss", channel, uid, token: "moss" };
        }
        const c = yield* creds();
        const issued = yield* Effect.try({
          try: () => sign(plainAgora(c), channel, uid),
          catch: (e) => unavailable(t("server.voice.noToken", { why: messageOf(e) })),
        });
        if (stopped) return yield* unavailable(t("server.voice.stopped"));
        prune();
        grants.set(keyOf(channel, uid), {
          kind: "agora",
          credentials: c,
          expires: now() + tokenSeconds * 1000,
          phase: { _tag: "issued" },
        });
        return issued;
      }),
      renew: Effect.fn("Voice.renew")(function* (channel, uid) {
        prune();
        const g = grants.get(keyOf(channel, uid));
        if (!g) return yield* unavailable(t("server.voice.grantGone"));
        if (g.kind === "moss") {
          g.expires = now() + tokenSeconds * 1000;
          return { appId: "moss", channel, uid, token: "moss" };
        }
        const issued = yield* Effect.try({
          try: () => sign(plainAgora(g.credentials), channel, uid),
          catch: (e) => unavailable(t("server.voice.noToken", { why: messageOf(e) })),
        });
        g.expires = now() + tokenSeconds * 1000;
        return issued;
      }),
      start: Effect.fn("Voice.start")(function* (channel, uid, about) {
        prune();
        const key = keyOf(channel, uid);
        const g = grants.get(key);
        if (!g) return yield* unavailable(t("server.voice.grantGone"));
        if (g.phase._tag !== "issued") return yield* unavailable(t("server.voice.connecting"));
        if (g.kind === "moss") {
          yield* provider.live().pipe(Effect.mapError(() => unavailable(t("server.voice.moss.noKey"), "moss")));
          if (stopped) return yield* unavailable(t("server.voice.stopped"));
          const voice = settings.voice();
          const id = `moss-${channel}`;
          const callScope = yield* Scope.make();
          const hungUp = yield* Deferred.make<void>();
          g.phase = { _tag: "on", agent: id };
          activeMoss ??= waitingLine();
          const target = activeMoss;
          yield* Scope.addFinalizer(
            callScope,
            Effect.sync(() => {
              Deferred.doneUnsafe(hungUp, Exit.void);
              const line = target.phase;
              if (line._tag === "closed") return;
              target.phase = { _tag: "closed" };
              line.link?.close();
              if (activeMoss === target) activeMoss = undefined;
            }),
          );
          calls.set(id, {
            kind: "moss",
            grant: key,
            moss: target,
            say: (piece) =>
              Effect.gen(function* () {
                const line = target.phase;
                if (line._tag === "closed" || piece.length > 16000 || (line._tag === "waiting" && line.pending.length >= 8))
                  return yield* callStepFailed(new Error("MOSS commentary unavailable or full"));
                if (line._tag === "ready") deliverMossPiece(piece, line.link);
                else line.pending.push(piece);
              }),
            scope: callScope,
            hungUp,
            quick: true,
            greeting: (about ? "" : voice.greeting).trim(),
          });
          if (about) tell([], about);
          yield* core.did({ kind: "talked" });
          return { agentId: id };
        }

        g.phase = { _tag: "starting" };
        const callScope = yield* Scope.make();
        const hungUp = yield* Deferred.make<void>();
        let callCommitted = false;
        yield* Scope.addFinalizer(
          callScope,
          Effect.sync(() => {
            Deferred.doneUnsafe(hungUp, Exit.void);
            if (!callCommitted && grants.get(key) === g) grants.delete(key);
          }),
        );
        const started = Effect.gen(function* () {
          const { voice, keys: vendorKeys, deepseekApiKey } = settings.voiceConfig();
          const callLine =
            voice.answer.vendor === "orchestrator"
              ? yield* Effect.uninterruptibleMask((restore) =>
                  Effect.tap(restore(voiceLine.open).pipe(Effect.mapError((e) => unavailable(t("server.voice.lineFailed", { why: e.message })))), (opened) =>
                    Scope.addFinalizer(
                      callScope,
                      Effect.sync(() => voiceLine.close(opened.id)),
                    ),
                  ),
                )
              : undefined;
          const forCall = about ? { ...voice, greeting: "" } : voice;
          const vendors = vendorsFor(
            forCall,
            { asrKey: Redacted.value(vendorKeys.asrKey), llmKey: Redacted.value(vendorKeys.llmKey), ttsKey: Redacted.value(vendorKeys.ttsKey) },
            deepseekApiKey === undefined ? "" : Redacted.value(deepseekApiKey),
            callLine,
          );
          if (Schema.is(ApiError)(vendors)) return yield* vendors;
          const agora = clientOf(plainAgora(g.credentials), voice.area, runHere, options.fetch);
          const session = agentFor(agora, forCall, vendors).createSession({
            channel,
            agentUid: voiceAgentUid,
            remoteUids: [uid],
            idleTimeout: voice.idleSeconds,
            expiresIn: tokenSeconds,
          });
          const pending = session.start();
          yield* Scope.addFinalizer(
            callScope,
            Effect.suspend(() => {
              if (callCommitted) return Effect.void;
              return Effect.sync(() => {
                forkHere(
                  Effect.tryPromise({ try: () => pending, catch: callStepFailed }).pipe(
                    Effect.option,
                    Effect.flatMap((joined) =>
                      Option.isNone(joined)
                        ? Effect.void
                        : Effect.tryPromise({ try: () => agora.stopAgent(joined.value), catch: callStepFailed }).pipe(
                            bestEffort("vibevalley: voice: the late agent could not be stopped"),
                          ),
                    ),
                  ),
                );
              });
            }),
          );
          const id = yield* Effect.tryPromise({
            try: () => pending,
            catch: (e) => failed(t("server.voice.joinFailed", { why: messageOf(e) })),
          });
          if (stopped || grants.get(key) !== g) return yield* unavailable(t("server.voice.stopped"));
          g.phase = { _tag: "on", agent: id };
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
            scope: callScope,
            hungUp,
            quick: callLine === undefined,
            greeting: forCall.greeting.trim(),
          });
          callCommitted = true;
          if (about) tell([], about);
          return { agentId: id };
        });
        const agent = yield* started.pipe(Effect.onExit((exit) => (Exit.isFailure(exit) && !callCommitted ? Scope.close(callScope, exit) : Effect.void)));
        yield* core.did({ kind: "talked" });
        return agent;
      }),
      stop: Effect.fn("Voice.stop")(function* (agentId) {
        const call = calls.get(agentId);
        if (call?.kind === "moss") {
          grants.delete(call.grant);
          yield* hangUp(call);
          calls.delete(agentId);
          return;
        }
        if (!call && agentId.startsWith("moss-")) return;
        let client: AgoraClient;
        if (call && call.client) {
          grants.delete(call.grant);
          yield* Deferred.succeed(call.hungUp, undefined);
          client = call.client;
        } else {
          const credentials = yield* creds();
          client = clientOf(plainAgora(credentials), settings.voice().area, runHere, options.fetch);
        }
        const stopping = Effect.tryPromise({
          try: () => client.stopAgent(agentId),
          catch: callStepFailed,
        }).pipe(Effect.catch((e) => (alreadyStopping(e.cause) ? Effect.void : Effect.fail(failed(t("server.voice.leaveFailed", { why: messageOf(e) }))))));
        yield* Effect.ensuring(stopping, call ? hangUp(call) : Effect.void);
        calls.delete(agentId);
      }),
      heard,
      heardCurrent: Effect.fn("Voice.heardCurrent")(function* (text, picked, sendKey) {
        const live = [...calls].filter(([, c]) => !ending(c));
        if (live.length > 1) return yield* failed(t("server.voice.manyCalls"));
        const [only] = live;
        if (!only) return yield* failed(t("server.voice.noCall"));
        return yield* heard(only[0], text, picked, sendKey);
      }),
      said: Effect.fn("Voice.said")(function* (agentId, text) {
        const call = yield* callOf(agentId);
        if (call.quick && text.trim() !== call.greeting)
          yield* Effect.ignore(chat.post({ _tag: "Call", from: defaultOrchestrator, text: text, sendKey: "" }), {
            log: "Warn",
            message: "vibevalley: voice: the orchestrator's spoken words were not kept",
          });
      }),
      verifyMoss: Effect.fn("Voice.verifyMoss")(function* () {
        const connection = yield* provider.live().pipe(Effect.option);
        if (connection._tag === "None") return { problem: t("server.voice.moss.noKey") };
        const r = yield* connection.value.realtime.verify(options.moss);
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
        return { run: (page: Socket.Socket) => relay(page, lineOf(connection)) };
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
                  activeMoss ??= waitingLine();
                  return activeMoss;
                }),
                (target) =>
                  Effect.suspend(() => {
                    if (!target) return Effect.void;
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
                    return Effect.forEach(closingCalls, hangUp, { discard: true });
                  }),
              );
              if (!acquired) {
                const writer = yield* page.writer;
                // Socket.writer blocks until page.reader has been acquired, even when closing immediately.
                yield* page.reader.pipe(
                  Effect.andThen(() => writer.write(new Socket.CloseEvent(1013, "Live session already open"))),
                  Effect.ignore({ log: "Debug" }),
                );
                return;
              }
              const forkMoss = yield* FiberSet.makeRuntime();
              yield* relay(page, lineOf(connection), {
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
                  if (decoded._tag === "None" || decoded.value.action !== "session.update") return data;
                  // Inject persona and ask_orchestrator tool when a farm MOSS call is active.
                  const v = settings.voice();
                  if (v.answer.vendor !== "moss" && ![...calls.values()].some((c) => c.kind === "moss" && !ending(c))) return data;
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
                    forkMoss(
                      response.brief(toolCall.question).pipe(
                        Effect.orElseSucceed(() => t("server.voice.moss.toolFailed")),
                        Effect.tap((answer) =>
                          Effect.sync(() => {
                            if (!active || acquired.phase._tag === "closed") return;
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
              });
            }),
        };
      }),
      dictate: Effect.fn("Voice.dictate")(function* (audio64, given) {
        const connection = yield* provider.dictation().pipe(Effect.mapError((error) => unavailable(error.reason, "dictation")));
        const input = yield* transcriptionAudio(audio64, given).pipe(Effect.mapError(mapTranscriptionFailure));
        const selected = yield* connection.transcriber(input.format);
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
