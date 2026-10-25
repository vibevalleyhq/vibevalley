// The owner's calls: Agora RTC grants, the voice agent Agora runs for a call, the voice line the
// orchestrator answers it on, and dictation. A grant is signed for one channel and uid and lives as long as its token, or the
// call it starts; a call keeps the credentials and the area it started with, whatever the settings say later. The line
// listens on loopback, reachable from outside only through its tunnel, and answers one endpoint, with each call's own key.

import { randomBytes, randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AgoraGrant, type Area, type Dictated, orchestratorAgent, type VoiceAgent, type VoiceSettings } from "@vibevalley/protocol";
import { type ApiError, Refused, VoiceAgentFailed, type VoiceFix, VoiceUnavailable } from "@vibevalley/protocol/api";
import { Agent, AgoraClient, Area as AgoraArea, AresSTT, DeepgramSTT, MicrosoftSTT, MicrosoftTTS, MiniMaxTTS, OpenAI, OpenAITTS } from "agora-agents";
import agoraToken from "agora-token";
import { Context, Deferred, Effect, Exit, FiberMap, Layer, Scope, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { chatCompletions } from "../agent/brain/openai.ts";
import { Settings } from "../base/config.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { orchestratorModel } from "../orchestrator/rules.ts";
import { Notices } from "../notice/notice.ts";
import { type AgoraCredentials, Setting, type VoiceKeys } from "../setting/setting.ts";
import { callbackLog } from "../base/log.ts";

const { RtcRole, RtcTokenBuilder } = agoraToken;

/** A page renews tokens before they run out. */
export const tokenSeconds = 3600;
export const voiceAgentUid = "123456";
const deepseekChat = "https://api.deepseek.com/chat/completions";
/** A new quick tunnel's address takes a while to answer (seen: about 25 s). */
const lineReadyMs = 60_000;
/** So calling again does not wait for a new tunnel. */
const lineLingerMs = 10 * 60_000;
const lineMisheard = "嗯？我没听清，你再说一遍？";
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

/** settings: the 设置 section the owner fixes it in, when a setting does; the page offers to go there. */
const unavailable = (reason: string, settings?: VoiceFix): VoiceUnavailable => new VoiceUnavailable({ reason, ...(settings ? { settings } : {}) });
const failed = (reason: string): ApiError => new VoiceAgentFailed({ reason });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface CallLine {
  readonly id: string;
  readonly url: string;
  readonly key: string;
}

/** For a member added to the union and not to vendorsFor. */
export const voiceUnknown = "服务端还不会用";

type Vendors = { stt: AresSTT | DeepgramSTT | MicrosoftSTT; llm: OpenAI; tts: MiniMaxTTS | OpenAITTS | MicrosoftTTS };

/** The three vendors the voice page chose, or why they cannot be: a vendor whose key is missing. Agora-hosted ones need
 * no key of their own. line undefined: the orchestrator does not answer the call itself. */
export function vendorsFor(voice: VoiceSettings, keys: VoiceKeys, deepseekKey: string, line?: CallLine): Vendors | VoiceUnavailable {
  const speech = {
    greetingMessage: voice.greeting,
    failureMessage: voice.failureMessage,
    maxHistory: 15,
    params: { max_tokens: 512, temperature: 0.7, top_p: 0.95 },
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
        if (!keys.asrKey) return unavailable("微软识别还没有 key：在声音页的「识别」里填", "voice");
        stt = new MicrosoftSTT({ key: keys.asrKey, region: asr.region, language: voice.language });
        break;
      default:
        return unavailable(`识别用的 ${(asr as { vendor: string }).vendor} ${voiceUnknown}`);
    }
    let llm: OpenAI;
    const answer = voice.answer;
    switch (answer.vendor) {
      case "orchestrator":
        if (!line) return unavailable("管家的语音线路没接通");
        llm = new OpenAI({ apiKey: line.key, url: line.url, model: orchestratorModel, ...speech });
        break;
      case "agora":
        llm = new OpenAI({ model: answer.model, ...speech });
        break;
      case "deepseek":
        if (!deepseekKey) return unavailable("用 DeepSeek 要先有 DeepSeek 的 key：在首页「设置」里填", "deepseek");
        llm = new OpenAI({ apiKey: deepseekKey, url: deepseekChat, model: answer.model, ...speech });
        break;
      case "openai":
        if (!keys.llmKey) return unavailable("自己的大模型还没有 key：在声音页的「想」里填", "voice");
        llm = new OpenAI({ apiKey: keys.llmKey, url: answer.url, model: answer.model, ...speech });
        break;
      default:
        return unavailable(`大模型用的 ${(answer as { vendor: string }).vendor} ${voiceUnknown}`);
    }
    let tts: Vendors["tts"];
    const t = voice.tts;
    switch (t.vendor) {
      case "minimax":
        tts = new MiniMaxTTS({ model: t.model, voiceId: t.voiceId });
        break;
      case "openai":
        tts = new OpenAITTS({ voice: t.voice });
        break;
      case "microsoft":
        if (!keys.ttsKey) return unavailable("微软合成还没有 key：在声音页的「说」里填", "voice");
        tts = new MicrosoftTTS({ key: keys.ttsKey, region: t.region, voiceName: t.voiceName });
        break;
      default:
        return unavailable(`合成用的 ${(t as { vendor: string }).vendor} ${voiceUnknown}`);
    }
    return { stt, llm, tts };
  } catch (e) {
    // The SDK throws on a configuration it refuses; that is a problem with the settings, not the server's.
    return unavailable("语音设置用不了：" + message(e), "voice");
  }
}

const areaOf = (area: Area) => ({ US: AgoraArea.US, EU: AgoraArea.EU, AP: AgoraArea.AP, CN: AgoraArea.CN })[area] ?? AgoraArea.US;

export const clientOf = (c: AgoraCredentials, area: Area, fetcher?: typeof fetch) =>
  new AgoraClient({ area: areaOf(area) as never, appId: c.appId, appCertificate: c.appCertificate, ...(fetcher ? { fetch: fetcher } : {}) });

/** Read at each start: a change takes effect on the next call. Captions go over the RTC data stream: the client has no RTM. */
export function agentFor(client: AgoraClient, voice: VoiceSettings, vendors: Vendors) {
  return new Agent({
    client,
    instructions: voice.persona,
    maxHistory: 50,
    turnDetection: {
      language: voice.language,
      config: {
        speech_threshold: 0.5,
        start_of_speech: { mode: "vad", vad_config: { interrupt_duration_ms: voice.interruptMs, prefix_padding_ms: 300 } },
        end_of_speech: { mode: "vad", vad_config: { silence_duration_ms: voice.silenceMs } },
      },
    } as never,
    // RTM carries transcripts and the agent's state; a client without RTM asks for the RTC data stream, which carries
    // the transcripts (chunked); RTM is then off, or the agent keeps sending to RTM and nothing reaches the data stream.
    advancedFeatures: { enable_rtm: false, enable_tools: true },
    parameters: { audio_scenario: "chorus", data_channel: "datastream", enable_error_message: true, enable_metrics: true } as never,
  })
    .withStt(vendors.stt)
    .withLlm(vendors.llm)
    .withTts(vendors.tts as never);
}

/** Already left or leaving counts as success, as the quickstart treats it. */
function alreadyStopping(e: unknown): boolean {
  const err = e as { statusCode?: number; body?: { detail?: string; reason?: string }; message?: string } | null;
  if (err?.statusCode === 404) return true;
  return [err?.body?.detail, err?.body?.reason, err?.message].join(" ").toLowerCase().includes("already in the process of shutting down");
}

const sign = (c: AgoraCredentials, channel: string, uid: string): AgoraGrant => ({
  appId: c.appId,
  channel,
  uid,
  token: RtcTokenBuilder.buildTokenWithRtm(c.appId, c.appCertificate, channel, uid, RtcRole.PUBLISHER, tokenSeconds, tokenSeconds),
});

/** prefix-<ms>-<6 random>: the quickstart's timestamp-plus-random shape. */
const newChannel = () => `vibevalley-${Date.now()}-${Array.from({ length: 6 }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[randomInt(36)]).join("")}`;
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
  /** Agora's model answers, so its words reach 田头 only through said; the orchestrator's own reach it as it says them. */
  readonly quick: boolean;
  /** Said at every pickup; not worth keeping in 田头. */
  readonly greeting: string;
  ending: boolean;
}

export interface VoiceShape {
  readonly session: () => Effect.Effect<AgoraGrant, ApiError>;
  readonly renew: (channel: string, uid: string) => Effect.Effect<AgoraGrant, ApiError>;
  /** about: what rang, when the call answers a ring: the orchestrator says it first, in place of the greeting. */
  readonly start: (channel: string, uid: string, about?: string) => Effect.Effect<VoiceAgent, ApiError>;
  readonly stop: (agentId: string) => Effect.Effect<void, ApiError>;
  /** What the owner said on a call: the orchestrator overhears it when Agora's model answers. */
  readonly heard: (agentId: string, text: string, picked: string, sendKey: string) => Effect.Effect<void, ApiError>;
  /** The relay without a call id: the one call on. */
  readonly heardCurrent: (text: string, picked: string, sendKey: string) => Effect.Effect<void, ApiError>;
  readonly said: (agentId: string, text: string) => Effect.Effect<void, ApiError>;
  readonly dictate: (audio: string, format: string) => Effect.Effect<Dictated, ApiError>;
  /** The keys of the lines open now, by call. */
  readonly lines: () => number;
  /** Words read out on the call that is on, queued after what is being said; false when no call is on. */
  readonly speak: (text: string) => Effect.Effect<boolean>;
}

/** Agora reads out at most 512 bytes at a time: the words in pieces under that, cut after a sentence where one ends. */
export function speakPieces(text: string, max = 480): string[] {
  const bytes = (t: string) => Buffer.byteLength(t, "utf8");
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
    const end = Math.max(...[..."。！？!?；;\n"].map((p) => head.lastIndexOf(p)));
    const cut = end > 0 ? [...head.slice(0, end + 1)].length : fit;
    out.push(chars.slice(0, cut).join("").trim());
    rest = chars.slice(cut).join("").trim();
  }
  return out.filter(Boolean);
}

const spoken = "口语，先说结论；不念代码、路径、命令和长列表。";

/** What the orchestrator is given to tell the owner on the call: everything that waited, as one; ring is what rang, when the
 * owner just picked the call up for it. What it answers is read out. */
export function onCallLine(texts: readonly string[], ring?: string): string {
  const list = texts.map((t) => "- " + t).join("\n");
  if (ring)
    return (
      "主人接起了你打的电话。你打电话是为了这件事：" +
      ring +
      (list ? "\n这期间又有：\n" + list : "") +
      "\n先开口说这些：" +
      (texts.length > 0 ? "合成一段说，" : "一两句，") +
      spoken
    );
  return (
    "【要告诉主人】\n" +
    list +
    "\n\n主人正在和你通电话，你的回答会念给主人听：" +
    (texts.length > 1 ? `这 ${texts.length} 件合成一段说，一件一句，` : "一两句，") +
    spoken
  );
}

export class Voice extends Context.Service<Voice, VoiceShape>()("vibevalley/Voice") {}

export interface VoiceOptions {
  /** Agora's REST calls go through it; fetch when absent. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** A tunnel to the line's port, open while its scope is: its public address. cloudflared's quick tunnel when absent. */
  readonly tunnel?: (port: number) => Effect.Effect<string, Error, Scope.Scope>;
  /** How long what is to be told waits for others to join it before the orchestrator is asked; 3 s when absent. */
  readonly gatherMs?: number;
}

const quickTunnel = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** cloudflared's quick tunnel to port, open while the scope is: its address once it says it. */
const cloudflared = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], port: number) =>
  Effect.gen(function* () {
    const handle = yield* spawner
      .spawn(ChildProcess.make("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`]))
      .pipe(
        Effect.mapError((e) =>
          e.reason._tag === "NotFound"
            ? new Error("没有 cloudflared：先 brew install cloudflared，或者在配置里设 voice.line.url，用你自己的隧道")
            : new Error(e.message),
        ),
      );
    const said = yield* Deferred.make<string, Error>();
    // cloudflared says its address on either stream; both are read until it exits, so it never blocks on a write.
    yield* handle.all.pipe(
      Stream.decodeText,
      Stream.runForEach((text) => {
        const url = quickTunnel.exec(text)?.[0];
        return url ? Effect.asVoid(Deferred.succeed(said, url)) : Effect.void;
      }),
      Effect.andThen(Deferred.fail(said, new Error("cloudflared 退出了，没给出地址"))),
      Effect.forkScoped,
    );
    return yield* Deferred.await(said).pipe(Effect.timeoutOrElse({ duration: 30_000, orElse: () => Effect.fail(new Error("cloudflared 30 秒没给出地址")) }));
  });

/** The line refusing a keyless request counts as an answer. */
async function tunnelAnswers(url: string): Promise<boolean> {
  for (const deadline = Date.now() + lineReadyMs; Date.now() < deadline;) {
    try {
      const res = await fetch(url + "/llm/ready/chat/completions", { method: "POST", signal: AbortSignal.timeout(5_000) });
      if (res.status === 401) return true;
    } catch {
      // Not yet.
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

export const make = Effect.fnUntraced(function* (options: VoiceOptions = {}) {
  const logs = yield* callbackLog;
  const config = yield* Settings;
  const core = yield* Core;
  const notices = yield* Notices;
  const settings = yield* Setting;
  const chat = yield* Channels;
  const orchestrator = yield* Orchestrator;
  const now = options.now ?? Date.now;

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
    return c ? Effect.succeed(c) : Effect.fail(unavailable("还没有 Agora 的凭据：在首页的「设置」里填 App ID 和 App Certificate", "agora"));
  };

  // The voice line: local only, like the farm; the tunnel is the one way in from outside.
  const keys = new Map<string, string>();
  let line: Server | undefined;
  let linePort = config.voice.line.port;
  let lineProblem = "";
  // The tunnel, while calls use it: opened in a scope of its own, closed a while after the last call let go of the line.
  let tunnel: { readonly url: string; readonly scope: Scope.Closeable } | undefined;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const tunnelLock = yield* Semaphore.make(1);
  const timers = yield* FiberMap.make<"close">();
  const later = yield* FiberMap.runtime(timers)<never>();
  const answer = chatCompletions({
    answerer: orchestrator.answerer("phone"),
    misheard: lineMisheard,
    log: (l) => logs.info(l),
  });
  const route = /^\/llm\/([\w-]+)\/chat\/completions$/;
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const s = createServer(async (req, res) => {
          const m = route.exec(new URL(req.url ?? "/", "http://line").pathname);
          if (req.method !== "POST" || !m) {
            res.writeHead(404);
            return void res.end();
          }
          const key = keys.get(m[1]!);
          if (!key || req.headers.authorization !== "Bearer " + key) {
            res.writeHead(401, { "content-type": "application/json" });
            return void res.end(`{"error":{"message":"unauthorized"}}`);
          }
          const ended = new AbortController();
          res.on("close", () => ended.abort());
          const body = await new Promise<Buffer>((r) => {
            const parts: Buffer[] = [];
            req.on("data", (p: Buffer) => parts.push(p));
            req.on("end", () => r(Buffer.concat(parts)));
          });
          const got = await answer(new Request("http://line" + req.url, { method: "POST", body, signal: ended.signal }));
          res.writeHead(got.status, Object.fromEntries(got.headers));
          if (!got.body) return void res.end();
          try {
            for await (const chunk of got.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
          } finally {
            res.end();
          }
        });
        s.once("error", (e) => {
          lineProblem = "语音线路开不起来：" + e.message;
          logs.error(`vibevalley: the voice line cannot listen on 127.0.0.1:${linePort}:`, e.message);
          resolve();
        });
        s.listen(linePort, "127.0.0.1", () => {
          line = s;
          const a = s.address();
          if (a && typeof a === "object") linePort = a.port;
          resolve();
        });
      }),
  );

  const openTunnel =
    options.tunnel ??
    ((port: number) =>
      Effect.tap(cloudflared(spawner, port), (url) =>
        Effect.promise(() => tunnelAnswers(url)).pipe(
          Effect.flatMap((answers) =>
            answers ? Effect.void : Effect.sync(() => logs.info(`vibevalley: the voice line's tunnel ${url} does not answer yet; the call goes on`)),
          ),
        ),
      ));
  // Opening a tunnel waits for it to answer, through this very line: one opening at a time.
  const base = Effect.gen(function* () {
    if (config.voice.line.url) return config.voice.line.url.replace(/\/+$/, "");
    // A call came: the tunnel stays.
    yield* FiberMap.remove(timers, "close");
    return yield* tunnelLock.withPermits(1)(
      Effect.gen(function* () {
        if (tunnel) return tunnel.url;
        const scope = yield* Scope.make();
        const url = yield* Scope.provide(openTunnel(linePort), scope).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        tunnel = { url, scope };
        return url;
      }),
    );
  });
  const closeTunnel = Effect.suspend(() => {
    const t = tunnel;
    tunnel = undefined;
    return t ? Scope.close(t.scope, Exit.void) : Effect.void;
  });
  const openLine = Effect.gen(function* () {
    if (stopped) return yield* Effect.fail(new Error("语音线路已经关闭"));
    if (lineProblem) return yield* Effect.fail(new Error(lineProblem));
    if (!line) return yield* Effect.fail(new Error("语音线路还没开"));
    const url = yield* base;
    const id = randomBytes(8).toString("hex");
    const key = randomBytes(24).toString("base64url");
    keys.set(id, key);
    return { id, key, url: url + "/llm/" + id + "/chat/completions" } satisfies CallLine;
  });
  const closeLine = (id: string) => {
    keys.delete(id);
    if (keys.size > 0 || !tunnel) return;
    void later(
      "close",
      Effect.delay(
        Effect.suspend(() => (keys.size > 0 ? Effect.void : closeTunnel)),
        lineLingerMs,
      ),
    );
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopped = true;
      grants.clear();
      keys.clear();
      line?.closeAllConnections();
      line?.close();
    }).pipe(Effect.andThen(closeTunnel)),
  );

  const callOf = (agentId: string) => {
    const call = calls.get(agentId);
    return call && !call.ending ? Effect.succeed(call) : Effect.fail(failed("这通电话已经挂了"));
  };

  const liveCall = () => [...calls].find(([, c]) => !c.ending)?.[0];

  // Queued after what is being said (APPEND): never over the owner; the owner may talk over it.
  const speakOn = async (agentId: string, text: string) => {
    const call = calls.get(agentId);
    if (!call || call.ending) return false;
    try {
      // Through the session: a bare agents.speak carries no token, and Agora answers 401.
      for (const piece of speakPieces(text)) await call.session.say(piece, { priority: "APPEND", interruptable: true });
      return true;
    } catch (e) {
      logs.warn("vibevalley: voice: the orchestrator's words were not read out: " + message(e));
      return false;
    }
  };

  // What is to be told on the call waits in one queue, so that it never crowds itself: the orchestrator is asked once at a
  // time, with everything that came meanwhile (after gatherMs, for what comes together), and its answer is read out
  // (queued after what is being said) before it is asked again. With no call on, what waits is dropped: it is on the
  // phone and in the inbox. An answer with no words puts its things back.
  const gatherMs = options.gatherMs ?? 3000;
  const waiting: string[] = [];
  let rang: string | undefined;
  let telling = false;
  const tell = (texts: readonly string[], ring?: string) => {
    waiting.push(...texts);
    if (ring) rang = ring;
    if (!telling) void drain();
  };
  const drain = async () => {
    telling = true;
    try {
      for (let tries = 0; (waiting.length > 0 || rang) && tries < 3;) {
        await new Promise((r) => setTimeout(r, gatherMs));
        const on = liveCall();
        if (!on || stopped) break;
        const texts = waiting.splice(0);
        const ring = rang;
        rang = undefined;
        const said = await orchestrator.brief(onCallLine(texts, ring));
        if (said) {
          tries = 0;
          await speakOn(on, said);
        } else {
          tries++;
          waiting.unshift(...texts);
          if (ring) rang ??= ring;
        }
      }
    } finally {
      waiting.length = 0;
      rang = undefined;
      telling = false;
    }
  };

  // What came into the inbox: with a call on, the orchestrator says it on the call; with none, the page's phone rings
  // with the same items.
  yield* Effect.forkScoped(
    Stream.runForEach(yield* notices.news, (items) =>
      Effect.sync(() => {
        if (liveCall()) tell(items.map((i) => (i.words.body ? `${i.words.title}：${i.words.body}` : i.words.title)));
      }),
    ),
  );

  const heard = Effect.fnUntraced(function* (agentId: string, text: string, picked: string, sendKey: string) {
    const call = yield* callOf(agentId);
    // Both transcript directions use the answer mode captured by this call, never the current settings.
    if (!call.quick) return;
    yield* orchestrator.heard(text, picked, sendKey);
  });

  return Voice.of({
    session: Effect.fn("Voice.session")(function* () {
      const c = yield* creds();
      const channel = newChannel();
      const uid = newUid();
      const issued = yield* Effect.try({ try: () => sign(c, channel, uid), catch: (e) => unavailable("签不出语音令牌：" + message(e)) });
      if (stopped) return yield* Effect.fail(unavailable("语音服务已经停下"));
      prune();
      grants.set(keyOf(channel, uid), { credentials: c, expires: now() + tokenSeconds * 1000, starting: false, agent: "" });
      return issued;
    }),
    renew: Effect.fn("Voice.renew")(function* (channel, uid) {
      prune();
      const g = grants.get(keyOf(channel, uid));
      if (!g) return yield* Effect.fail(unavailable("这通电话的语音凭据已经失效，请重新接通"));
      const issued = yield* Effect.try({ try: () => sign(g.credentials, channel, uid), catch: (e) => unavailable("签不出语音令牌：" + message(e)) });
      g.expires = now() + tokenSeconds * 1000;
      return issued;
    }),
    start: Effect.fn("Voice.start")(function* (channel, uid, about) {
      prune();
      const key = keyOf(channel, uid);
      const g = grants.get(key);
      if (!g) return yield* Effect.fail(unavailable("这通电话的语音凭据已经失效，请重新接通"));
      if (g.starting || g.agent) return yield* Effect.fail(unavailable("这通电话已经在接通"));
      g.starting = true;
      let release = () => {};
      const started = Effect.gen(function* () {
        const { voice, keys: vendorKeys, deepseekApiKey } = settings.voiceConfig();
        let callLine: CallLine | undefined;
        if (voice.answer.vendor === "orchestrator") {
          callLine = yield* openLine.pipe(Effect.mapError((e) => unavailable("管家的语音线路接不通：" + e.message)));
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
        const client = clientOf(g.credentials, voice.area, options.fetch);
        const session = agentFor(client, forCall, vendors).createSession({
          channel,
          agentUid: voiceAgentUid,
          remoteUids: [uid],
          idleTimeout: voice.idleSeconds,
          expiresIn: tokenSeconds,
        });
        const id = yield* Effect.tryPromise({ try: () => session.start(), catch: (e) => failed("请管家进频道失败：" + message(e)) });
        if (stopped || grants.get(key) !== g) {
          yield* Effect.promise(() => client.stopAgent(id).catch(() => undefined));
          return yield* Effect.fail(unavailable("语音服务已经停下"));
        }
        g.agent = id;
        g.starting = false;
        calls.set(id, {
          grant: key,
          client,
          session,
          release,
          quick: callLine === undefined,
          greeting: forCall.greeting.trim(),
          ending: false,
        });
        if (about) tell([], about);
        return { agentId: id, answeredBy: callLine === undefined ? "agora" : "orchestrator" } as const;
      });
      const agent = yield* Effect.tapError(started, () =>
        Effect.sync(() => {
          release();
          if (grants.get(key) === g) grants.delete(key);
        }),
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
        client = call.client;
      } else client = clientOf(yield* creds(), settings.voice().area, options.fetch);
      const stopping = Effect.tryPromise({ try: () => client.stopAgent(agentId), catch: (e) => e }).pipe(
        Effect.catch((e) => (alreadyStopping(e) ? Effect.void : Effect.fail(failed("请管家离开失败：" + message(e))))),
      );
      yield* Effect.ensuring(
        stopping,
        Effect.sync(() => call?.release()),
      );
      calls.delete(agentId);
    }),
    heard,
    heardCurrent: (text, picked, sendKey) =>
      Effect.suspend(() => {
        const live = [...calls].filter(([, c]) => !c.ending);
        if (live.length > 1) return Effect.fail(failed("有几通电话正在接通，请升级客户端后重试"));
        if (live.length === 0) return Effect.fail(failed("没有正在接通的电话"));
        return heard(live[0]![0], text, picked, sendKey);
      }),
    // Only a call still on, that Agora's model answers: a late turn after hangup, or the orchestrator's words, are not kept twice.
    said: Effect.fn("Voice.said")(function* (agentId, text) {
      const call = yield* callOf(agentId);
      if (call.quick && text.trim() !== call.greeting) yield* Effect.ignore(chat.spoken(orchestratorAgent, text, ""));
    }),
    dictate: Effect.fn("Voice.dictate")(function* (audio64, given) {
      const d = settings.dictation();
      if (!d) return yield* Effect.fail(unavailable("听写还没配：在「声音」页的「听写」里填地址和模型", "voice"));
      const format = given.trim().replace(/^\./, "").toLowerCase();
      const kind = dictateFormats[format];
      if (!kind) return yield* new Refused({ reason: `听写认不得 ${JSON.stringify(format)} 这种录音` });
      const audio = Buffer.from(audio64, "base64");
      if (audio.length === 0 || audio.toString("base64").replace(/=+$/, "") !== audio64.replace(/=+$/, "").replace(/\s/g, ""))
        return yield* new Refused({ reason: "录音是空的，或者不是 base64" });
      if (audio.length > dictateMaxBytes) return yield* new Refused({ reason: "录音太长了：一段不超过 25 MB" });
      const form = new FormData();
      form.append("file", new Blob([audio], { type: kind }), `dictation.${format}`);
      form.append("model", d.model);
      form.append("response_format", "json");
      // A local model's first request loads it, which takes a while.
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(d.url + "/audio/transcriptions", {
            method: "POST",
            body: form,
            headers: d.key ? { authorization: "Bearer " + d.key } : {},
            signal: AbortSignal.timeout(120_000),
          }),
        catch: (e) => unavailable("听写的地址连不上：" + message(e), "voice"),
      });
      const raw = (yield* Effect.tryPromise({ try: () => res.text(), catch: (e) => unavailable("听写的回答读到一半断了：" + message(e), "voice") })).slice(
        0,
        1 << 20,
      );
      let got: { text?: string; error?: { message?: string } } | undefined;
      try {
        got = JSON.parse(raw) as typeof got;
      } catch {
        got = undefined;
      }
      if (!res.ok) return yield* Effect.fail(unavailable(`听写的地址回了 ${res.status}：${[...(got?.error?.message || raw.trim())].slice(0, 200).join("")}`));
      if (!got) return yield* Effect.fail(unavailable("听写的地址回的不是 OpenAI 的转写格式"));
      return { text: (got.text ?? "").trim() };
    }),
    lines: () => keys.size,
    speak: (text) =>
      Effect.promise(async () => {
        const on = liveCall();
        return on ? speakOn(on, text) : false;
      }),
  });
});

export const layer = (options?: VoiceOptions) => Layer.effect(Voice, make(options));
