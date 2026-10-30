import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Clock, Context, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type { Issue, Session, VoiceSettings } from "@vibevalley/protocol";
import { sessionId, issueId } from "@vibevalley/protocol/schema";

import { Core } from "@/core/core.ts";
import { Orchestrator } from "@/orchestrator/orchestrator.ts";
import { notificationsStart } from "@/services.ts";
import { NotAnswered } from "@/session/host.ts";
import { Setting } from "@/setting/setting.ts";
import { defaultVoice } from "@/setting/voice.ts";
import { testConfig } from "@/testing/layers.ts";
import { until } from "@/testing/until.ts";
import { world } from "@/testing/world.ts";

import { onCallLine } from "./prompts.ts";
import {
  Voice,
  agentFor,
  type CallLine,
  clientOf,
  retrying,
  speakPieces,
  tokenSeconds,
  tunnelAnswers,
  vendorsFor,
  voiceAgentUid,
  voiceUnknown,
} from "./voice.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A dictation upload that never answers: it ends only when its signal aborts. The service's HttpClient reaches it as
 * FetchHttpClient.Fetch, provided to the test. */
const pendingDictation = () => {
  let seen: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>((done) => (entered = done));
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const signal = init?.signal ?? undefined;
    seen = signal;
    entered();
    return new Promise<Response>((_, reject) => {
      if (signal?.aborted === true) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return { fetch, started, signal: () => seen };
};

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
  before: ((call: string) => Promise<void> | undefined) | undefined;
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = (init?.method ?? "GET") + " " + url;
    this.urls.push(call);
    this.auths.push(new Headers(init?.headers).get("authorization") ?? "");
    this.requests.push(typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    await this.before?.(call);
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
      const client = clientOf({ appId, appCertificate: cert }, c.voice.area, (e, o) => Effect.runPromise(e, o), capture.fetch);
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
    expect(problem({ ...d, asr: { vendor: "whisper" } as never })).toContain(voiceUnknown());
    expect(fixedIn(deepseek)).toBe("models");
    expect(fixedIn({ ...d, asr: { vendor: "microsoft", region: "eastasia" } })).toBe("call");
    expect(fixedIn({ ...d, answer: { vendor: "orchestrator" } })).toBeUndefined();
  });
});

/** The farm with a voice service, its line on a free port behind a line of its own. */
const farm = (capture: Capture, brief?: Orchestrator["Service"]["brief"]) => {
  const config = {
    ...testConfig(),
    voice: { id: "", line: { port: 0, url: "https://line.example.com" } },
  };
  const answering = Orchestrator.layer({ listen: false }).pipe(Layer.provideMerge(world({ config }).pipe(notificationsStart)));
  const chosen = brief
    ? Layer.unwrap(Effect.map(Orchestrator, (current) => Layer.succeed(Orchestrator, Orchestrator.of({ ...current, brief })))).pipe(
        Layer.provideMerge(answering),
      )
    : answering;
  return Voice.layer({ fetch: capture.fetch, gatherMs: 30 }).pipe(Layer.provideMerge(chosen));
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
    refining: false,
  }) as unknown as Session;
const issueOf = (id: string, number: number, session: string) =>
  ({
    id: issueId(id),
    number,
    title: "写打卡",
    priority: "medium",
    deliver: "change",
    createdAt: Date.now(),
    sessions: [sessionId(session)],
    status: "in_progress",
    moves: [],
    findings: [],
    questions: [],
    description: "",
    blockedBy: [],
    criteria: [],
    checks: [],
    attention: { state: "working", acts: [] },
  }) satisfies Issue;

const credentials = (voice?: Partial<VoiceSettings>) =>
  Effect.gen(function* () {
    const setting = yield* Setting;
    yield* Effect.orDie(
      setting.save({
        agoraAppId: appId,
        agoraAppCertificate: cert,
        ...(voice ? { voice: voice } : {}),
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

  // Agora's retries, on the service's Clock (voice.ts retrying): moved through, not waited for.
  it.effect("retries 408, 429 and 5xx twice on the Clock, as Agora's SDK would, and nothing else", () =>
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context());
      // A retry's sleep is taken after the answer comes back: let it be taken, then move the clock.
      const step = (ms: number) =>
        Effect.andThen(
          Effect.promise(() => new Promise((r) => setImmediate(r))),
          TestClock.adjust(ms),
        );
      const answering = (...answers: [number, Record<string, string>?][]) => {
        const seen: number[] = [];
        const fetcher = (async () => {
          const [status, headers] = answers.shift()!;
          seen.push(status);
          return new Response("{}", { status, headers: headers ?? {} });
        }) as unknown as typeof fetch;
        return { seen, call: Effect.forkChild(Effect.promise(() => retrying(fetcher, (e, o) => run(e, o))("https://api.example"))) };
      };

      const flaky = answering([503], [502], [200]);
      const flakyCall = yield* flaky.call;
      yield* step(999);
      expect(flaky.seen).toEqual([503]);
      yield* step(1);
      expect(flaky.seen).toEqual([503, 502]);
      yield* step(1_999);
      expect(flaky.seen).toEqual([503, 502]);
      yield* step(1);
      expect((yield* Fiber.join(flakyCall)).status).toBe(200);

      const busy = answering([429, { "Retry-After": "5" }], [200]);
      const busyCall = yield* busy.call;
      yield* step(4_999);
      expect(busy.seen).toEqual([429]);
      yield* step(1);
      expect((yield* Fiber.join(busyCall)).status).toBe(200);

      const refused = answering([400]);
      expect((yield* Fiber.join(yield* refused.call)).status).toBe(400);
      expect(refused.seen).toEqual([400]);

      const down = answering([500], [500], [500]);
      const downCall = yield* down.call;
      yield* step(1_000);
      yield* step(2_000);
      expect((yield* Fiber.join(downCall)).status).toBe(500);
      expect(down.seen).toEqual([500, 500, 500]);
    }),
  );

  it.effect("asks a new tunnel every 2 s until it refuses a keyless request, and starts no ask after a minute", () =>
    Effect.gen(function* () {
      const asking = (answer: (n: number) => number) => {
        const asked: number[] = [];
        const client = HttpClient.make((request) =>
          Effect.map(Clock.currentTimeMillis, (at) => {
            asked.push(at);
            return HttpClientResponse.fromWeb(request, new Response(null, { status: answer(asked.length) }));
          }),
        );
        return { asked, answers: Effect.forkChild(tunnelAnswers(client, "https://line.example")) };
      };

      const late = asking((n) => (n < 3 ? 502 : 401));
      const lateFiber = yield* late.answers;
      yield* TestClock.adjust(4_000);
      expect(yield* Fiber.join(lateFiber)).toBe(true);
      expect(late.asked).toEqual([0, 2_000, 4_000]);

      const start = yield* Clock.currentTimeMillis;
      const never = asking(() => 404);
      const neverFiber = yield* never.answers;
      yield* TestClock.adjust(60_000);
      expect(yield* Fiber.join(neverFiber)).toBe(false);
      expect(never.asked.map((at) => at - start)).toEqual(Array.from({ length: 30 }, (_, i) => i * 2_000));
    }),
  );

  it.live("starts and stops the orchestrator on his line", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      yield* credentials({ answer: { vendor: "orchestrator" } });
      const grant = yield* voice.session();
      const agent = yield* voice.start(grant.channel, grant.uid);
      expect(agent.agentId).toBe("parity-agent");
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
      // A failure that is not retried: the retries have their own test (retrying, below).
      capture.status = 403;
      capture.body = `{"detail":"boom"}`;
      expect(yield* Effect.flip(voice.stop("other"))).toMatchObject({ _tag: "VoiceCallFailed" });
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it.live("interrupting a start releases the line and stops the late agent", () => {
    const capture = new Capture();
    let arrived = () => {};
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release = () => {};
    const answer = new Promise<void>((resolve) => {
      release = resolve;
    });
    capture.before = (call) => {
      if (!call.endsWith("/join")) return undefined;
      arrived();
      return answer;
    };
    return Effect.gen(function* () {
      const voice = yield* Voice;
      yield* credentials({ answer: { vendor: "orchestrator" } });
      const grant = yield* voice.session();
      const starting = yield* Effect.forkChild(voice.start(grant.channel, grant.uid));
      yield* Effect.promise(() => requested);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(starting));
      yield* Effect.yieldNow;
      capture.before = undefined;
      release();
      yield* Fiber.join(interrupting);
      yield* until(() => capture.urls.some((url) => url.includes("/agents/parity-agent/leave")), "the late agent stopped");
      expect(voice.lines()).toBe(0);
      expect(yield* Effect.flip(voice.start(grant.channel, grant.uid))).toMatchObject({
        _tag: "VoiceUnavailable",
        reason: expect.stringContaining("失效"),
      });
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
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
      capture.status = 403;
      capture.body = `{"detail":"refused"}`;
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
        questions: [],
        checks: [],
        id: sessionId("w1"),
        outcome: "completed",
        summary: "做完了",
        runs: 1,
      });
      yield* until(() => capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`)), "spoken");
      const at = capture.urls.findIndex((u) => u.endsWith(`/agents/${call.agentId}/speak`));
      const spoken = capture.requests[at]!;
      expect(spoken).toMatchObject({ priority: "APPEND", interruptable: true });
      // Agora answers 401 to a speak without the session's ConvoAI token: it once went out bare and was never heard.
      expect(capture.auths[at]).toMatch(/^agora token=\S+/u);
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
      yield* until(() => capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`)), "spoken");
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
        questions: [],
        checks: [],
        id: sessionId("w1"),
        outcome: "completed",
        summary: "做完了",
        runs: 1,
      });
      yield* core.apply({
        type: "report",
        questions: [],
        checks: [],
        id: sessionId("w2"),
        outcome: "failed",
        summary: "没做成",
        runs: 1,
      });
      const speaks = () => capture.urls.filter((u) => u.endsWith(`/agents/${call.agentId}/speak`)).length;
      yield* until(() => speaks() > 0, "spoken");
      // Both reports were gathered into that one answer; nothing to wait on shows no second one follows.
      // oxlint-disable-next-line vibevalley/no-test-sleep
      yield* Effect.sleep(300);
      expect(speaks()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it.live("a rejected brief is contained and a later update can be told", () => {
    const capture = new Capture();
    let asks = 0;
    const brief = () =>
      Effect.suspend(() => {
        asks++;
        return asks === 1 ? Effect.fail(new NotAnswered({ message: "brief failed", cause: undefined })) : Effect.succeed("第二件说完了");
      });
    return Effect.gen(function* () {
      const voice = yield* Voice;
      const core = yield* Core;
      yield* credentials({ answer: { vendor: "orchestrator" } });
      const grant = yield* voice.session();
      const call = yield* voice.start(grant.channel, grant.uid);
      yield* core.apply({ type: "hired", session: helperOn("w1", "t1") });
      yield* core.apply({ type: "issue", issue: issueOf("t1", 41, "w1") });
      yield* core.apply({
        type: "report",
        questions: [],
        checks: [],
        id: sessionId("w1"),
        outcome: "completed",
        summary: "做完了",
        runs: 1,
      });
      yield* until(() => asks === 1, "the failed brief");
      yield* core.apply({ type: "hired", session: helperOn("w2", "t2") });
      yield* core.apply({ type: "issue", issue: issueOf("t2", 42, "w2") });
      yield* core.apply({
        type: "report",
        questions: [],
        checks: [],
        id: sessionId("w2"),
        outcome: "failed",
        summary: "没做成",
        runs: 1,
      });
      yield* until(() => capture.requests.some((r) => r.text === "第二件说完了"), "the next brief");
      expect(capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(farm(capture, brief)));
  });

  it.live("closing Voice aborts a brief that has not finished", () => {
    const capture = new Capture();
    let asked = 0;
    let cancelled = false;
    const brief = () =>
      Effect.suspend(() => {
        asked++;
        return Effect.as(Effect.never, "不该念出来");
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => (cancelled = true))));
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const context = yield* Layer.buildWithScope(farm(capture, brief), scope);
      const voice = Context.get(context, Voice);
      const core = Context.get(context, Core);
      yield* Effect.provide(credentials({ answer: { vendor: "orchestrator" } }), context);
      const grant = yield* voice.session();
      const call = yield* voice.start(grant.channel, grant.uid);
      yield* core.apply({ type: "hired", session: helperOn("w1", "t1") });
      yield* core.apply({ type: "issue", issue: issueOf("t1", 41, "w1") });
      yield* core.apply({
        type: "report",
        questions: [],
        checks: [],
        id: sessionId("w1"),
        outcome: "completed",
        summary: "做完了",
        runs: 1,
      });
      yield* until(() => asked === 1, "the pending brief");
      yield* Scope.close(scope, Exit.void);
      expect(cancelled).toBe(true);
      // Closed: nothing of the voice runs any more to speak.
      expect(capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`))).toBe(false);
    }).pipe(Effect.scoped);
  });

  it.live("hanging up between speech pieces sends no later piece", () => {
    const capture = new Capture();
    let arrived = () => {};
    const first = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Counted from every request Agora got, so the count goes on after the hold below is lifted.
    const speaks = () => capture.urls.filter((u) => u.endsWith("/speak")).length;
    capture.before = (call) => {
      if (!call.endsWith("/speak") || speaks() !== 1) return undefined;
      arrived();
      return held;
    };
    return Effect.gen(function* () {
      const voice = yield* Voice;
      const core = yield* Core;
      yield* credentials({ answer: { vendor: "orchestrator" } });
      const grant = yield* voice.session();
      const call = yield* voice.start(grant.channel, grant.uid);
      yield* core.apply({ type: "hired", session: helperOn("w1", "t1") });
      yield* core.apply({ type: "issue", issue: issueOf("t1", 41, "w1") });
      yield* core.apply({
        type: "report",
        questions: [],
        checks: [],
        id: sessionId("w1"),
        outcome: "completed",
        summary: "做完了",
        runs: 1,
      });
      yield* Effect.promise(() => first);
      yield* voice.stop(call.agentId);
      release();
      // The held piece went out; nothing to wait on shows that no later piece does.
      // oxlint-disable-next-line vibevalley/no-test-sleep
      yield* Effect.sleep(80);
      expect(speaks()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(farm(capture, () => Effect.succeed("这一句要分很多段念。".repeat(40)))));
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

  it.live("takes no transcripts from a call that is hanging up", () => {
    const capture = new Capture();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      yield* credentials();
      const grant = yield* voice.session();
      const call = yield* voice.start(grant.channel, grant.uid);
      capture.status = 403;
      capture.body = `{"detail":"stop failed"}`;
      yield* Effect.flip(voice.stop(call.agentId));
      expect(yield* Effect.flip(voice.heard(call.agentId, "late", "", ""))).toMatchObject({
        _tag: "VoiceCallFailed",
      });
      expect(yield* Effect.flip(voice.said(call.agentId, "late"))).toMatchObject({
        _tag: "VoiceCallFailed",
      });
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it.live("relays the owner's words without a call id only with one call on", () =>
    Effect.gen(function* () {
      const voice = yield* Voice;
      expect(yield* Effect.flip(voice.heardCurrent("none", "", ""))).toMatchObject({
        _tag: "VoiceCallFailed",
      });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture()))),
  );

  it.live("validates dictation responses and keeps ordinary HTTP errors", () => {
    const capture = new Capture();
    const answers = [
      { status: 200, body: `{"text":123}` },
      { status: 200, body: `[]` },
      { status: 200, body: `{"text":" 好 "}` },
      { status: 500, body: `{"error":{"message":"bad"}}` },
    ];
    let seen = 0;
    return Effect.gen(function* () {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          const answer = answers[seen++]!;
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(answer.body);
        });
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      yield* Effect.orDie((yield* Setting).save({ dictation: { via: "own", url: `http://127.0.0.1:${port}/v1`, model: "m" } }));
      const voice = yield* Voice;
      for (let i = 0; i < 2; i++) {
        expect(yield* Effect.flip(voice.dictate("AAAA", "wav"))).toMatchObject({
          _tag: "VoiceUnavailable",
          reason: expect.stringContaining("转写格式"),
        });
      }
      expect(yield* voice.dictate("AAAA", "wav")).toEqual({ text: "好" });
      expect(yield* Effect.flip(voice.dictate("AAAA", "wav"))).toMatchObject({
        _tag: "VoiceUnavailable",
        reason: expect.stringContaining("500：bad"),
      });
      expect(seen).toBe(4);
    }).pipe(Effect.scoped, Effect.provide(farm(capture)));
  });

  it.live("interrupting dictation aborts its upload", () => {
    const pending = pendingDictation();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      const setting = yield* Setting;
      yield* Effect.orDie(setting.save({ dictation: { via: "own", url: "http://dictation.test/v1", model: "whisper-1" } }));
      const dictating = yield* Effect.forkChild(voice.dictate("AAAA", "wav"));
      yield* Effect.promise(() => pending.started);
      yield* Fiber.interrupt(dictating);
      expect(pending.signal()?.aborted).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture())), Effect.provideService(FetchHttpClient.Fetch, pending.fetch));
  });

  it.effect("dictation's timeout still aborts its upload", () => {
    const pending = pendingDictation();
    return Effect.gen(function* () {
      const voice = yield* Voice;
      const setting = yield* Setting;
      yield* Effect.orDie(setting.save({ dictation: { via: "own", url: "http://dictation.test/v1", model: "whisper-1" } }));
      const dictating = yield* Effect.forkChild(Effect.flip(voice.dictate("AAAA", "wav")));
      yield* Effect.promise(() => pending.started);
      yield* TestClock.adjust("120 seconds");
      const failure = yield* Fiber.join(dictating);
      expect(pending.signal()?.aborted).toBe(true);
      expect(failure).toMatchObject({ _tag: "VoiceUnavailable", settings: "dictation" });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture())), Effect.provideService(FetchHttpClient.Fetch, pending.fetch));
  });

  it.live("says dictation is not set up: MOSS without its key, or an own address left empty", () =>
    Effect.gen(function* () {
      const voice = yield* Voice;
      expect((yield* Setting).status().dictationReady).toBe(false);
      expect(yield* Effect.flip(voice.dictate("AAAA", "wav"))).toMatchObject({
        _tag: "VoiceUnavailable",
        reason: expect.stringContaining("MOSS 的 API Key"),
        settings: "dictation",
      });
      yield* Effect.orDie((yield* Setting).save({ dictation: { via: "own", url: "", model: "" } }));
      expect(yield* Effect.flip(voice.dictate("AAAA", "wav"))).toMatchObject({
        _tag: "VoiceUnavailable",
        reason: expect.stringContaining("听写还没配"),
      });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture()))),
  );

  it.live("dictation goes to MOSS's transcription by default, with the MOSS key", () => {
    const sent: { url: string; auth: string | null; model: unknown; format: unknown; file: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const form = init?.body as FormData;
      sent.push({
        url: input instanceof Request ? input.url : input.toString(),
        auth: new Headers(init?.headers).get("authorization"),
        model: form.get("model"),
        format: form.get("response_format"),
        file: (form.get("file") as File | null)?.name,
      });
      return new Response(JSON.stringify({ text: " 你好 " }), { status: 200, headers: { "content-type": "application/json" } });
    };
    return Effect.gen(function* () {
      const setting = yield* Setting;
      yield* Effect.orDie(setting.save({ mossKey: "sk-moss-test" }));
      expect(setting.status().dictation.via).toBe("moss");
      expect(setting.status().dictationReady).toBe(true);
      const voice = yield* Voice;
      expect(yield* voice.dictate("AAAA", "wav")).toEqual({ text: "你好" });
      expect(sent).toEqual([
        {
          url: "https://api.mosi.cn/v1/audio/transcriptions",
          auth: "Bearer sk-moss-test",
          model: "moss-transcribe-1.0",
          format: "json",
          file: "dictation.wav",
        },
      ]);
      // The owner's own address, chosen, keeps its own key; switching back to MOSS finds it again.
      yield* Effect.orDie(setting.save({ dictation: { via: "own", url: "http://dictation.test/v1", model: "whisper-1" }, dictationKey: "own-key" }));
      yield* voice.dictate("AAAA", "wav");
      expect(sent[1]).toMatchObject({ url: "http://dictation.test/v1/audio/transcriptions", auth: "Bearer own-key", model: "whisper-1" });
      yield* Effect.orDie(setting.save({ dictation: { via: "moss", url: "http://dictation.test/v1", model: "whisper-1" } }));
      expect(setting.status().dictation).toEqual({ via: "moss", url: "http://dictation.test/v1", model: "whisper-1" });
      yield* voice.dictate("AAAA", "wav");
      expect(sent[2]).toMatchObject({ url: "https://api.mosi.cn/v1/audio/transcriptions", auth: "Bearer sk-moss-test" });
    }).pipe(Effect.scoped, Effect.provide(farm(new Capture())), Effect.provideService(FetchHttpClient.Fetch, fetch));
  });
});
