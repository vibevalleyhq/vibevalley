// The owner's calls: Agora RTC grants, the voice agent Agora runs for a call, the voice line the
// orchestrator answers it on, and dictation. A grant is signed for one channel and uid and lives as long as its token, or the
// call it starts; a call keeps the credentials and the area it started with, whatever the settings say later. The line
// listens on loopback, reachable from outside only through its tunnel, and answers one endpoint, with each call's own key.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Agent, AgoraClient, Area as AgoraArea, AresSTT, DeepgramSTT, MicrosoftSTT, MicrosoftTTS, MiniMaxTTS, OpenAI, OpenAITTS } from "agora-agents";
import agoraToken from "agora-token";
import { type Cause, Clock, Context, Data, Effect, Fiber, FiberSet, Layer, Predicate, Schema, type Scope, Semaphore, Stream } from "effect";
import { HttpBody, HttpClient, type HttpClientError, HttpEffect } from "effect/http";
import type { Socket } from "effect/socket";

import { t } from "@vibevalley/i18n";
import { type AgoraGrant, type Area, type Validation, type Dictated, defaultOrchestrator, type VoiceCall, type VoiceSettings } from "@vibevalley/protocol";
import { type ApiError, type VoiceFix, type VoiceUnavailable } from "@vibevalley/protocol/api";

import { ServerConfig } from "@/base/config.ts";
import { callbackLog, bestEffort } from "@/base/log.ts";
import { afterRealTime } from "@/base/time.ts";
import { Channels } from "@/channel/chat.ts";
import { Core } from "@/core/core.ts";
import { messageOf, errnoOf } from "@/errors.ts";
import { Notices } from "@/notice/notice.ts";
import { orchestratorModel } from "@/orchestrator/model.ts";
import { chatCompletions } from "@/orchestrator/openai.ts";
import { Orchestrator } from "@/orchestrator/orchestrator.ts";
import { type AgoraCredentials, Setting, type VoiceKeys } from "@/setting/setting.ts";

import { verifyMoss, type MossTransport, mossTranscription, relay } from "./moss.ts";
import { noticeLine, onCallLine } from "./prompts.ts";

/** Succeeds once the signal aborts. */
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const done = () => resume(Effect.void);
    signal.addEventListener("abort", done, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", done));
  });
const { RtcRole, RtcTokenBuilder } = agoraToken;

/** A page renews tokens before they run out. */
export const tokenSeconds = 3600;
export const voiceAgentUid = "123456";
const deepseekChat = "https://api.deepseek.com/chat/completions";
/** A new quick tunnel's address takes a while to answer (seen: about 25 s). */
const lineReadyMs = 60_000;
/** So calling again does not wait for a new tunnel. */
const lineLingerMs = 10 * 60_000;
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

/** settings: the 设置 section the owner fixes it in, when a setting does; the page offers to go there. */
const unavailable = (reason: string, settings?: VoiceFix): VoiceUnavailable => ({
  _tag: "VoiceUnavailable",
  reason,
  ...(settings ? { settings } : {}),
});
/** A step of a call outside the farm (Agora, the orchestrator's answer) that did not go; cause is what it threw. */
class CallStepFailed extends Data.TaggedError("CallStepFailed")<{ readonly message: string; readonly cause: unknown }> {}

const callStepFailed = (cause: unknown) => new CallStepFailed({ message: messageOf(cause), cause });

/** What an HTTP call's failure says to the owner: the network's own words (refused, reset), not the client's wrapper. */
const causeText = (e: HttpClientError.HttpClientError | Cause.TimeoutError) =>
  e._tag === "HttpClientError" && "cause" in e.reason && e.reason.cause !== undefined ? messageOf(e.reason.cause) : e.message;

const failed = (reason: string): ApiError => ({ _tag: "VoiceCallFailed", reason });

export interface CallLine {
  readonly id: string;
  readonly url: string;
  readonly key: string;
}

/** For a member added to the union and not to vendorsFor. */
export const voiceUnknown = () => t("server.voice.unknownSuffix");

type Vendors = {
  stt: AresSTT | DeepgramSTT | MicrosoftSTT;
  llm: OpenAI;
  tts: MiniMaxTTS | OpenAITTS | MicrosoftTTS;
};

/** The three vendors the voice page chose, or why they cannot be: a vendor whose key is missing. Agora-hosted ones need
 * no key of their own. line undefined: the orchestrator does not answer the call itself. */
export function vendorsFor(voice: VoiceSettings, keys: VoiceKeys, deepseekKey: string, line?: CallLine): Vendors | VoiceUnavailable {
  const speech = {
    greetingMessage: voice.greeting,
    failureMessage: voice.failureMessage,
    maxHistory: 15,
    params: { max_tokens: 512, temperature: 0.7, top_p: 0.95 },
    ...(voice.persona ? { systemMessages: [{ role: "system", content: voice.persona }] } : {}),
  };
  try {
    let stt: Vendors["stt"];
    const asr = voice.asr;
    switch (asr.vendor) {
      case "ares":
        stt = new AresSTT();
        break;
      case "deepgram":
        stt = new DeepgramSTT({ model: asr.model, language: voice.language });
        break;
      case "microsoft":
        if (!keys.asrKey) return unavailable(t("server.voice.noAsrKey"), "call");
        stt = new MicrosoftSTT({ key: keys.asrKey, region: asr.region, language: voice.language });
        break;
      default: {
        const exhaustive: never = asr;
        return unavailable(t("server.voice.unknown", { what: t("server.voice.part.asr"), vendor: (exhaustive as { vendor: string }).vendor }));
      }
    }
    let llm: OpenAI;
    const answer = voice.answer;
    switch (answer.vendor) {
      case "orchestrator":
        if (!line) return unavailable(t("server.voice.noLine"));
        llm = new OpenAI({ apiKey: line.key, url: line.url, model: orchestratorModel, ...speech });
        break;
      case "agora":
        llm = new OpenAI({ model: answer.model, ...speech });
        break;
      case "deepseek":
        if (!deepseekKey) return unavailable(t("server.voice.noDeepseekKey"), "models");
        llm = new OpenAI({
          apiKey: deepseekKey,
          url: deepseekChat,
          model: answer.model,
          ...speech,
        });
        break;
      case "openai":
        if (!keys.llmKey) return unavailable(t("server.voice.noLlmKey"), "call");
        llm = new OpenAI({ apiKey: keys.llmKey, url: answer.url, model: answer.model, ...speech });
        break;
      default: {
        const exhaustive: never = answer;
        return unavailable(t("server.voice.unknown", { what: t("server.voice.part.llm"), vendor: (exhaustive as { vendor: string }).vendor }));
      }
    }
    let tts: Vendors["tts"];
    const item = voice.tts;
    switch (item.vendor) {
      case "minimax":
        tts = new MiniMaxTTS({ model: item.model, voiceId: item.voiceId });
        break;
      case "openai":
        tts = new OpenAITTS({ voice: item.voice });
        break;
      case "microsoft":
        if (!keys.ttsKey) return unavailable(t("server.voice.noTtsKey"), "call");
        tts = new MicrosoftTTS({ key: keys.ttsKey, region: item.region, voiceName: item.voiceName });
        break;
      default: {
        const exhaustive: never = item;
        return unavailable(t("server.voice.unknown", { what: t("server.voice.part.tts"), vendor: (exhaustive as { vendor: string }).vendor }));
      }
    }
    return { stt, llm, tts };
  } catch (e) {
    // The SDK throws on a configuration it refuses; that is a problem with the settings, not the server's.
    return unavailable(t("server.voice.unusable", { why: messageOf(e) }), "call");
  }
}

const areaOf = (area: Area) => ({ US: AgoraArea.US, EU: AgoraArea.EU, AP: AgoraArea.AP, CN: AgoraArea.CN } as const)[area];

/** Agora's REST calls retried as its SDK would on its own (408, 429 and 5xx, twice: what Retry-After says, else 1 s
 * then 2 s), but sleeping on time: the SDK's retries wait on real time, out of reach of the service's Clock. */
export const retrying =
  (fetcher: typeof fetch, run: Run): typeof fetch =>
  (input, init) =>
    run(
      Effect.gen(function* () {
        for (let attempt = 0; ; attempt++) {
          // A failed fetch goes back to the SDK as it is: it rejects the SDK's call, as the fetch itself would.
          const res = yield* Effect.promise(() => fetcher(input, init));
          if (attempt >= 2 || !([408, 429].includes(res.status) || res.status >= 500)) return res;
          const after = Number(res.headers.get("Retry-After"));
          yield* Effect.sleep(after > 0 ? Math.min(after * 1000, 60_000) : 1000 * 2 ** attempt);
        }
      }),
      init?.signal ? { signal: init.signal } : undefined,
    );

/** Runs an Effect for the Promise side (the Agora SDK's fetch) on the service's fibers, so its sleeps are on its Clock. */
export type Run = <A>(effect: Effect.Effect<A>, options?: { readonly signal: AbortSignal }) => Promise<A>;

export const clientOf = (c: AgoraCredentials, area: Area, run: Run, fetcher: typeof fetch = fetch) =>
  new AgoraClient({
    area: areaOf(area),
    appId: c.appId,
    appCertificate: c.appCertificate,
    maxRetries: 0,
    fetch: retrying(fetcher, run),
  });

/** Read at each start: a change takes effect on the next call. Captions go over the RTC data stream: the client has no RTM. */
export function agentFor(client: AgoraClient, voice: VoiceSettings, vendors: Vendors) {
  return new Agent({
    client,
    turnDetection: {
      language: voice.language,
      config: {
        speech_threshold: 0.5,
        start_of_speech: {
          mode: "vad",
          vad_config: { interrupt_duration_ms: voice.interruptMs, prefix_padding_ms: 300 },
        },
        end_of_speech: { mode: "vad", vad_config: { silence_duration_ms: voice.silenceMs } },
      },
    },
    // RTM carries transcripts and the agent's state; a client without RTM asks for the RTC data stream, which carries
    // the transcripts (chunked); RTM is then off, or the agent keeps sending to RTM and nothing reaches the data stream.
    advancedFeatures: { enable_rtm: false, enable_tools: true },
    parameters: {
      audio_scenario: "chorus",
      data_channel: "datastream",
      enable_error_message: true,
      enable_metrics: true,
    },
  })
    .withStt(vendors.stt)
    .withLlm(vendors.llm)
    .withTts(vendors.tts);
}

/** Already left or leaving counts as success, as the quickstart treats it. */
function alreadyStopping(e: unknown): boolean {
  if (!Predicate.isObject(e)) return false;
  if ("statusCode" in e && e.statusCode === 404) return true;
  const body = "body" in e && Predicate.isObject(e.body) ? e.body : {};
  const said = [Reflect.get(body, "detail"), Reflect.get(body, "reason"), "message" in e ? e.message : undefined];
  return said.some((s) => typeof s === "string" && s.toLowerCase().includes("already in the process of shutting down"));
}

const sign = (c: AgoraCredentials, channel: string, uid: string): AgoraGrant => ({
  appId: c.appId,
  channel,
  uid,
  token: RtcTokenBuilder.buildTokenWithRtm(c.appId, c.appCertificate, channel, uid, RtcRole.PUBLISHER, tokenSeconds, tokenSeconds),
});

/** prefix-<ms>-<6 random>: the quickstart's timestamp-plus-random shape. */
const newChannel = (now: number) => `vibevalley-${now}-${Array.from({ length: 6 }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[randomInt(36)]).join("")}`;
const newUid = () => String(randomInt(9_999_000) + 1000);

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

/** Agora reads out at most 512 bytes at a time: the words in pieces under that, cut after a sentence where one ends. */
export function speakPieces(text: string, max = 480): string[] {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const out: string[] = [];
  let rest = text.trim();
  while (rest !== "") {
    if (bytes(rest) <= max) {
      out.push(rest);
      break;
    }
    const chars = [...rest];
    let fit = 0;
    let used = 0;
    while (fit < chars.length && used + bytes(chars[fit]!) <= max) used += bytes(chars[fit++]!);
    const head = chars.slice(0, fit).join("");
    const end = Math.max(-1, ...[...head.matchAll(/[。！？!?；;\n]/gu)].map((m) => m.index));
    const cut = end > 0 ? [...head.slice(0, end + 1)].length : fit;
    out.push(chars.slice(0, cut).join("").trim());
    rest = chars.slice(cut).join("").trim();
  }
  return out.filter(Boolean);
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

const quickTunnel = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u;

/** A tunnel's public address and how to close it. */
export interface Tunnel {
  readonly url: string;
  readonly close: () => void;
}

/** Why the voice line cannot be had now; the message is the owner's. */
class LineFailed extends Data.TaggedError("LineFailed")<{ readonly message: string }> {}

const cloudflared = (port: number) =>
  Effect.callback<Tunnel, LineFailed>((resume) => {
    let child: ChildProcess;
    try {
      child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resume(Effect.fail(new LineFailed({ message: messageOf(e) })));
    }
    const close = () => child.kill();
    let settled = false;
    const settle = (e: Effect.Effect<Tunnel, LineFailed>) => {
      if (settled) return;
      settled = true;
      cancel();
      resume(e);
    };
    const failWith = (message: string) => settle(Effect.fail(new LineFailed({ message })));
    // A real process: its deadline is real time.
    const cancel = afterRealTime(30_000, () => {
      close();
      failWith(t("server.voice.tunnel.timedOut"));
    });
    // cloudflared says its address on either stream; both are read until it exits, so it never blocks on a write.
    const read = (b: Buffer) => {
      const url = quickTunnel.exec(b.toString())?.[0];
      if (url) settle(Effect.succeed({ url, close }));
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (e) => failWith(errnoOf(e) === "ENOENT" ? t("server.voice.tunnel.missing") : e.message));
    child.on("exit", () => failWith(t("server.voice.tunnel.exited")));
    // Given up on before it said its address: the process goes too.
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      cancel();
      close();
    });
  });

/** The line refusing a keyless request counts as an answer. Asked over the real network. */
const tunnelAnswers = (client: HttpClient.HttpClient, url: string) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + lineReadyMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const res = yield* client.post(url + "/llm/ready/chat/completions").pipe(Effect.timeout("5 seconds"), Effect.option);
      if (res._tag === "Some" && res.value.status === 401) return true;
      yield* Effect.sleep(2_000);
    }
    return false;
  });

const make = (options: VoiceOptions = {}) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    const config = yield* ServerConfig;
    const core = yield* Core;
    const notices = yield* Notices;
    const settings = yield* Setting;
    const chat = yield* Channels;
    const orchestrator = yield* Orchestrator;
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

    // The voice line: local only, like the farm; the tunnel is the one way in from outside.
    const keys = new Map<string, string>();
    let line = false;
    let linePort = config.voice.line.port;
    let lineProblem = "";
    let tunnel: Tunnel | undefined;
    /** What cancels closing the tunnel, lineLingerMs after the last call. */
    let closing: (() => void) | undefined;
    const answer = chatCompletions({
      answerer: orchestrator.answerer("phone"),
      misheard: t("server.voice.misheard"),
      log: (l) => logs.info(l),
      now: () => clock.currentTimeMillisUnsafe(),
    });
    const route = /^\/llm\/([\w-]+)\/chat\/completions$/u;
    // A call's own key on its own path; anything else is not there or not let in.
    const lineHandler = (request: Request): Promise<Response> => {
      const m = route.exec(new URL(request.url).pathname);
      if (request.method !== "POST" || !m) return Promise.resolve(new Response(null, { status: 404 }));
      const key = keys.get(m[1]!);
      if (!key || request.headers.get("authorization") !== "Bearer " + key)
        return Promise.resolve(Response.json({ error: { message: "unauthorized" } }, { status: 401 }));
      return answer(request).catch(() => new Response(null, { status: 502 }));
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopped = true;
        for (const call of calls.values()) call.life.abort();
        calls.clear();
        grants.clear();
        keys.clear();
        closing?.();
        tunnel?.close();
        tunnel = undefined;
      }),
    );
    const server = createServer();
    const listened = yield* Effect.result(NodeHttpServer.make(() => server, { host: "127.0.0.1", port: linePort }));
    if (listened._tag === "Failure") {
      lineProblem = t("server.voice.lineDown", { why: messageOf(listened.failure.cause) });
      yield* Effect.logError(`vibevalley: the voice line cannot listen on 127.0.0.1:${linePort}: ${messageOf(listened.failure.cause)}`);
    } else {
      const http = listened.success;
      if (http.address._tag !== "UnixPathAddress") linePort = http.address.port;
      yield* http.serve(HttpEffect.fromWebHandler(lineHandler));
      // Its close waits for every socket: an answer still streaming is cut first.
      yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()));
      line = true;
    }

    const openTunnel =
      options.tunnel ??
      ((port: number) =>
        Effect.tap(cloudflared(port), (item) =>
          Effect.flatMap(tunnelAnswers(httpClient, item.url), (answers) =>
            answers ? Effect.void : Effect.logInfo(`vibevalley: the voice line's tunnel ${item.url} does not answer yet; the call goes on`),
          ),
        ));
    // Opening a tunnel waits for it to answer, through this very line: one opening at a time.
    const opening = yield* Semaphore.make(1);
    const lineClosed = () => new LineFailed({ message: t("server.voice.lineClosed") });
    const base = Effect.suspend(() => {
      if (config.voice.line.url) return Effect.succeed(config.voice.line.url.replace(/\/+$/u, ""));
      closing?.();
      closing = undefined;
      return opening.withPermits(1)(
        Effect.gen(function* () {
          if (tunnel) return tunnel.url;
          const item = yield* openTunnel(linePort);
          if (stopped) {
            item.close();
            return yield* lineClosed();
          }
          tunnel = item;
          return item.url;
        }),
      );
    });
    const openLine = Effect.gen(function* () {
      if (stopped) return yield* lineClosed();
      if (lineProblem) return yield* new LineFailed({ message: lineProblem });
      if (!line) return yield* new LineFailed({ message: t("server.voice.lineNotOpen") });
      const url = yield* base;
      if (stopped) return yield* lineClosed();
      const id = randomBytes(8).toString("hex");
      const key = randomBytes(24).toString("base64url");
      keys.set(id, key);
      return { id, key, url: url + "/llm/" + id + "/chat/completions" } satisfies CallLine;
    });
    const closeLine = (id: string) => {
      keys.delete(id);
      if (keys.size > 0 || !tunnel) return;
      closing?.();
      const lingering = forkHere(
        Effect.sleep(lineLingerMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              closing = undefined;
              if (keys.size > 0 || !tunnel) return;
              tunnel.close();
              tunnel = undefined;
            }),
          ),
        ),
      );
      closing = () => lingering.interruptUnsafe();
    };

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

    // What is to be told on the call waits in one queue, so that it never crowds itself: the orchestrator is asked once at a
    // time, with everything that came meanwhile (after gatherMs, for what comes together), and its answer is read out
    // (queued after what is being said) before it is asked again. With no call on, what waits is dropped: it is on the
    // phone and in the inbox. An answer with no words puts its things back. A failed ask ends this pass rather than
    // repeating an input the orchestrator may already have taken.
    const gatherMs = options.gatherMs ?? 3000;
    const waiting: string[] = [];
    let rang: string | undefined;
    let telling = false;
    const drain = Effect.gen(function* () {
      for (let tries = 0; (waiting.length > 0 || rang) && tries < 3;) {
        yield* Effect.sleep(gatherMs);
        const on = liveCall();
        const call = on ? calls.get(on) : undefined;
        if (!on || !call || stopped) break;
        const texts = waiting.splice(0);
        const ring = rang;
        rang = undefined;
        // The call ending ends the wait for the brief (not the orchestrator's run).
        const said = yield* orchestrator.brief(onCallLine(texts, ring)).pipe(
          Effect.mapError(callStepFailed),
          Effect.raceFirst(Effect.as(aborted(call.life.signal), undefined)),
          Effect.catch((e) => (stopped || call.ending || calls.get(on) !== call ? Effect.succeed(undefined) : Effect.fail(e))),
        );
        if (said === undefined || stopped || call.ending || calls.get(on) !== call) break;
        if (said) {
          tries = 0;
          yield* speakOn(on, said);
        } else {
          tries++;
          waiting.unshift(...texts);
          if (ring) rang ??= ring;
        }
      }
    }).pipe(
      Effect.catch((e) => Effect.sync(() => logs.warn("vibevalley: voice: the update could not be told: " + messageOf(e)))),
      Effect.ensuring(
        Effect.sync(() => {
          waiting.length = 0;
          rang = undefined;
          telling = false;
        }),
      ),
    );
    const tell = (texts: readonly string[], ring?: string) => {
      if (stopped) return;
      waiting.push(...texts);
      if (ring) rang = ring;
      if (telling) return;
      telling = true;
      forkHere(drain);
    };

    // What came into the inbox: with a call on, the orchestrator says it on the call; with none, the page's phone rings
    // with the same items.
    yield* Effect.forkScoped(
      Stream.runForEach(yield* notices.news, (items) =>
        Effect.sync(() => {
          if (liveCall()) tell(items.map((i) => noticeLine(i.words.title, i.words.body)));
        }),
      ),
    );

    const heard = Effect.fn("Voice.heard")(function* (agentId: string, text: string, picked: string, sendKey: string) {
      const call = yield* callOf(agentId);
      // Both transcript directions use the answer mode captured by this call, never the current settings.
      if (!call.quick) return;
      yield* orchestrator.heard(text, picked, sendKey);
    });

    return Voice.of({
      session: Effect.fn("Voice.session")(function* () {
        const c = yield* creds();
        const channel = newChannel(clock.currentTimeMillisUnsafe());
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
            const opening = forkHere(openLine);
            openingLine = opening;
            callLine = yield* Fiber.join(opening).pipe(Effect.mapError((e) => unavailable(t("server.voice.lineFailed", { why: e.message }))));
            const opened = callLine;
            let once = false;
            release = () => {
              if (once) return;
              once = true;
              closeLine(opened.id);
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
              if (opening && !callLine) forkHere(Effect.ignore(Effect.map(Fiber.join(opening), (opened) => closeLine(opened.id))));
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
      lines: () => keys.size,
      speak: Effect.fn("Voice.speak")(function* (text) {
        const on = liveCall();
        return on ? yield* speakOn(on, text) : false;
      }),
    });
  });
