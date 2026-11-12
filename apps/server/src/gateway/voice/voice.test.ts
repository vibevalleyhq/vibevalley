import { createServer } from "node:http";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { reasonOf } from "@vibevalley/async";
import type { Issue, Session, VoiceSettings } from "@vibevalley/protocol";
import { ApiError, BizCode } from "@vibevalley/protocol/api";
import { sessionId, issueId } from "@vibevalley/protocol/schema";

import recorded from "#/gateway/voice/testdata/voice-requests.json" with { type: "json" };
import type { Time } from "#/infra/time.ts";
import { makeOrchestrator, type Orchestrator } from "#/modules/orchestrator/orchestrator.ts";
import { makeProvider, type Provider } from "#/modules/provider/provider.ts";
import { NotAnswered } from "#/modules/session/host.ts";
import type { Setting } from "#/modules/setting/setting.ts";
import { defaultVoice } from "#/modules/setting/voice.ts";
import { inboxStart } from "#/services.ts";
import { nextTurn, testConfig, until } from "#/testing/layers.ts";
import { type World, world } from "#/testing/world.ts";

import { onCallLine } from "./prompts.ts";
import {
  agentFor,
  type CallLine,
  clientOf,
  makeVoice,
  retrying,
  speakPieces,
  tokenSeconds,
  tunnelAnswers,
  vendorsFor,
  type Voice,
  voiceAgentUid,
  voiceUnknown,
} from "./voice.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A clock held still: it moves only when the test moves it, and every wait due by then wakes in order. */
function heldTime(start = 0): Time & { readonly adjust: (ms: number) => Promise<void> } {
  let at = start;
  const sleepers = new Set<{ readonly until: number; readonly wake: () => void }>();
  const sleep = (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
    if (ms <= 0) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const sleeper = { until: at + ms, wake: resolve };
    sleepers.add(sleeper);
    signal?.addEventListener(
      "abort",
      () => {
        sleepers.delete(sleeper);
        reject(reasonOf(signal));
      },
      { once: true },
    );
    return promise;
  };
  return {
    now: () => at,
    sleep,
    after: (ms, f) => {
      const stop = new AbortController();
      sleep(ms, stop.signal).then(f, () => undefined);
      return () => stop.abort();
    },
    adjust: async (ms) => {
      const end = at + ms;
      for (;;) {
        for (let i = 0; i < 5; i++) await nextTurn();
        const due = [...sleepers].filter((s) => s.until <= end).toSorted((a, b) => a.until - b.until)[0];
        if (due === undefined) break;
        sleepers.delete(due);
        at = due.until;
        due.wake();
      }
      at = end;
    },
  };
}

/** A dictation upload that never answers: it ends only when its signal aborts. */
const pendingDictation = () => {
  let seen: AbortSignal | undefined;
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  const fetch: typeof globalThis.fetch = (_input, init) => {
    const signal = init?.signal ?? undefined;
    seen = signal;
    entered();
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  return { fetch, started, signal: () => seen };
};

const appId = "11111111111111111111111111111111";
const cert = "22222222222222222222222222222222";

const decodeRequest = (body: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object: " + body);
  return Object.fromEntries(Object.entries(parsed));
};

/** Agora's REST calls, kept; each answered as given (an agent by default). */
class Capture {
  readonly urls: string[] = [];
  readonly requests: Record<string, unknown>[] = [];
  /** Each request's Authorization header, as Agora would read it. */
  readonly auths: string[] = [];
  status = 200;
  body = `{"agent_id":"parity-agent"}`;
  before: ((call: string) => Promise<void> | undefined) | undefined;
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = (init?.method ?? "GET") + " " + url;
    this.urls.push(call);
    this.auths.push(new Headers(init?.headers).get("authorization") ?? "");
    this.requests.push(typeof init?.body === "string" ? decodeRequest(init.body) : {});
    await this.before?.(call);
    return new Response(this.body, {
      status: this.status,
      headers: { "content-type": "application/json" },
    });
  };
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

const cases = recorded as Case[];

describe("a call's agent", () => {
  for (const c of cases)
    test(`questions Agora as recorded: ${c.name}`, async () => {
      const vendors = vendorsFor(
        c.voice,
        { asrKey: c.keys.asrKey ?? "", llmKey: c.keys.llmKey ?? "", ttsKey: c.keys.ttsKey ?? "" },
        c.deepseekKey ?? "",
        c.line,
      );
      if (vendors instanceof ApiError) throw new Error(vendors.reason);
      const capture = new Capture();
      const client = clientOf({ appId, appCertificate: cert }, c.voice.area, heldTime(), capture.fetch);
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

  test("says which key is missing", () => {
    // The quick model, so the rest needs no line; the default (the orchestrator) needs the line and nothing else.
    expect(vendorsFor(defaultVoice(), { asrKey: "", llmKey: "", ttsKey: "" }, "")).toMatchObject({
      message: "助手的语音线路没接通",
    });
    const d: VoiceSettings = {
      ...defaultVoice(),
      answer: { vendor: "agora", model: "gpt-4.1-mini" },
    };
    const none = { asrKey: "", llmKey: "", ttsKey: "" };
    const problem = (v: VoiceSettings, deepseek = "", line?: CallLine) => {
      const got = vendorsFor(v, none, deepseek, line);
      return got instanceof ApiError ? got.reason : "";
    };
    // Where Settings fixes it, for the page's jump there.
    const fixedIn = (v: VoiceSettings, deepseek = "") => {
      const got = vendorsFor(v, none, deepseek);
      return got instanceof ApiError ? got.settings : undefined;
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

interface VoiceFarm extends AsyncDisposable {
  readonly world: World;
  readonly voice: Voice;
  readonly provider: Provider;
  readonly setting: Setting;
}

/** The farm with a voice service, its line on a free port behind a line of its own. A provider of its own sends
 * dictation through fetch, on clock. */
const farm = async (
  capture: Capture,
  options: { readonly brief?: Orchestrator["brief"]; readonly fetch?: typeof fetch; readonly clock?: Time } = {},
): Promise<VoiceFarm> => {
  const config = {
    ...testConfig(),
    voice: { id: "", line: { port: 0, url: "https://line.example.com" } },
  };
  const w = await world({ config });
  try {
    await inboxStart(w);
    const orchestrator = await makeOrchestrator(w);
    w.closes.push(() => orchestrator.close());
    const provider =
      options.fetch || options.clock ? await makeProvider({ ...w, fetch: options.fetch ?? w.fetch, clock: options.clock ?? w.clock }) : w.provider;
    const voice = await makeVoice(
      { ...w, provider, orchestrator: options.brief ? { ...orchestrator, brief: options.brief } : orchestrator },
      { fetch: capture.fetch, gatherMs: 30 },
    );
    w.closes.push(() => voice.close());
    return { world: w, voice, provider, setting: w.setting, [Symbol.asyncDispose]: () => w.close() };
  } catch (e) {
    await w.close();
    throw e;
  }
};

/** A helper at work on an issue, and the issue, as the core has them. */
const helperOn = (id: string, issue: string, now: number) =>
  ({
    id,
    name: "阿狐" + id,
    agent: "lab",
    runtime: "pi",
    brief: "写打卡",
    hiredAt: now,
    runs: 1,
    issue,
    phase: { _tag: "working", since: now, doing: { action: "none", label: "" } },
    play: { station: 0, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] },
    refining: false,
  }) as unknown as Session;
const issueOf = (id: string, number: number, session: string, now: number) =>
  ({
    id: issueId(id),
    number,
    title: "写打卡",
    priority: "medium",
    deliver: "change",
    mandate: { strength: "explicit", maxBotReviewRounds: 3, autoSubmitPr: false },
    createdAt: now,
    assignments: [
      {
        id: `a-${id}`,
        issue: issueId(id),
        agent: "lab",
        assignedAt: now,
        executions: [{ kind: "worker", session: sessionId(session), startedAt: now }],
      },
    ],
    status: "in_progress",
    moves: [],
    findings: [],
    questions: [],
    description: "",
    blockedBy: [],
    criteria: [],
    checks: [],
    stage: { state: "working", acts: [] },
  }) satisfies Issue;

/** An issue the helper w works on is handed back: the inbox tells of it. */
const handedBack = (f: VoiceFarm, w: string, issue: string, n: number, outcome: "completed" | "failed", summary: string) => {
  const core = f.world.core;
  const now = f.world.clock.now();
  core.apply({ type: "sessionChanged", session: helperOn(w, issue, now) });
  core.apply({ type: "issueChanged", issue: issueOf(issue, n, w, now) });
  core.apply({
    type: "sessionReported",
    questions: [],
    checks: [],
    id: sessionId(w),
    outcome,
    summary,
    runs: 1,
  });
};

const credentials = async (f: VoiceFarm, voice?: Partial<VoiceSettings>) => {
  await f.setting.save({
    agoraAppId: appId,
    agoraAppCertificate: cert,
    ...(voice ? { voice: voice } : {}),
  });
};

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("it went through");
    },
    (e: unknown) => e,
  );

describe("voice", () => {
  test("signs a grant only with credentials, and renews it", async () => {
    await using f = await farm(new Capture());
    const voice = f.voice;
    expect(await refusal(voice.session())).toMatchObject({
      name: "ApiError",
      bizCode: BizCode.VoiceUnavailable,
      message: expect.stringContaining("App ID"),
    });
    await credentials(f);
    const s = await voice.session();
    expect(s.appId).toBe(appId);
    expect(s.channel.startsWith("vibevalley-")).toBe(true);
    expect(s.uid).not.toBe("");
    expect(s.token.startsWith("007")).toBe(true);
    const renewed = await voice.renew(s.channel, s.uid);
    expect([renewed.channel, renewed.uid, renewed.token !== ""]).toEqual([s.channel, s.uid, true]);
  });

  // Agora's retries, on the service's clock (provider's retrying): moved through, not waited for.
  test("retries 408, 429 and 5xx twice on the Clock, as Agora's SDK would, and nothing else", async () => {
    const clock = heldTime();
    // A retry's sleep is taken after the answer comes back: let it be taken, then move the clock.
    const step = (ms: number) => clock.adjust(ms);
    const answering = (...answers: [number, Record<string, string>?][]) => {
      const seen: number[] = [];
      const fetcher: typeof fetch = async () => {
        const [status, headers] = answers.shift()!;
        seen.push(status);
        return new Response("{}", { status, headers: headers ?? {} });
      };
      return { seen, call: () => retrying(fetcher, clock)("https://api.example") };
    };

    const flaky = answering([503], [502], [200]);
    const flakyCall = flaky.call();
    await step(999);
    expect(flaky.seen).toEqual([503]);
    await step(1);
    expect(flaky.seen).toEqual([503, 502]);
    await step(1_999);
    expect(flaky.seen).toEqual([503, 502]);
    await step(1);
    expect((await flakyCall).status).toBe(200);

    const busy = answering([429, { "Retry-After": "5" }], [200]);
    const busyCall = busy.call();
    await step(4_999);
    expect(busy.seen).toEqual([429]);
    await step(1);
    expect((await busyCall).status).toBe(200);

    const refused = answering([400]);
    expect((await refused.call()).status).toBe(400);
    expect(refused.seen).toEqual([400]);

    const down = answering([500], [500], [500]);
    const downCall = down.call();
    await step(1_000);
    await step(2_000);
    expect((await downCall).status).toBe(500);
    expect(down.seen).toEqual([500, 500, 500]);
  });

  test("asks a new tunnel every 2 s until it refuses a keyless request, and starts no ask after a minute", async () => {
    const clock = heldTime();
    const asking = (answer: (n: number) => number) => {
      const asked: number[] = [];
      const fetcher: typeof fetch = async () => {
        asked.push(clock.now());
        return new Response(null, { status: answer(asked.length) });
      };
      return { asked, answers: () => tunnelAnswers(fetcher, "https://line.example", clock) };
    };

    const late = asking((n) => (n < 3 ? 502 : 401));
    const lateAnswers = late.answers();
    await clock.adjust(4_000);
    expect(await lateAnswers).toBe(true);
    expect(late.asked).toEqual([0, 2_000, 4_000]);

    const start = clock.now();
    const never = asking(() => 404);
    const neverAnswers = never.answers();
    await clock.adjust(60_000);
    expect(await neverAnswers).toBe(false);
    expect(never.asked.map((at) => at - start)).toEqual(Array.from({ length: 30 }, (_, i) => i * 2_000));
  });

  test("starts and stops the orchestrator on his line", async () => {
    const capture = new Capture();
    await using f = await farm(capture);
    const voice = f.voice;
    await credentials(f, { answer: { vendor: "orchestrator" } });
    const grant = await voice.session();
    const agent = await voice.start(grant.channel, grant.uid);
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
    await voice.stop(agent.agentId);
    expect(voice.lines()).toBe(0);
    // A failure that is not retried: the retries have their own test (retrying, above).
    capture.status = 403;
    capture.body = `{"detail":"boom"}`;
    expect(await refusal(voice.stop("other"))).toMatchObject({ name: "ApiError", bizCode: BizCode.VoiceCallFailed });
  });

  test("keeps a quick model's transcript as a durable voice envelope", async () => {
    const capture = new Capture();
    await using f = await farm(capture);
    const voice = f.voice;
    await credentials(f, { answer: { vendor: "agora", model: "gpt-4.1-mini" } });
    const grant = await voice.session();
    const agent = await voice.start(grant.channel, grant.uid);
    await voice.heard(agent.agentId, "语音消息", "", "voice-1");
    const rows = await f.world.db.sql.query(`select d.source, m.meta from mailbox_delivery d
          join channel_message m on m.id = d.message_id where m.body = '语音消息'`);
    expect(rows).toEqual([{ source: "voice", meta: `{"ingressSource":"voice","spoken":true}` }]);
  });

  test("interrupting a start releases the line and stops the late agent", async () => {
    const capture = new Capture();
    const { promise: requested, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: answer, resolve: release } = Promise.withResolvers<void>();
    capture.before = (call) => {
      if (!call.endsWith("/join")) return undefined;
      arrived();
      return answer;
    };
    await using f = await farm(capture);
    const voice = f.voice;
    await credentials(f, { answer: { vendor: "orchestrator" } });
    const grant = await voice.session();
    const giveUp = new AbortController();
    const starting = voice.start(grant.channel, grant.uid, undefined, giveUp.signal);
    await requested;
    giveUp.abort();
    await starting.catch(() => undefined);
    capture.before = undefined;
    release();
    await until(() => capture.urls.some((url) => url.includes("/agents/parity-agent/leave")), "the late agent stopped");
    expect(voice.lines()).toBe(0);
    expect(await refusal(voice.start(grant.channel, grant.uid))).toMatchObject({
      name: "ApiError",
      bizCode: BizCode.VoiceUnavailable,
      message: expect.stringContaining("失效"),
    });
  });

  test("keeps a call's credentials and line whatever the settings say later", async () => {
    const capture = new Capture();
    await using f = await farm(capture);
    const voice = f.voice;
    await credentials(f, { area: "EU", answer: { vendor: "orchestrator" } });
    const grant = await voice.session();
    const agent = await voice.start(grant.channel, grant.uid);
    const started = capture.urls[0]!;
    await f.setting.save({
      agoraAppId: "33333333333333333333333333333333",
      voice: { area: "US" } as never,
    });
    capture.status = 403;
    capture.body = `{"detail":"refused"}`;
    await refusal(voice.stop(agent.agentId));
    // A failed remote stop keeps no local line.
    expect(voice.lines()).toBe(0);
    capture.status = 200;
    capture.body = "{}";
    await voice.stop(agent.agentId);
    for (const url of capture.urls.slice(1)) {
      expect(url).toContain(appId);
      expect(url).not.toContain("33333333333333333333333333333333");
      if (started.includes("api-eu")) expect(url).toContain("api-eu");
    }
  });

  // An issue handed back while the user is on the call: the orchestrator's words about it are read out on the call, queued after what is being said.
  test("tells the user on the call when an issue comes to want the user", async () => {
    const capture = new Capture();
    await using f = await farm(capture);
    const voice = f.voice;
    await credentials(f, { answer: { vendor: "orchestrator" } });
    expect(await voice.speak("没人在听")).toBe(false);
    const grant = await voice.session();
    const call = await voice.start(grant.channel, grant.uid);
    handedBack(f, "w1", "t1", 41, "completed", "做完了");
    await until(() => capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`)), "spoken");
    const at = capture.urls.findIndex((u) => u.endsWith(`/agents/${call.agentId}/speak`));
    const spoken = capture.requests[at]!;
    expect(spoken).toMatchObject({ priority: "APPEND", interruptable: true });
    // Agora answers 401 to a speak without the session's ConvoAI token: it once went out bare and was never heard.
    expect(capture.auths[at]).toMatch(/^agora token=\S+/u);
    expect(String(spoken.text)).not.toBe("");
  });

  // Answering a ring: no greeting, the orchestrator's first words are what rang.
  test("opens a call that answers a ring with what rang", async () => {
    const capture = new Capture();
    await using f = await farm(capture);
    const voice = f.voice;
    await credentials(f, { answer: { vendor: "orchestrator" } });
    const grant = await voice.session();
    const call = await voice.start(grant.channel, grant.uid, "#41「写打卡」交回来了，等你验收");
    const llm = (capture.requests[0]!.properties as Record<string, Record<string, unknown>>).llm!;
    expect(llm.greeting_message ?? "").toBe("");
    await until(() => capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`)), "spoken");
  });

  // Two issues handed back one after the other: one ask of the orchestrator, one answer read out, not two crowding.
  test("tells what comes together once, in one answer", async () => {
    const capture = new Capture();
    await using f = await farm(capture);
    const voice = f.voice;
    const core = f.world.core;
    await credentials(f, { answer: { vendor: "orchestrator" } });
    const grant = await voice.session();
    const call = await voice.start(grant.channel, grant.uid);
    const now = f.world.clock.now();
    for (const [w, t, n] of [
      ["w1", "t1", 41],
      ["w2", "t2", 42],
    ] as const) {
      core.apply({ type: "sessionChanged", session: helperOn(w, t, now) });
      core.apply({ type: "issueChanged", issue: issueOf(t, n, w, now) });
    }
    core.apply({ type: "sessionReported", questions: [], checks: [], id: sessionId("w1"), outcome: "completed", summary: "做完了", runs: 1 });
    core.apply({ type: "sessionReported", questions: [], checks: [], id: sessionId("w2"), outcome: "failed", summary: "没做成", runs: 1 });
    const speaks = () => capture.urls.filter((u) => u.endsWith(`/agents/${call.agentId}/speak`)).length;
    await until(() => speaks() > 0, "spoken");
    // Both reports were gathered into that one answer; nothing to wait on shows no second one follows.
    // oxlint-disable-next-line vibevalley/no-test-sleep
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(speaks()).toBe(1);
  });

  test("a rejected brief is contained and a later update can be told", async () => {
    const capture = new Capture();
    let asks = 0;
    const brief = async () => {
      asks++;
      if (asks === 1) throw new NotAnswered("brief failed");
      return "第二件说完了";
    };
    await using f = await farm(capture, { brief });
    const voice = f.voice;
    await credentials(f, { answer: { vendor: "orchestrator" } });
    const grant = await voice.session();
    const call = await voice.start(grant.channel, grant.uid);
    handedBack(f, "w1", "t1", 41, "completed", "做完了");
    await until(() => asks === 1, "the failed brief");
    handedBack(f, "w2", "t2", 42, "failed", "没做成");
    await until(() => capture.requests.some((r) => r.text === "第二件说完了"), "the next brief");
    expect(capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`))).toBe(true);
  });

  test("closing Voice aborts a brief that has not finished", async () => {
    const capture = new Capture();
    let asked = 0;
    let cancelled = false;
    const brief = (_line: string, signal?: AbortSignal) => {
      asked++;
      return new Promise<string>((_resolve, reject) =>
        signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    };
    await using f = await farm(capture, { brief });
    const voice = f.voice;
    await credentials(f, { answer: { vendor: "orchestrator" } });
    const grant = await voice.session();
    const call = await voice.start(grant.channel, grant.uid);
    handedBack(f, "w1", "t1", 41, "completed", "做完了");
    await until(() => asked === 1, "the pending brief");
    await voice.close();
    expect(cancelled).toBe(true);
    // Closed: nothing of the voice runs any more to speak.
    expect(capture.urls.some((u) => u.endsWith(`/agents/${call.agentId}/speak`))).toBe(false);
  });

  test("hanging up between speech pieces sends no later piece", async () => {
    const capture = new Capture();
    const { promise: first, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    // Counted from every request Agora got, so the count goes on after the hold below is lifted.
    const speaks = () => capture.urls.filter((u) => u.endsWith("/speak")).length;
    capture.before = (call) => {
      if (!call.endsWith("/speak") || speaks() !== 1) return undefined;
      arrived();
      return held;
    };
    await using f = await farm(capture, { brief: async () => "这一句要分很多段念。".repeat(40) });
    const voice = f.voice;
    await credentials(f, { answer: { vendor: "orchestrator" } });
    const grant = await voice.session();
    const call = await voice.start(grant.channel, grant.uid);
    handedBack(f, "w1", "t1", 41, "completed", "做完了");
    await first;
    await voice.stop(call.agentId);
    release();
    // The held piece went out; nothing to wait on shows that no later piece does.
    // oxlint-disable-next-line vibevalley/no-test-sleep
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(speaks()).toBe(1);
  });

  test("asks the orchestrator for one answer of everything that waited", () => {
    expect(onCallLine(["#41「写打卡」交回来了，等你验收", "#42「修登录」这一轮没做成"])).toBe(
      "【要告诉用户】\n- #41「写打卡」交回来了，等你验收\n- #42「修登录」这一轮没做成\n\n用户正在和你通电话，你的回答会念给用户听：这 2 件合成一段说，一件一句，口语，先说结论；不念代码、路径、命令和长列表。",
    );
    expect(onCallLine([], "阿狐：做完了。打卡写好了")).toBe(
      "用户接起了你打的电话。你打电话是为了这件事：阿狐：做完了。打卡写好了\n先开口说这些：一两句，口语，先说结论；不念代码、路径、命令和长列表。",
    );
  });

  test("cuts what is read out under Agora's 512 bytes, at a sentence's end", () => {
    expect(speakPieces("短的一句。")).toEqual(["短的一句。"]);
    const long = "第一句说的是工单交回来了。".repeat(20);
    const pieces = speakPieces(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(480);
    expect(pieces.every((p) => p.endsWith("。"))).toBe(true);
    expect(pieces.join("")).toBe(long);
  });

  test("takes no transcripts from a call that is hanging up", async () => {
    const capture = new Capture();
    await using f = await farm(capture);
    const voice = f.voice;
    await credentials(f);
    const grant = await voice.session();
    const call = await voice.start(grant.channel, grant.uid);
    capture.status = 403;
    capture.body = `{"detail":"stop failed"}`;
    await refusal(voice.stop(call.agentId));
    expect(await refusal(voice.heard(call.agentId, "late", "", ""))).toMatchObject({
      name: "ApiError",
      bizCode: BizCode.VoiceCallFailed,
    });
    expect(await refusal(voice.said(call.agentId, "late"))).toMatchObject({
      name: "ApiError",
      bizCode: BizCode.VoiceCallFailed,
    });
  });

  test("relays the user's words without a call id only with one call on", async () => {
    await using f = await farm(new Capture());
    expect(await refusal(f.voice.heardCurrent("none", "", ""))).toMatchObject({
      name: "ApiError",
      bizCode: BizCode.VoiceCallFailed,
    });
  });

  test("validates dictation responses and keeps ordinary HTTP errors", async () => {
    const answers = [
      { status: 200, body: `{"text":123}` },
      { status: 200, body: `[]` },
      { status: 200, body: `{"text":" 好 "}` },
      { status: 500, body: `{"error":{"message":"bad"}}` },
    ];
    let seen = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const answer = answers[seen++]!;
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => void server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      await using f = await farm(new Capture());
      await f.setting.save({ dictation: { via: "own", url: `http://127.0.0.1:${port}/v1`, model: "m" } });
      const voice = f.voice;
      for (let i = 0; i < 2; i++) {
        expect(await refusal(voice.dictate("AAAA", "wav"))).toMatchObject({
          name: "ApiError",
          bizCode: BizCode.VoiceUnavailable,
          message: expect.stringContaining("转写格式"),
        });
      }
      expect(await voice.dictate("AAAA", "wav")).toEqual({ text: "好" });
      expect(await refusal(voice.dictate("AAAA", "wav"))).toMatchObject({
        name: "ApiError",
        bizCode: BizCode.VoiceUnavailable,
        message: expect.stringContaining("500：bad"),
      });
      expect(seen).toBe(4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("interrupting dictation aborts its upload", async () => {
    const pending = pendingDictation();
    await using f = await farm(new Capture(), { fetch: pending.fetch });
    await f.setting.save({ dictation: { via: "own", url: "http://dictation.test/v1", model: "whisper-1" } });
    const giveUp = new AbortController();
    const dictating = f.voice.dictate("AAAA", "wav", giveUp.signal);
    await pending.started;
    giveUp.abort();
    await dictating.catch(() => undefined);
    expect(pending.signal()?.aborted).toBe(true);
  });

  test("dictation's timeout still aborts its upload", async () => {
    const pending = pendingDictation();
    const clock = heldTime(1_800_000_000_000);
    await using f = await farm(new Capture(), { fetch: pending.fetch, clock });
    await f.setting.save({ dictation: { via: "own", url: "http://dictation.test/v1", model: "whisper-1" } });
    const dictating = refusal(f.voice.dictate("AAAA", "wav"));
    await pending.started;
    await clock.adjust(120_000);
    const failure = await dictating;
    expect(pending.signal()?.aborted).toBe(true);
    expect(failure).toMatchObject({ name: "ApiError", bizCode: BizCode.VoiceUnavailable, settings: "dictation" });
  });

  test("says dictation is not set up: MOSS without its key, or an own address left empty", async () => {
    await using f = await farm(new Capture());
    const voice = f.voice;
    expect(f.setting.status().readiness.dictation.ready).toBe(false);
    expect(await refusal(voice.dictate("AAAA", "wav"))).toMatchObject({
      name: "ApiError",
      bizCode: BizCode.VoiceUnavailable,
      message: expect.stringContaining("默认听写连接"),
      settings: "dictation",
    });
    await f.setting.save({ dictation: { via: "own", url: "", model: "" } });
    expect(await refusal(voice.dictate("AAAA", "wav"))).toMatchObject({
      name: "ApiError",
      bizCode: BizCode.VoiceUnavailable,
      message: expect.stringContaining("听写还没配"),
    });
  });

  test("dictation goes to MOSS's transcription by default, with the MOSS key", async () => {
    const sent: { url: string; auth: string | null; model: unknown; format: unknown; file: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("not a form");
      const file = form.get("file");
      sent.push({
        url: input instanceof Request ? input.url : input.toString(),
        auth: new Headers(init?.headers).get("authorization"),
        model: form.get("model"),
        format: form.get("response_format"),
        file: file instanceof File ? file.name : undefined,
      });
      return new Response(`{"text":" 你好 "}`, { status: 200, headers: { "content-type": "application/json" } });
    };
    await using f = await farm(new Capture(), { fetch });
    const setting = f.setting;
    const provider = f.provider;
    await provider.update({
      revision: 0,
      connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "sk-moss-test" }],
      dictation: { connection: "moss", model: "moss-transcribe-1.0" },
      understanding: null,
      speech: null,
      image: null,
      speakers: null,
      voiceDesign: null,
      transcription: null,
      vision: null,
      live: null,
    });
    expect(setting.status().dictation.via).toBe("moss");
    expect(setting.status().readiness.dictation.ready).toBe(true);
    const voice = f.voice;
    expect(await voice.dictate("AAAA", "wav")).toEqual({ text: "你好" });
    expect(sent).toEqual([
      {
        url: "https://api.mosi.cn/v1/audio/transcriptions",
        auth: "Bearer sk-moss-test",
        model: "moss-transcribe-1.0",
        format: "json",
        file: "dictation.wav",
      },
    ]);
    // The user's own address, chosen, keeps its own key; switching back to MOSS finds it again.
    await setting.save({ dictation: { via: "own", url: "http://dictation.test/v1", model: "whisper-1" }, dictationKey: "own-key" });
    await voice.dictate("AAAA", "wav");
    expect(sent[1]).toMatchObject({ url: "http://dictation.test/v1/audio/transcriptions", auth: "Bearer own-key", model: "whisper-1" });
    await setting.save({ dictation: { via: "moss", url: "http://dictation.test/v1", model: "whisper-1" } });
    expect(setting.status().dictation).toEqual({ via: "moss", url: "http://dictation.test/v1", model: "whisper-1" });
    await voice.dictate("AAAA", "wav");
    expect(sent[2]).toMatchObject({ url: "https://api.mosi.cn/v1/audio/transcriptions", auth: "Bearer sk-moss-test" });
    await provider.update({
      revision: 1,
      connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true }],
      dictation: { connection: "moss", model: "moss-transcribe-diarize-pro" },
      understanding: null,
      speech: null,
      image: null,
      speakers: null,
      voiceDesign: null,
      transcription: null,
      vision: null,
      live: null,
    });
    await voice.dictate("AAAA", "wav");
    expect(sent[3]).toMatchObject({ auth: "Bearer sk-moss-test", model: "moss-transcribe-diarize-pro", format: "json" });
    expect(sent).toHaveLength(4);
  });

  test("runs a farm call over MOSS Live without Agora credentials or tunnel, routing heard, said, and speak", async () => {
    const capture = new Capture();
    await using f = await farm(capture);
    const voice = f.voice;
    await f.setting.save({ voice: { answer: { vendor: "moss" } } });
    expect(await refusal(voice.session())).toMatchObject({
      name: "ApiError",
      bizCode: BizCode.VoiceUnavailable,
      settings: "moss",
    });
    await f.provider.update({
      revision: 0,
      connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "sk-moss-call-key" }],
      dictation: null,
      image: null,
      understanding: null,
      speech: null,
      speakers: null,
      voiceDesign: null,
      transcription: null,
      vision: null,
      live: { connection: "moss", model: "moss-live-1.0" },
    });
    const grant = await voice.session();
    expect(grant.appId).toBe("moss");
    const renewed = await voice.renew(grant.channel, grant.uid);
    expect(renewed.appId).toBe("moss");
    const call = await voice.start(grant.channel, grant.uid);
    expect(call.agentId.startsWith("moss-")).toBe(true);
    expect(capture.urls).toEqual([]);
    expect(voice.lines()).toBe(0);

    await voice.heard(call.agentId, "帮我看一下工单", "", "moss-voice-1");
    await voice.said(call.agentId, "好，我这就去查。");
    expect(await voice.speak("41 号工单做完了。")).toBe(true);

    const rows = await f.world.db.sql.query(`select body from channel_message order by id`);
    const bodies = rows.map((r) => r["body"]);
    expect(bodies).toContain("帮我看一下工单");
    expect(bodies).toContain("好，我这就去查。");
    expect(bodies).not.toContain("41 号工单做完了。");

    await voice.stop(call.agentId);
    expect(await voice.speak("挂断后不再播报")).toBe(false);
  });
});
