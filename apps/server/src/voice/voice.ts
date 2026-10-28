// The owner's calls: Agora RTC grants, the voice agent Agora runs for a call, the voice line the
// orchestrator answers it on, and dictation. A grant is signed for one channel and uid and lives as long as its token, or the
// call it starts; a call keeps the credentials and the area it started with, whatever the settings say later. The line
// listens on loopback, reachable from outside only through its tunnel, and answers one endpoint, with each call's own key.

import { onCallLine } from "./prompts.ts";
import { voiceWording } from "./words.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AgoraGrant, type Area, type Dictated, defaultOrchestrator, type VoiceAgent, type VoiceSettings } from "@vibevalley/protocol";
import { type ApiError, type VoiceFix, type VoiceUnavailable } from "@vibevalley/protocol/api";
import { Agent, AgoraClient, Area as AgoraArea, AresSTT, DeepgramSTT, MicrosoftSTT, MicrosoftTTS, MiniMaxTTS, OpenAI, OpenAITTS } from "agora-agents";
import agoraToken from "agora-token";
import { Clock, Context, Effect, FiberSet, Layer, Schema, Stream } from "effect";
import { chatCompletions } from "../agent/brain/openai.ts";
import { Settings } from "../base/config.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { orchestratorModel } from "../orchestrator/rules.ts";
import { Notices } from "../notice/notice.ts";
import { type AgoraCredentials, Setting, type VoiceKeys } from "../setting/setting.ts";
import { callbackLog } from "../base/log.ts";
import { afterRealTime, timeHere, wallTime } from "../base/time.ts";
import type { Time } from "../base/time.ts";

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
const failed = (reason: string): ApiError => ({ _tag: "VoiceAgentFailed", reason });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface CallLine {
  readonly id: string;
  readonly url: string;
  readonly key: string;
}

/** For a member added to the union and not to vendorsFor. */
export const voiceUnknown = () => voiceWording().unknownSuffix;

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
        if (!keys.asrKey) return unavailable(voiceWording().noAsrKey, "voice");
        stt = new MicrosoftSTT({ key: keys.asrKey, region: asr.region, language: voice.language });
        break;
      default: {
        const exhaustive: never = asr;
        return unavailable(voiceWording().unknown(voiceWording().part.asr, (exhaustive as { vendor: string }).vendor));
      }
    }
    let llm: OpenAI;
    const answer = voice.answer;
    switch (answer.vendor) {
      case "orchestrator":
        if (!line) return unavailable(voiceWording().noLine);
        llm = new OpenAI({ apiKey: line.key, url: line.url, model: orchestratorModel, ...speech });
        break;
      case "agora":
        llm = new OpenAI({ model: answer.model, ...speech });
        break;
      case "deepseek":
        if (!deepseekKey) return unavailable(voiceWording().noDeepseekKey, "deepseek");
        llm = new OpenAI({
          apiKey: deepseekKey,
          url: deepseekChat,
          model: answer.model,
          ...speech,
        });
        break;
      case "openai":
        if (!keys.llmKey) return unavailable(voiceWording().noLlmKey, "voice");
        llm = new OpenAI({ apiKey: keys.llmKey, url: answer.url, model: answer.model, ...speech });
        break;
      default: {
        const exhaustive: never = answer;
        return unavailable(voiceWording().unknown(voiceWording().part.llm, (exhaustive as { vendor: string }).vendor));
      }
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
        if (!keys.ttsKey) return unavailable(voiceWording().noTtsKey, "voice");
        tts = new MicrosoftTTS({ key: keys.ttsKey, region: t.region, voiceName: t.voiceName });
        break;
      default: {
        const exhaustive: never = t;
        return unavailable(voiceWording().unknown(voiceWording().part.tts, (exhaustive as { vendor: string }).vendor));
      }
    }
    return { stt, llm, tts };
  } catch (e) {
    // The SDK throws on a configuration it refuses; that is a problem with the settings, not the server's.
    return unavailable(voiceWording().unusable(message(e)), "voice");
  }
}

const areaOf = (area: Area) => ({ US: AgoraArea.US, EU: AgoraArea.EU, AP: AgoraArea.AP, CN: AgoraArea.CN })[area] ?? AgoraArea.US;

/** Agora's REST calls retried as its SDK would on its own (408, 429 and 5xx, twice: what Retry-After says, else 1 s
 * then 2 s), but sleeping on time: the SDK's retries wait on real time, out of reach of the service's Clock. */
export const retrying =
  (fetcher: typeof fetch, time: Time): typeof fetch =>
  async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetcher(input, init);
      if (attempt >= 2 || !([408, 429].includes(res.status) || res.status >= 500)) return res;
      const after = Number(res.headers.get("Retry-After"));
      await time.sleep(after > 0 ? Math.min(after * 1000, 60_000) : 1000 * 2 ** attempt, init?.signal ?? undefined);
    }
  };

export const clientOf = (c: AgoraCredentials, area: Area, time: Time, fetcher: typeof fetch = fetch) =>
  new AgoraClient({
    area: areaOf(area) as never,
    appId: c.appId,
    appCertificate: c.appCertificate,
    maxRetries: 0,
    fetch: retrying(fetcher, time),
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
    } as never,
    // RTM carries transcripts and the agent's state; a client without RTM asks for the RTC data stream, which carries
    // the transcripts (chunked); RTM is then off, or the agent keeps sending to RTM and nothing reaches the data stream.
    advancedFeatures: { enable_rtm: false, enable_tools: true },
    parameters: {
      audio_scenario: "chorus",
      data_channel: "datastream",
      enable_error_message: true,
      enable_metrics: true,
    } as never,
  })
    .withStt(vendors.stt)
    .withLlm(vendors.llm)
    .withTts(vendors.tts);
}

/** Already left or leaving counts as success, as the quickstart treats it. */
function alreadyStopping(e: unknown): boolean {
  const err = e as {
    statusCode?: number;
    body?: { detail?: string; reason?: string };
    message?: string;
  } | null;
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

export class Voice extends Context.Service<Voice, VoiceShape>()("vibevalley/Voice") {}

export interface VoiceOptions {
  /** Agora's REST calls go through it; fetch when absent. */
  readonly fetch?: typeof fetch;
  /** A tunnel to the line's port: its public address and how to close it. cloudflared's quick tunnel when absent. */
  readonly tunnel?: (port: number) => Promise<{ readonly url: string; readonly close: () => void }>;
  /** How long what is to be told waits for others to join it before the orchestrator is asked; 3 s when absent. */
  readonly gatherMs?: number;
}

const quickTunnel = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function cloudflared(port: number): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    const close = () => child.kill();
    // A real process: its deadline is real time.
    const cancel = afterRealTime(30_000, () => {
      close();
      reject(new Error(voiceWording().tunnel.timedOut));
    });
    // cloudflared says its address on either stream; both are read until it exits, so it never blocks on a write.
    const read = (b: Buffer) => {
      const url = quickTunnel.exec(b.toString())?.[0];
      if (url) {
        cancel();
        resolve({ url, close });
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (e) => {
      cancel();
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(voiceWording().tunnel.missing) : e);
    });
    child.on("exit", () => {
      cancel();
      reject(new Error(voiceWording().tunnel.exited));
    });
  });
}

/** The line refusing a keyless request counts as an answer. Asked over the real network, on real time. */
async function tunnelAnswers(url: string): Promise<boolean> {
  for (const deadline = wallTime.now() + lineReadyMs; wallTime.now() < deadline;) {
    try {
      const res = await fetch(url + "/llm/ready/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 401) return true;
    } catch {
      // Not yet.
    }
    await wallTime.sleep(2_000);
  }
  return false;
}

export const make = (options: VoiceOptions = {}) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    const config = yield* Settings;
    const core = yield* Core;
    const notices = yield* Notices;
    const settings = yield* Setting;
    const chat = yield* Channels;
    const orchestrator = yield* Orchestrator;
    // Read in callbacks too: the Clock the service was built with.
    const clock = yield* Clock.Clock;
    const time = yield* timeHere;
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
      return c ? Effect.succeed(c) : Effect.fail(unavailable(voiceWording().noAgora, "agora"));
    };

    // The voice line: local only, like the farm; the tunnel is the one way in from outside.
    const keys = new Map<string, string>();
    let line: Server | undefined;
    let linePort = config.voice.line.port;
    let lineProblem = "";
    let tunnel: { url: string; close: () => void } | undefined;
    /** What cancels closing the tunnel, lineLingerMs after the last call. */
    let closing: (() => void) | undefined;
    const answer = chatCompletions({
      answerer: orchestrator.answerer("phone"),
      misheard: voiceWording().misheard,
      log: (l) => logs.info(l),
      now: () => clock.currentTimeMillisUnsafe(),
    });
    const route = /^\/llm\/([\w-]+)\/chat\/completions$/;
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
        line?.closeAllConnections();
        line?.close();
      }),
    );
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          const s = createServer((req, res) => {
            const go = async () => {
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
            };
            go().catch(() => {
              if (!res.headersSent) res.writeHead(502);
              res.end();
            });
          });
          s.once("error", (e) => {
            lineProblem = voiceWording().lineDown(e.message);
            logs.error(`vibevalley: the voice line cannot listen on 127.0.0.1:${linePort}:`, e.message);
            resolve();
          });
          s.listen(linePort, "127.0.0.1", () => {
            if (stopped) {
              s.closeAllConnections();
              s.close();
              resolve();
              return;
            }
            line = s;
            const a = s.address();
            if (a && typeof a === "object") linePort = a.port;
            resolve();
          });
        }),
    );

    const openTunnel =
      options.tunnel ??
      (async (port: number) => {
        const t = await cloudflared(port);
        if (!(await tunnelAnswers(t.url))) logs.info(`vibevalley: the voice line's tunnel ${t.url} does not answer yet; the call goes on`);
        return t;
      });
    // Opening a tunnel waits for it to answer, through this very line: one opening at a time.
    let opening: Promise<string> | undefined;
    const base = async () => {
      if (config.voice.line.url) return config.voice.line.url.replace(/\/+$/, "");
      closing?.();
      closing = undefined;
      if (!tunnel) {
        opening ??= openTunnel(linePort)
          .then((t) => {
            if (stopped) {
              t.close();
              throw new Error(voiceWording().lineClosed);
            }
            tunnel = t;
            return t.url;
          })
          .finally(() => {
            opening = undefined;
          });
        return opening;
      }
      return tunnel.url;
    };
    const openLine = async (): Promise<CallLine> => {
      if (stopped) throw new Error(voiceWording().lineClosed);
      if (lineProblem) throw new Error(lineProblem);
      if (!line) throw new Error(voiceWording().lineNotOpen);
      const url = await base();
      if (stopped) throw new Error(voiceWording().lineClosed);
      const id = randomBytes(8).toString("hex");
      const key = randomBytes(24).toString("base64url");
      keys.set(id, key);
      return { id, key, url: url + "/llm/" + id + "/chat/completions" };
    };
    const closeLine = (id: string) => {
      keys.delete(id);
      if (keys.size > 0 || !tunnel) return;
      closing?.();
      closing = time.after(lineLingerMs, () => {
        closing = undefined;
        if (keys.size > 0 || !tunnel) return;
        tunnel.close();
        tunnel = undefined;
      });
    };

    const callOf = (agentId: string) => {
      const call = calls.get(agentId);
      return call && !call.ending ? Effect.succeed(call) : Effect.fail(failed(voiceWording().hungUp));
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
            catch: (e) => e,
          });
        }
        return true;
      },
      (effect) =>
        effect.pipe(
          Effect.catch((e) =>
            Effect.sync(() => {
              logs.warn("vibevalley: voice: the orchestrator's words were not read out: " + message(e));
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
    const forkHere = yield* FiberSet.makeRuntime<never>();
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
        const said = yield* Effect.tryPromise({
          try: (signal) => orchestrator.brief(onCallLine(texts, ring), AbortSignal.any([signal, call.life.signal])),
          catch: (e) => e,
        }).pipe(Effect.catch((e) => (stopped || call.ending || calls.get(on) !== call ? Effect.succeed(undefined) : Effect.fail(e))));
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
      Effect.catch((e) => Effect.sync(() => logs.warn("vibevalley: voice: the update could not be told: " + message(e)))),
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
          if (liveCall()) tell(items.map((i) => (i.words.body ? `${i.words.title}：${i.words.body}` : i.words.title)));
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
          catch: (e) => unavailable(voiceWording().noToken(message(e))),
        });
        if (stopped) return yield* Effect.fail(unavailable(voiceWording().stopped));
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
        if (!g) return yield* Effect.fail(unavailable(voiceWording().grantGone));
        const issued = yield* Effect.try({
          try: () => sign(g.credentials, channel, uid),
          catch: (e) => unavailable(voiceWording().noToken(message(e))),
        });
        g.expires = now() + tokenSeconds * 1000;
        return issued;
      }),
      start: Effect.fn("Voice.start")(function* (channel, uid, about) {
        prune();
        const key = keyOf(channel, uid);
        const g = grants.get(key);
        if (!g) return yield* Effect.fail(unavailable(voiceWording().grantGone));
        if (g.starting || g.agent) return yield* Effect.fail(unavailable(voiceWording().connecting));
        g.starting = true;
        let release = () => {};
        let callLine: CallLine | undefined;
        let openingLine: Promise<CallLine> | undefined;
        let client: AgoraClient | undefined;
        let starting: Promise<string> | undefined;
        let committed = false;
        const started = Effect.gen(function* () {
          const { voice, keys: vendorKeys, deepseekApiKey } = settings.voiceConfig();
          if (voice.answer.vendor === "orchestrator") {
            openingLine = openLine();
            callLine = yield* Effect.tryPromise({
              try: () => openingLine!,
              catch: (e) => unavailable(voiceWording().lineFailed(message(e))),
            });
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
          const agora = clientOf(g.credentials, voice.area, time, options.fetch);
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
            catch: (e) => failed(voiceWording().joinFailed(message(e))),
          });
          if (stopped || grants.get(key) !== g) return yield* Effect.fail(unavailable(voiceWording().stopped));
          g.agent = id;
          g.starting = false;
          calls.set(id, {
            grant: key,
            client: agora,
            session,
            release,
            quick: callLine === undefined,
            greeting: forCall.greeting.trim(),
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
              if (openingLine && !callLine)
                void openingLine.then(
                  (opened) => closeLine(opened.id),
                  () => undefined,
                );
              const pending = starting;
              const agora = client;
              if (pending && agora)
                void pending.then(
                  async (id) => {
                    try {
                      await agora.stopAgent(id);
                    } catch (e) {
                      logs.warn("vibevalley: voice: the late agent could not be stopped: " + message(e));
                    }
                  },
                  () => undefined,
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
        } else client = clientOf(yield* creds(), settings.voice().area, time, options.fetch);
        const stopping = Effect.tryPromise({
          try: () => client.stopAgent(agentId),
          catch: (e) => e,
        }).pipe(Effect.catch((e) => (alreadyStopping(e) ? Effect.void : Effect.fail(failed(voiceWording().leaveFailed(message(e)))))));
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
          if (live.length > 1) return Effect.fail(failed(voiceWording().manyCalls));
          if (live.length === 0) return Effect.fail(failed(voiceWording().noCall));
          return heard(live[0]![0], text, picked, sendKey);
        }),
      // Only a call still on, that Agora's model answers: a late turn after hangup, or the orchestrator's words, are not kept twice.
      said: Effect.fn("Voice.said")(function* (agentId, text) {
        const call = yield* callOf(agentId);
        if (call.quick && text.trim() !== call.greeting) yield* Effect.ignore(chat.spoken(defaultOrchestrator, text, ""));
      }),
      dictate: Effect.fn("Voice.dictate")(function* (audio64, given) {
        const d = settings.dictation();
        if (!d) return yield* Effect.fail(unavailable(voiceWording().dictation.unset, "voice"));
        const format = given.trim().replace(/^\./, "").toLowerCase();
        const kind = dictateFormats[format];
        if (!kind)
          return yield* Effect.fail<ApiError>({
            _tag: "Refused",
            reason: voiceWording().dictation.format(JSON.stringify(format)),
          });
        const audio = Buffer.from(audio64, "base64");
        if (audio.length === 0 || audio.toString("base64").replace(/=+$/, "") !== audio64.replace(/=+$/, "").replace(/\s/g, ""))
          return yield* Effect.fail<ApiError>({
            _tag: "Refused",
            reason: voiceWording().dictation.empty,
          });
        if (audio.length > dictateMaxBytes)
          return yield* Effect.fail<ApiError>({
            _tag: "Refused",
            reason: voiceWording().dictation.tooLong,
          });
        const form = new FormData();
        form.append("file", new Blob([audio], { type: kind }), `dictation.${format}`);
        form.append("model", d.model);
        form.append("response_format", "json");
        // A local model's first request loads it, which takes a while.
        const res = yield* Effect.tryPromise({
          // Effect's own signal too: an interrupted dictation (the page went away) stops its upload, not only the timeout.
          try: (signal) =>
            fetch(d.url + "/audio/transcriptions", {
              method: "POST",
              body: form,
              headers: d.key ? { authorization: "Bearer " + d.key } : {},
              signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
            }),
          catch: (e) => unavailable(voiceWording().dictation.unreachable(message(e)), "voice"),
        });
        const raw = (yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (e) => unavailable(voiceWording().dictation.cut(message(e)), "voice"),
        })).slice(0, 1 << 20);
        const got = Schema.decodeUnknownOption(DictationResponse)(raw);
        const detail = got._tag === "Some" ? got.value.error?.message : undefined;
        if (!res.ok) return yield* Effect.fail(unavailable(voiceWording().dictation.status(res.status, [...(detail || raw.trim())].slice(0, 200).join(""))));
        if (got._tag === "None") return yield* Effect.fail(unavailable(voiceWording().dictation.shape));
        return { text: (got.value.text ?? "").trim() };
      }),
      lines: () => keys.size,
      speak: (text) =>
        Effect.suspend(() => {
          const on = liveCall();
          return on ? speakOn(on, text) : Effect.succeed(false);
        }),
    });
  });

export const layer = (options?: VoiceOptions) => Layer.effect(Voice, make(options));
