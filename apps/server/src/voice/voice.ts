import { type AgoraClient } from "agora-agents";
import { type Cause, Clock, Context, Effect, Fiber, FiberSet, Layer, Queue, Schema, type Scope, Stream } from "effect";
import { HttpBody, HttpClient, type HttpClientError } from "effect/http";
import type { Socket } from "effect/socket";

import { t } from "@vibevalley/i18n";
import { type AgoraGrant, type Dictated, defaultOrchestrator, type Validation, type VoiceCall } from "@vibevalley/protocol";
import { type ApiError } from "@vibevalley/protocol/api";

import { messageOf } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Inbox } from "#/inbox/inbox.ts";
import { ServerConfig } from "#/infra/config.ts";
import { bestEffort, callbackLog } from "#/infra/log.ts";
import { Ingress } from "#/ingress/ingress.ts";
import { Orchestrator } from "#/orchestrator/orchestrator.ts";
import { type AgoraCredentials, Setting } from "#/setting/setting.ts";

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
  type Run,
  sign,
  speakPieces,
  tokenSeconds,
  unavailable,
  vendorsFor,
  voiceAgentUid,
  voiceUnknown,
} from "./agora.ts";
import { type LineFailed, makeVoiceLine, type Tunnel, tunnelAnswers } from "./line.ts";
import { type MossTransport, mossTranscription, relay, verifyMoss } from "./moss.ts";
import { noticeLine, onCallLine } from "./prompts.ts";

export {
  agentFor,
  type CallLine,
  clientOf,
  retrying,
  type Run,
  speakPieces,
  tokenSeconds,
  tunnelAnswers,
  vendorsFor,
  voiceAgentUid,
  voiceUnknown,
};

/** Succeeds once the signal aborts. */
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const done = () => resume(Effect.void);
    signal.addEventListener("abort", done, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", done));
  });

/** OpenAI's own cap on one recording. */
const dictateMaxBytes = 25 << 20;
const dictateFormats: Record<string, string> = {
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
};
const DictationResponse = Schema.fromJsonString(
  Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  }),
);

/** What an HTTP call's failure says to the owner: the network's own words (refused, reset), not the client's wrapper. */
const causeText = (e: HttpClientError.HttpClientError | Cause.TimeoutError) =>
  e._tag === "HttpClientError" && "cause" in e.reason && e.reason.cause !== undefined ? messageOf(e.reason.cause) : e.message;

interface Grant {
  readonly credentials: AgoraCredentials;
  expires: number;
  starting: boolean;
  agent: string;
}

/** A call's agent session: what it says goes through it, with the session's own ConvoAI token. */
type CallSession = ReturnType<ReturnType<typeof agentFor>["createSession"]>;

interface Call {
  readonly grant: string;
  readonly client: AgoraClient;
  readonly session: CallSession;
  readonly release: () => void;
  /** Agora's model answers, so its words reach the default channel only through said; the orchestrator's own reach it as it says them. */
  readonly quick: boolean;
  /** Said at every pickup; not worth keeping in the chat. */
  readonly greeting: string;
  readonly life: AbortController;
  ending: boolean;
}

export class Voice extends Context.Service<
  Voice,
  {
    readonly session: () => Effect.Effect<AgoraGrant, ApiError>;
    readonly renew: (channel: string, uid: string) => Effect.Effect<AgoraGrant, ApiError>;
    /** about: what rang, when the call answers a ring: the orchestrator says it first, in place of the greeting. */
    readonly start: (channel: string, uid: string, about?: string) => Effect.Effect<VoiceCall, ApiError>;
    readonly stop: (agentId: string) => Effect.Effect<void, ApiError>;
    /** What the owner said on a call: the orchestrator overhears it when Agora's model answers. */
    readonly heard: (agentId: string, text: string, picked: string, sendKey: string) => Effect.Effect<void, ApiError>;
    /** The relay without a call id: the one call on. */
    readonly heardCurrent: (text: string, picked: string, sendKey: string) => Effect.Effect<void, ApiError>;
    readonly said: (agentId: string, text: string) => Effect.Effect<void, ApiError>;
    readonly dictate: (audio: string, format: string) => Effect.Effect<Dictated, ApiError>;
    /** Whether MOSS Live takes the key given, or the saved one: the reason it does not, in the owner's words. */
    readonly verifyMoss: (key: string) => Effect.Effect<Validation>;
    /** Why a page cannot have a line to MOSS Live now (no key saved), in the owner's words; undefined when it can. */
    readonly mossProblem: () => string | undefined;
    /** A page's line to MOSS Live (moss.ts relay), with the saved key, until either side closes. */
    readonly mossLine: (page: Socket.Socket) => Effect.Effect<void, never, Scope.Scope>;
    /** The keys of the lines open now, by call. */
    readonly lines: () => number;
    /** Words read out on the call that is on, queued after what is being said; false when no call is on. */
    readonly speak: (text: string) => Effect.Effect<boolean>;
  }
>()("vibevalley/Voice") {
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
    const chat = yield* Channel;
    const ingress = yield* Ingress;
    const response = yield* Orchestrator;
    // Read in callbacks too: the Clock the service was built with.
    const clock = yield* Clock.Clock;
    const httpClient = yield* HttpClient.HttpClient;
    // Fibers started from callbacks belong to this service: they end with it, and sleep on its Clock.
    const forkHere = yield* FiberSet.makeRuntime();
    const runHere: Run = yield* FiberSet.makeRuntimePromise();
    const now = () => clock.currentTimeMillisUnsafe();

    const grants = new Map<string, Grant>();
    const calls = new Map<string, Call>();
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

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopped = true;
        for (const call of calls.values()) call.life.abort();
        calls.clear();
        grants.clear();
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
        // Through the session: a bare agents.speak carries no token, and Agora answers 401.
        for (const piece of speakPieces(text)) {
          if (stopped || call.ending || calls.get(agentId) !== call) return false;
          yield* Effect.tryPromise({
            try: () => call.session.say(piece, { priority: "APPEND", interruptable: true }),
            catch: callStepFailed,
          });
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

    // What is to be told on the call waits in one queue, read by one fiber, so that it never crowds itself: a round gathers
    // for gatherMs, then asks one answer of everything that waited. A round ends when nothing more waits, the call ends or
    // three answers in a row are empty; what still waits then is dropped.
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
        // The call ending ends the wait for the brief (not the orchestrator's run).
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

    // What came into the inbox: with a call on, the orchestrator says it on the call; with none, the page's phone rings
    // with the same items.
    yield* Effect.forkScoped(
      Stream.runForEach(yield* inbox.news, (items) =>
        Effect.sync(() => {
          if (liveCall()) tell(items.map((i) => noticeLine(i.words.title, i.words.body)));
        }),
      ),
    );

    const heard = Effect.fn("Voice.heard")(function* (agentId: string, text: string, picked: string, sendKey: string) {
      const call = yield* callOf(agentId);
      // Both transcript directions use the answer mode captured by this call, never the current settings.
      if (!call.quick) return;
      yield* ingress.owner({ source: "voice", text, envelope: sendKey, ...(picked ? { picked: { agent: picked } } : {}) });
    });

    return Voice.of({
      session: Effect.fn("Voice.session")(function* () {
        const c = yield* creds();
        const channel = newChannel(yield* Clock.currentTimeMillis);
        const uid = newUid();
        const issued = yield* Effect.try({
          try: () => sign(c, channel, uid),
          catch: (e) => unavailable(t("server.voice.noToken", { why: messageOf(e) })),
        });
        if (stopped) return yield* Effect.fail(unavailable(t("server.voice.stopped")));
        prune();
        grants.set(keyOf(channel, uid), {
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
            // Opened on the service's fibers: a start given up on still closes a line that opens late.
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
          // Answering a ring, the orchestrator's first words are what rang: no greeting before them.
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
            grant: key,
            client: agora,
            session,
            release,
            quick: callLine === undefined,
            greeting: forCall.greeting.trim(),
            // The call's life spans its fibers (the answer it waits on, the words it reads out): ended when the call ends.
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
              if (opening && !callLine) forkHere(Effect.ignore(Effect.map(Fiber.join(opening), (opened) => voiceLine.close(opened.id)), { log: "Debug" }));
              const pending = starting;
              const agora = client;
              // An agent that joins after its start was given up on is stopped; one that never joined has nothing to stop.
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
      // A call keeps the client it started with, even when settings change before hangup.
      stop: Effect.fn("Voice.stop")(function* (agentId) {
        const call = calls.get(agentId);
        let client: AgoraClient;
        if (call) {
          grants.delete(call.grant);
          call.ending = true;
          call.life.abort();
          client = call.client;
        } else client = clientOf(yield* creds(), settings.voice().area, runHere, options.fetch);
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
      // Only a call still on, that Agora's model answers: a late turn after hangup, or the orchestrator's words, are not kept twice.
      said: Effect.fn("Voice.said")(function* (agentId, text) {
        const call = yield* callOf(agentId);
        if (call.quick && text.trim() !== call.greeting)
          yield* Effect.ignore(chat.spoken(defaultOrchestrator, text, ""), {
            log: "Warn",
            message: "vibevalley: voice: the orchestrator's spoken words were not kept",
          });
      }),
      verifyMoss: Effect.fn("Voice.verifyMoss")(function* (given) {
        const key = given.trim() || settings.mossKey();
        if (key === "") return { problem: t("server.voice.moss.noKey") };
        const r = yield* verifyMoss(key, options.moss);
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
      mossProblem: () => (settings.mossKey() === "" ? t("server.voice.moss.noKey") : undefined),
      mossLine: Effect.fn("Voice.mossLine")(function* (page) {
        return yield* relay(page, settings.mossKey(), options.moss);
      }),
      dictate: Effect.fn("Voice.dictate")(function* (audio64, given) {
        const d = settings.dictation();
        if (!d) return yield* Effect.fail(unavailable(t("server.voice.dictation.unset"), "dictation"));
        if (d.via === "moss" && d.key === "") return yield* Effect.fail(unavailable(t("server.voice.dictation.noMossKey"), "dictation"));
        const { url, model } = d.via === "moss" ? mossTranscription : d;
        const format = given.trim().replace(/^\./u, "").toLowerCase();
        const kind = dictateFormats[format];
        if (!kind)
          return yield* Effect.fail<ApiError>({
            _tag: "Refused",
            reason: t("server.voice.dictation.format", { format: JSON.stringify(format) }),
          });
        const audio = Buffer.from(audio64, "base64");
        if (audio.length === 0 || audio.toString("base64").replace(/=+$/u, "") !== audio64.replace(/=+$/u, "").replace(/\s/gu, ""))
          return yield* Effect.fail<ApiError>({
            _tag: "Refused",
            reason: t("server.voice.dictation.empty"),
          });
        if (audio.length > dictateMaxBytes)
          return yield* Effect.fail<ApiError>({
            _tag: "Refused",
            reason: t("server.voice.dictation.tooLong"),
          });
        const form = new FormData();
        form.append("file", new Blob([audio], { type: kind }), `dictation.${format}`);
        form.append("model", model);
        form.append("response_format", "json");
        // A local model's first request loads it, which takes a while.
        // An interrupted dictation (the page went away) stops its upload, as the timeout does.
        const res = yield* httpClient
          .post(url + "/audio/transcriptions", { headers: d.key ? { authorization: "Bearer " + d.key } : {}, body: HttpBody.formData(form) })
          .pipe(
            Effect.timeout("120 seconds"),
            Effect.mapError((e) => unavailable(t("server.voice.dictation.unreachable", { why: causeText(e) }), "dictation")),
          );
        const raw = (yield* res.text.pipe(Effect.mapError((e) => unavailable(t("server.voice.dictation.cut", { why: causeText(e) }), "call")))).slice(
          0,
          1 << 20,
        );
        const got = Schema.decodeOption(DictationResponse)(raw);
        const detail = got._tag === "Some" ? got.value.error?.message : undefined;
        if (res.status < 200 || res.status >= 300)
          return yield* Effect.fail(
            unavailable(t("server.voice.dictation.status", { status: res.status, detail: [...(detail || raw.trim())].slice(0, 200).join("") })),
          );
        if (got._tag === "None") return yield* Effect.fail(unavailable(t("server.voice.dictation.shape")));
        return { text: (got.value.text ?? "").trim() };
      }),
      lines: voiceLine.lines,
      speak: Effect.fn("Voice.speak")(function* (text) {
        const on = liveCall();
        return on ? yield* speakOn(on, text) : false;
      }),
    });
  });
