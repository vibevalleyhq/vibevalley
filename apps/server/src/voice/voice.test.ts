import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { VoiceSettings } from "@vibevalley/protocol";
import { defaultVoice } from "@vibevalley/protocol/rules";
import { Effect, Layer } from "effect";
import { layer as manager } from "../manager/manager.ts";
import { Setting } from "../setting/setting.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { agentFor, type CallLine, clientOf, layer, tokenSeconds, vendorsFor, Voice, voiceAgentUid, voiceUnknown } from "./voice.ts";

const appId = "11111111111111111111111111111111";
const cert = "22222222222222222222222222222222";

/** Agora's REST calls, kept; each answered as given (an agent by default). */
class Capture {
  readonly urls: string[] = [];
  readonly requests: Record<string, unknown>[] = [];
  status = 200;
  body = `{"agent_id":"parity-agent"}`;
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    this.urls.push((init?.method ?? "GET") + " " + url);
    this.requests.push(init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {});
    return new Response(this.body, { status: this.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

interface Case {
  readonly name: string;
  readonly voice: VoiceSettings;
  readonly keys: { asrKey?: string; llmKey?: string; ttsKey?: string };
  readonly deepseekKey?: string;
  readonly line?: CallLine;
  readonly request: Record<string, unknown>;
  readonly requestUrl: string;
}

const cases = JSON.parse(readFileSync(resolve(import.meta.dirname, "testdata/voice-requests.json"), "utf8")) as Case[];

describe("a call's agent", () => {
  for (const c of cases)
    it(`asks Agora as recorded: ${c.name}`, async () => {
      const vendors = vendorsFor(
        c.voice,
        { asrKey: c.keys.asrKey ?? "", llmKey: c.keys.llmKey ?? "", ttsKey: c.keys.ttsKey ?? "" },
        c.deepseekKey ?? "",
        c.line,
      );
      if ("_tag" in vendors) throw new Error(vendors.reason);
      const capture = new Capture();
      const client = clientOf({ appId, appCertificate: cert }, c.voice.area, capture.fetch);
      const id = await agentFor(client, c.voice, vendors)
        .createSession({
          name: "parity",
          channel: "parity-channel",
          agentUid: voiceAgentUid,
          remoteUids: ["10001"],
          idleTimeout: c.voice.idleSeconds,
          expiresIn: tokenSeconds,
        })
        .start();
      expect(id).toBe("parity-agent");
      expect(capture.urls[0]).toBe("POST " + c.requestUrl);
      const request = capture.requests[0]!;
      // Go's SDK repeated the app id in the body, this one does not; the token is signed with the time in it.
      delete request.appid;
      (request.properties as Record<string, unknown>).token = "parity-token";
      expect(request).toEqual(c.request);
    });

  it("says which key is missing", () => {
    const d = defaultVoice();
    const none = { asrKey: "", llmKey: "", ttsKey: "" };
    const problem = (v: VoiceSettings, deepseek = "", line?: CallLine) => {
      const got = vendorsFor(v, none, deepseek, line);
      return "_tag" in got ? got.reason : "";
    };
    // Where 设置 fixes it, for the page's jump there.
    const fixedIn = (v: VoiceSettings, deepseek = "") => {
      const got = vendorsFor(v, none, deepseek);
      return "_tag" in got ? got.settings : undefined;
    };
    expect(problem(d)).toBe("");
    const deepseek: VoiceSettings = { ...d, answer: { vendor: "deepseek", model: "deepseek-chat" } };
    expect(problem(deepseek)).toContain("DeepSeek");
    expect(problem(deepseek, "sk-x")).toBe("");
    expect(problem({ ...d, asr: { vendor: "microsoft", region: "eastasia" } })).toContain("识别");
    expect(problem({ ...d, answer: { vendor: "openai", url: "https://x/v1/chat/completions", model: "m" } })).toContain("大模型");
    expect(problem({ ...d, tts: { vendor: "microsoft", region: "eastasia", voiceName: "zh-CN-XiaoxiaoNeural" } })).toContain("合成");
    expect(problem({ ...d, asr: { vendor: "deepgram", model: "nova-3" }, tts: { vendor: "openai", voice: "nova" } })).toBe("");
    expect(problem({ ...d, answer: { vendor: "manager" } })).toContain("语音线路");
    expect(problem({ ...d, asr: { vendor: "whisper" } as never })).toContain(voiceUnknown);
    expect(fixedIn(deepseek)).toBe("deepseek");
    expect(fixedIn({ ...d, asr: { vendor: "microsoft", region: "eastasia" } })).toBe("voice");
    expect(fixedIn({ ...d, answer: { vendor: "manager" } })).toBeUndefined();
  });
});

/** The farm with a voice service, its line on a free port behind a line of its own. */
const farm = (capture: Capture) => {
  const config = { ...testConfig(), voice: { model: "", id: "", line: { port: 0, url: "https://line.example.com" } } };
  return layer({ fetch: capture.fetch }).pipe(Layer.provideMerge(manager({ listen: false }).pipe(Layer.provideMerge(world({ config })))));
};

const credentials = (voice?: Partial<VoiceSettings>) =>
  Effect.gen(function* () {
    const setting = yield* Setting;
    yield* Effect.orDie(setting.save({ agoraAppId: appId, agoraAppCertificate: cert, ...(voice ? { voice: voice as never } : {}) }));
  });

describe("voice", () => {
  it.live("signs a grant only with credentials, and renews it", () =>
    Effect.gen(function* () {
      const voice = yield* Voice;
      expect(yield* Effect.flip(voice.session())).toMatchObject({ _tag: "VoiceUnavailable", reason: expect.stringContaining("App ID") });
      yield* credentials();
      const s = yield* voice.session();
      expect(s.appId).toBe(appId);
      expect(s.channel.startsWith("vibevalley-")).toBe(true);
      expect(s.uid).not.toBe("");
      expect(s.token.startsWith("007")).toBe(true);
      const renewed = yield* voice.renew(s.channel, s.uid);
      expect([renewed.channel, renewed.uid, renewed.token !== ""]).toEqual([s.channel, s.uid, true]);
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture()))),
  );

  it.live("starts and stops the manager on his line", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      yield* credentials({ answer: { vendor: "manager" } });
      const grant = yield* voice.session();
      const agent = yield* voice.start(grant.channel, grant.uid);
      expect(agent.agentId).toBe("parity-agent");
      const props = capture.requests[0]!.properties as Record<string, Record<string, unknown>>;
      expect(String(props.llm!.url).startsWith("https://line.example.com/llm/")).toBe(true);
      expect(props.llm!.api_key).not.toBe("");
      expect([props.parameters!.data_channel, props.advanced_features!.enable_rtm]).toEqual(["datastream", false]);
      // Only the page's user is listened to.
      expect(props.remote_rtc_uids).toEqual([grant.uid]);
      expect(voice.lines()).toBe(1);
      capture.status = 400;
      capture.body = `{"detail":"Agent is already in the process of shutting down"}`;
      yield* voice.stop(agent.agentId);
      expect(voice.lines()).toBe(0);
      capture.status = 500;
      capture.body = `{"detail":"boom"}`;
      expect(yield* Effect.flip(voice.stop("other"))).toMatchObject({ _tag: "VoiceAgentFailed" });
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it.live("keeps a call's credentials and line whatever the settings say later", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      const setting = yield* Setting;
      yield* credentials({ area: "EU", answer: { vendor: "manager" } });
      const grant = yield* voice.session();
      const agent = yield* voice.start(grant.channel, grant.uid);
      const started = capture.urls[0]!;
      yield* Effect.orDie(setting.save({ agoraAppId: "33333333333333333333333333333333", voice: { area: "US" } as never }));
      capture.status = 500;
      capture.body = `{"detail":"temporary failure"}`;
      yield* Effect.flip(voice.stop(agent.agentId));
      // A failed remote stop keeps no local line.
      expect(voice.lines()).toBe(0);
      capture.status = 200;
      capture.body = "{}";
      yield* voice.stop(agent.agentId);
      for (const url of capture.urls.slice(1)) {
        expect(url).toContain(appId);
        expect(url).not.toContain("33333333333333333333333333333333");
        if (started.includes("api-eu")) expect(url).toContain("api-eu");
      }
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it.live("takes no transcripts from a call that is hanging up", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      yield* credentials();
      const grant = yield* voice.session();
      const call = yield* voice.start(grant.channel, grant.uid);
      capture.status = 500;
      capture.body = `{"detail":"stop failed"}`;
      yield* Effect.flip(voice.stop(call.agentId));
      expect(yield* Effect.flip(voice.heard(call.agentId, "late", "", ""))).toMatchObject({ _tag: "VoiceAgentFailed" });
      expect(yield* Effect.flip(voice.said(call.agentId, "late"))).toMatchObject({ _tag: "VoiceAgentFailed" });
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it.live("relays the owner's words without a call id only with one call on", () =>
    Effect.gen(function* () {
      const voice = yield* Voice;
      expect(yield* Effect.flip(voice.heardCurrent("none", "", ""))).toMatchObject({ _tag: "VoiceAgentFailed" });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture()))),
  );

  it.live("says dictation is not set up", () =>
    Effect.gen(function* () {
      const voice = yield* Voice;
      expect(yield* Effect.flip(voice.dictate("AAAA", "wav"))).toMatchObject({ _tag: "VoiceUnavailable", reason: expect.stringContaining("听写还没配") });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture()))),
  );
});
