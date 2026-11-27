import { expect, test } from "nsh/test";

import type { Agent, ChatMessage, ProviderStatus } from "@vibevalley/protocol";
import { messageId } from "@vibevalley/protocol/schema";

import { isWorkerReportMessage, resolveReportVoiceTarget, sanitizeReportForSpeech, SerializedReportQueue } from "./reportPlayback";

const baseAgent = (overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent => ({
  code: "W-01",
  role: "worker",
  mode: "managed",
  duty: "",
  enabled: true,
  runtime: "claude",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  toolsets: ["issue", "channel"],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: [],
  look: {
    species: "bear",
    outfit: "farmer",
    orchestrator: null,
    build: "biped",
    head: "rounded",
    body: "#fff",
    trim: "#000",
    hat: "#ccc",
    eye: "#0ff",
  },
  ...overrides,
});

const baseProvider = (overrides: Partial<ProviderStatus> = {}): ProviderStatus => ({
  revision: 3,
  connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: { source: "settings", hint: "…a41c" } }],
  image: null,
  understanding: null,
  speech: { connection: "moss", model: "moss-tts-1.5-flash" },
  live: null,
  speakers: null,
  voiceDesign: null,
  transcription: null,
  vision: null,
  imageModels: [],
  understandingModels: [],
  speechModels: ["moss-tts-1.5-flash"],
  liveModels: [],
  speakersModels: [],
  voiceDesignModels: [],
  transcriptionModels: [],
  visionModels: [],
  ...overrides,
});

const baseReport = (number: number, agentId: string, text: string): ChatMessage => ({
  id: messageId(`msg-${number}`),
  number,
  channel: "general",
  from: agentId,
  agent: agentId,
  actor: { kind: "agent", id: agentId, role: "worker", forUser: false },
  name: agentId,
  kind: "report",
  text,
  mentions: [],
  outcome: null,
  spoken: false,
  at: 1000 + number,
  revision: number,
  reactions: [],
  attachments: [],
  embeds: [],
});

test("sanitizeReportForSpeech strips markdown noise and resolveReportVoiceTarget pairs strictly with Agent.voice", () => {
  expect(sanitizeReportForSpeech("### Done\nSee [PR](https://example.com) and `cargo test` ```ts\nconst x = 1;\n```")).toBe("Done See PR and cargo test");

  const agents = [baseAgent({ id: "laozhou", name: "Lao Zhou", voice: "voice-alpha" }), baseAgent({ id: "xiaolin", name: "Xiao Lin" })];
  const provider = baseProvider();

  expect(isWorkerReportMessage(baseReport(1, "laozhou", "Finished tests."))).toBe(true);
  expect(resolveReportVoiceTarget(baseReport(1, "laozhou", "Finished tests."), agents, provider)?.voice).toBe("voice-alpha");
  // Helper without Agent.voice is silently skipped.
  expect(resolveReportVoiceTarget(baseReport(2, "xiaolin", "Done too."), agents, provider)).toBeUndefined();
  // Missing Speech key / disabled connection silently skips.
  expect(
    resolveReportVoiceTarget(
      baseReport(3, "laozhou", "Done"),
      agents,
      baseProvider({ connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: { source: null } }] }),
    ),
  ).toBeUndefined();
  // Missing Speech binding silently skips.
  expect(resolveReportVoiceTarget(baseReport(4, "laozhou", "Done"), agents, baseProvider({ speech: null }))).toBeUndefined();
});

test("SerializedReportQueue plays concurrent reports sequentially without overlap and silently skips failures", async () => {
  let enabled = true;
  const events: string[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  const finishCurrent: (() => void)[] = [];

  const queue = new SerializedReportQueue(
    () => enabled,
    async (req) => {
      events.push(`synth:${req.voice}:${req.text}`);
      if (req.text.includes("synth-fail")) throw new Error("missing vendor key");
      return { id: `job-${req.text}` };
    },
    (id, changed, failed) => {
      if (id.includes("host-busy")) {
        events.push(`fail:${id}`);
        queueMicrotask(() => failed("audio is already reserved by a call"));
        return () => {};
      }
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      events.push(`start:${id}`);
      finishCurrent.push(() => {
        inFlight--;
        events.push(`finish:${id}`);
        changed("finished");
      });
      return () => {
        inFlight = Math.max(0, inFlight - 1);
      };
    },
  );

  queue.enqueue({ key: "general:1", text: "first", voice: "v1", connection: "moss", revision: 1 });
  queue.enqueue({ key: "general:2", text: "synth-fail", voice: "v2", connection: "moss", revision: 1 });
  queue.enqueue({ key: "general:3", text: "host-busy", voice: "v3", connection: "moss", revision: 1 });
  queue.enqueue({ key: "general:4", text: "fourth", voice: "v4", connection: "moss", revision: 1 });

  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["synth:v1:first", "start:job-first"]);
  expect(maxConcurrent).toBe(1);

  finishCurrent.shift()!();
  for (let i = 0; i < 20 && finishCurrent.length === 0; i++) await Promise.resolve();
  expect(events).toEqual([
    "synth:v1:first",
    "start:job-first",
    "finish:job-first",
    "synth:v2:synth-fail",
    "synth:v3:host-busy",
    "fail:job-host-busy",
    "synth:v4:fourth",
    "start:job-fourth",
  ]);
  expect(maxConcurrent).toBe(1);

  enabled = false;
  queue.stopAll();
  expect(queue.pendingCount).toBe(0);
});
