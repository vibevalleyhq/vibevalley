import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { Issue, Session, VoiceSettings } from "@vibevalley/protocol";
import { defaultVoice } from "../setting/rules.ts";
import { Effect, Layer, type Scope } from "effect";
import { layer as orchestrator } from "../orchestrator/orchestrator.ts";
import { Setting } from "../setting/setting.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { notificationsStart } from "../services.ts";
import { Core } from "../core/core.ts";
import { agentFor, type CallLine, clientOf, layer, onCallLine, speakPieces, tokenSeconds, vendorsFor, Voice, voiceAgentUid, voiceUnknown } from "./voice.ts";

const appId = "11111111111111111111111111111111";
const cert = "22222222222222222222222222222222";

/** Agora's REST calls, kept; each answered as given (an agent by default). */
class Capture {
  readonly urls: string[] = [];
  readonly requests: Record<string, unknown>[] = [];
  /** Each request's Authorization header, as Agora would read it. */
  readonly auths: string[] = [];
  status = 200;
  body = `{"agent_id":"parity-agent"}`;
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    this.urls.push((init?.method ?? "GET") + " " + url);
    this.auths.push(new Headers(init?.headers).get("authorization") ?? "");
    this.requests.push(init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {});
    return new Response(this.body, {
      status: this.status,
      headers: { "content-type": "application/json" },
    });
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
    it(`questions Agora as recorded: ${c.name}`, async () => {
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
    // The quick model, so the rest needs no line; the default (the orchestrator) needs the line and nothing else.
    expect(vendorsFor(defaultVoice(), { asrKey: "", llmKey: "", ttsKey: "" }, "")).toMatchObject({
      reason: "管家的语音线路没接通",
    });
    const d: VoiceSettings = {
      ...defaultVoice(),
      answer: { vendor: "agora", model: "gpt-4.1-mini" },
    };
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
    const deepseek: VoiceSettings = {
      ...d,
      answer: { vendor: "deepseek", model: "deepseek-chat" },
    };
    expect(problem(deepseek)).toContain("DeepSeek");
    expect(problem(deepseek, "sk-x")).toBe("");
    expect(problem({ ...d, asr: { vendor: "microsoft", region: "eastasia" } })).toContain("识别");
    expect(
      problem({
        ...d,
        answer: { vendor: "openai", url: "https://x/v1/chat/completions", model: "m" },
      }),
    ).toContain("大模型");
    expect(
      problem({
        ...d,
        tts: { vendor: "microsoft", region: "eastasia", voiceName: "zh-CN-XiaoxiaoNeural" },
      }),
    ).toContain("合成");
    expect(
      problem({
        ...d,
        asr: { vendor: "deepgram", model: "nova-3" },
        tts: { vendor: "openai", voice: "nova" },
      }),
    ).toBe("");
    expect(problem({ ...d, answer: { vendor: "orchestrator" } })).toContain("语音线路");
    expect(problem({ ...d, asr: { vendor: "whisper" } as never })).toContain(voiceUnknown);
    expect(fixedIn(deepseek)).toBe("deepseek");
    expect(fixedIn({ ...d, asr: { vendor: "microsoft", region: "eastasia" } })).toBe("voice");
    expect(fixedIn({ ...d, answer: { vendor: "orchestrator" } })).toBeUndefined();
  });
});

/** The farm with a voice service, its line on a free port behind a line of its own; or, given tunnel, behind that tunnel. */
const farm = (capture: Capture, tunnel?: (port: number) => Effect.Effect<string, Error, Scope.Scope>) => {
  const config = {
    ...testConfig(),
    voice: { id: "", line: { port: 0, url: tunnel ? "" : "https://line.example.com" } },
  };
  return layer({ fetch: capture.fetch, gatherMs: 30, ...(tunnel ? { tunnel } : {}) }).pipe(
    Layer.provideMerge(orchestrator({ listen: false }).pipe(Layer.provideMerge(world({ config }).pipe(notificationsStart)))),
  );
};

/** A helper at work on an issue, and the issue, as the core has them. */
const helperOn = (id: string, issue: string) =>
  ({
    id,
    name: "阿狐" + id,
    agent: "lab",
    runtime: "pi",
    brief: "写打卡",
    hiredAt: Date.now(),
    runs: 1,
    issue,
    phase: { _tag: "working", since: Date.now(), doing: { action: "none", label: "" } },
    play: { station: 0, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] },
  }) as unknown as Session;
const issueOf = (id: string, number: number, session: string) =>
  ({
    id,
    number,
    title: "写打卡",
    priority: "medium",
    deliver: "change",
    createdAt: Date.now(),
    sessions: [session],
    status: "in_progress",
    moves: [],
    review: "glance",
    findings: [],
    questions: [],
    attention: { state: "working", acts: [] },
  }) as Issue;

const credentials = (voice?: Partial<VoiceSettings>) =>
  Effect.gen(function* () {
    const setting = yield* Setting;
    yield* Effect.orDie(
      setting.save({
        agoraAppId: appId,
        agoraAppCertificate: cert,
        ...(voice ? { voice: voice as never } : {}),
      }),
    );
  });

describe("voice", () => {
  it.live("signs a grant only with credentials, and renews it", () =>
    Effect.gen(function* () {
      const voice = yield* Voice;
      expect(yield* Effect.flip(voice.session())).toMatchObject({
        _tag: "VoiceUnavailable",
        reason: expect.stringContaining("App ID"),
      });
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

  it.live("starts and stops the orchestrator on his line", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      yield* credentials({ answer: { vendor: "orchestrator" } });
      const grant = yield* voice.session();
      const agent = yield* voice.start(grant.channel, grant.uid);
      // The page draws what is said live, and leaves out the words the orchestrator puts in 田头 itself.
      expect([agent.agentId, agent.answeredBy]).toEqual(["parity-agent", "orchestrator"]);
      const props = capture.requests[0]!.properties as Record<string, Record<string, unknown>>;
      expect(String(props.llm!.url).startsWith("https://line.example.com/llm/")).toBe(true);
      expect(props.llm!.api_key).not.toBe("");
      expect(props.llm!.greeting_message).toBeTruthy();
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

  it.live("opens one tunnel for the line's calls, and closes it with the service", () => {
    const capture = new Capture();
    const opened: number[] = [];
    let closed = 0;
    const tunnel = (port: number) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          opened.push(port);
          return "https://tunnel.example.com";
        }),
        () => Effect.sync(() => void closed++),
      );
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const voice = yield* Voice;
        yield* credentials({ answer: { vendor: "orchestrator" } });
        for (const _ of [1, 2]) {
          const grant = yield* voice.session();
          const agent = yield* voice.start(grant.channel, grant.uid);
          const props = capture.requests.at(-1)!.properties as Record<string, Record<string, unknown>>;
          expect(String(props.llm!.url).startsWith("https://tunnel.example.com/llm/")).toBe(true);
          yield* voice.stop(agent.agentId);
        }
        // The second call came while the first one's tunnel lingered: the same tunnel.
        expect([opened.length, opened[0]! > 0, closed]).toEqual([1, true, 0]);
      }).pipe(Effect.scoped, Effect.provide(farm(capture, tunnel)));
      expect(closed).toBe(1);
    });
  });

  it.live("keeps a call's credentials and line whatever the settings say later", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      const setting = yield* Setting;
      yield* credentials({ area: "EU", answer: { vendor: "orchestrator" } });
      const grant = yield* voice.session();
      const agent = yield* voice.start(grant.channel, grant.uid);
      const started = capture.urls[0]!;
      yield* Effect.orDie(
        setting.save({
          agoraAppId: "33333333333333333333333333333333",
          voice: { area: "US" } as never,
        }),
      );
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

  // An issue handed back while the owner is on the call: the orchestrator's words about it are read out on the call, queued
  // after what is being said; with no call on, nothing is read.
  it.live("tells the owner on the call when an issue comes to want the owner", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      const core = yield* Core;
      yield* credentials({ answer: { vendor: "orchestrator" } });
      expect(yield* voice.speak("没人在听")).toBe(false);
      const grant = yield* voice.session();
      const call = yield* voice.start(grant.channel, grant.uid);
      yield* core.apply({ type: "hired", session: helperOn("w1", "t1") });
      yield* core.apply({ type: "issue", issue: issueOf("t1", 41, "w1") });
      yield* core.apply({
        type: "report",
        id: "w1",
        outcome: "completed",
        summary: "做完了",
        runs: 1,
      });
      const at = yield* Effect.promise(async () => {
        for (let i = 0; i < 300; i++) {
          const found = capture.urls.findIndex((u) => u.endsWith(`/agents/${call.agentId}/speak`));
          if (found >= 0) return found;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("never spoken");
      });
      const spoken = capture.requests[at]!;
      expect(spoken).toMatchObject({ priority: "APPEND", interruptable: true });
      // Agora answers 401 to a speak without the session's ConvoAI token: it once went out bare and was never heard.
      expect(capture.auths[at]).toMatch(/^agora token=\S+/);
      expect(String(spoken.text)).not.toBe("");
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  // Answering a ring: no greeting, the orchestrator's first words are what rang.
  it.live("opens a call that answers a ring with what rang", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      yield* credentials({ answer: { vendor: "orchestrator" } });
      const grant = yield* voice.session();
      const call = yield* voice.start(grant.channel, grant.uid, "#41「写打卡」交回来了，等你验收");
      const llm = (capture.requests[0]!.properties as Record<string, Record<string, unknown>>).llm!;
      expect(llm.greeting_message ?? "").toBe("");
      yield* Effect.promise(async () => {
        for (let i = 0; i < 300; i++) {
          if (capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`))) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("never spoken");
      });
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  // Two issues handed back one after the other: one ask of the orchestrator, one answer read out, not two crowding.
  it.live("tells what comes together once, in one answer", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      const core = yield* Core;
      yield* credentials({ answer: { vendor: "orchestrator" } });
      const grant = yield* voice.session();
      const call = yield* voice.start(grant.channel, grant.uid);
      for (const [w, t, n] of [
        ["w1", "t1", 41],
        ["w2", "t2", 42],
      ] as const) {
        yield* core.apply({ type: "hired", session: helperOn(w, t) });
        yield* core.apply({ type: "issue", issue: issueOf(t, n, w) });
      }
      yield* core.apply({
        type: "report",
        id: "w1",
        outcome: "completed",
        summary: "做完了",
        runs: 1,
      });
      yield* core.apply({
        type: "report",
        id: "w2",
        outcome: "failed",
        summary: "没做成",
        runs: 1,
      });
      const speaks = () => capture.urls.filter((u) => u.endsWith(`/agents/${call.agentId}/speak`)).length;
      yield* Effect.promise(async () => {
        for (let i = 0; i < 300 && speaks() === 0; i++) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 300));
      });
      expect(speaks()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it("asks the orchestrator for one answer of everything that waited", () => {
    expect(onCallLine(["#41「写打卡」交回来了，等你验收", "#42「修登录」这一轮没做成"])).toBe(
      "【要告诉主人】\n- #41「写打卡」交回来了，等你验收\n- #42「修登录」这一轮没做成\n\n主人正在和你通电话，你的回答会念给主人听：这 2 件合成一段说，一件一句，口语，先说结论；不念代码、路径、命令和长列表。",
    );
    expect(onCallLine([], "阿狐：做完了。打卡写好了")).toBe(
      "主人接起了你打的电话。你打电话是为了这件事：阿狐：做完了。打卡写好了\n先开口说这些：一两句，口语，先说结论；不念代码、路径、命令和长列表。",
    );
  });

  it("cuts what is read out under Agora's 512 bytes, at a sentence's end", () => {
    expect(speakPieces("短的一句。")).toEqual(["短的一句。"]);
    const long = "第一句说的是工单交回来了。".repeat(20);
    const pieces = speakPieces(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(480);
    expect(pieces.every((p) => p.endsWith("。"))).toBe(true);
    expect(pieces.join("")).toBe(long);
  });

  it.live("says Agora's model answers a call it answers", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      yield* credentials({ answer: { vendor: "agora", model: "gpt-4.1-mini" } });
      const grant = yield* voice.session();
      expect((yield* voice.start(grant.channel, grant.uid)).answeredBy).toBe("agora");
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
      expect(yield* Effect.flip(voice.heard(call.agentId, "late", "", ""))).toMatchObject({
        _tag: "VoiceAgentFailed",
      });
      expect(yield* Effect.flip(voice.said(call.agentId, "late"))).toMatchObject({
        _tag: "VoiceAgentFailed",
      });
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it.live("relays the owner's words without a call id only with one call on", () =>
    Effect.gen(function* () {
      const voice = yield* Voice;
      expect(yield* Effect.flip(voice.heardCurrent("none", "", ""))).toMatchObject({
        _tag: "VoiceAgentFailed",
      });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture()))),
  );

  it.live("says dictation is not set up", () =>
    Effect.gen(function* () {
      const voice = yield* Voice;
      expect(yield* Effect.flip(voice.dictate("AAAA", "wav"))).toMatchObject({
        _tag: "VoiceUnavailable",
        reason: expect.stringContaining("听写还没配"),
      });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture()))),
  );

  it.live("sends a recording to the dictation address, and says what it answered when it is not a transcription", () =>
    Effect.gen(function* () {
      const asked: { auth: string; body: string }[] = [];
      let answer = { status: 200, body: JSON.stringify({ text: " 你好 " }) };
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          asked.push({
            auth: req.headers.authorization ?? "",
            body: Buffer.concat(chunks).toString(),
          });
          res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body);
        });
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void))),
        () => Effect.sync(() => server.close()),
      );
      const { port } = server.address() as AddressInfo;
      const setting = yield* Setting;
      yield* Effect.orDie(
        setting.save({
          dictation: { url: `http://127.0.0.1:${port}/v1`, model: "whisper-1" },
          dictationKey: "k",
        }),
      );
      const voice = yield* Voice;
      expect(yield* voice.dictate("AAAA", "wav")).toEqual({ text: "你好" });
      expect(asked[0]?.auth).toBe("Bearer k");
      expect(asked[0]?.body).toContain("whisper-1");
      answer = { status: 500, body: JSON.stringify({ error: { message: "模型没加载" } }) };
      expect(yield* Effect.flip(voice.dictate("AAAA", "wav"))).toMatchObject({
        reason: expect.stringContaining("回了 500：模型没加载"),
      });
      answer = { status: 200, body: "<html>" };
      expect(yield* Effect.flip(voice.dictate("AAAA", "wav"))).toMatchObject({
        reason: expect.stringContaining("不是 OpenAI 的转写格式"),
      });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture()))),
  );
});
