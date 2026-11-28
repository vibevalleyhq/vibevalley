import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Agent, ProviderStatus } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import { setListenToReports } from "../model/reportPlayback";

const flashProvider = (base: ProviderStatus): ProviderStatus => ({
  ...base,
  speech: { connection: base.connections[0]?.id ?? "moss", model: "moss-tts-1.5-flash" },
});

test("Channel Listen to reports queues concurrent worker reports with Agent.voice sequentially via host audio", async () => {
  setLocale("en");
  setListenToReports(false);
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "en" });
  const baseAgents = scenarios.typical.responses["agent.list"] as Agent[];
  const laozhouId = baseAgents.find((a) => a.role === "worker")?.id ?? "laozhou";
  const agentsWithVoice = baseAgents.map((a) => (a.id === laozhouId ? { ...a, voice: "voice-alpha" } : a));
  fake.respond("agent.list", () => agentsWithVoice);
  fake.respond("provider.get", () => flashProvider(scenarios.typical.responses["provider.get"] as ProviderStatus));

  let speechSeq = 0;
  const startedVoices: string[] = [];
  const activeHostIds: string[] = [];
  const speechPhaseByJob = new Map<string, "playing" | "idle">();

  fake.respond("media.speech.create", (payload: { voice: string; text: string }) => {
    speechSeq++;
    const id = `speech-job-${speechSeq}`;
    startedVoices.push(`${payload.voice}:${payload.text}`);
    speechPhaseByJob.set(id, "playing");
    return {
      kind: "speech",
      id,
      connection: "moss",
      revision: 0,
      text: payload.text,
      voice: payload.voice,
      format: "pcm",
      asynchronous: false,
      streaming: true,
      phase: "waiting",
      createdAt: SCENARIO_NOW,
      updatedAt: SCENARIO_NOW,
    };
  });
  fake.respond("host.speechStart", (payload: { id: string }) => {
    activeHostIds.push(payload.id);
    return { phase: "playing", problem: null };
  });
  fake.respond("host.speechState", (payload: { id: string }) => {
    const phase = speechPhaseByJob.get(payload.id) ?? "idle";
    return { phase, problem: null };
  });
  fake.respond("host.speechStop", () => ({ phase: "idle", problem: null }));

  const app = await open("../../../app/main.tsx", {
    width: 1100,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:channel-more-menu") === 1);

  await app.press("id:channel-more-menu");
  await fake.pumpUntil(app, () => app.count("id:more-listen-reports") === 1);
  await app.press("id:more-listen-reports");
  await fake.pump(app);

  // Two worker reports arrive concurrently: second must wait until first finishes.
  await fake.emit(app, "channel.follow", {
    _tag: "Message",
    message: {
      id: "r1",
      number: 901,
      channel: "general",
      from: laozhouId,
      agent: laozhouId,
      actor: { kind: "agent", id: laozhouId, role: "worker", forUser: false },
      name: "Lao Zhou",
      kind: "report",
      text: "First issue complete.",
      mentions: [],
      outcome: null,
      spoken: false,
      at: SCENARIO_NOW + 1,
      revision: 901,
      reactions: [],
      attachments: [],
      embeds: [],
    },
  });
  await fake.emit(app, "channel.follow", {
    _tag: "Message",
    message: {
      id: "r2",
      number: 902,
      channel: "general",
      from: laozhouId,
      agent: laozhouId,
      actor: { kind: "agent", id: laozhouId, role: "worker", forUser: false },
      name: "Lao Zhou",
      kind: "report",
      text: "Second issue complete.",
      mentions: [],
      outcome: null,
      spoken: false,
      at: SCENARIO_NOW + 2,
      revision: 902,
      reactions: [],
      attachments: [],
      embeds: [],
    },
  });

  await fake.pumpUntil(app, () => activeHostIds.length === 1);
  expect(startedVoices).toEqual(["voice-alpha:First issue complete."]);
  expect(activeHostIds).toEqual(["speech-job-1"]);

  // Finish the first report playback cleanly; the second now starts in order.
  speechPhaseByJob.set("speech-job-1", "idle");
  await fake.pumpUntil(app, () => activeHostIds.length === 2, 2000);
  expect(startedVoices).toEqual(["voice-alpha:First issue complete.", "voice-alpha:Second issue complete."]);
  expect(activeHostIds).toEqual(["speech-job-1", "speech-job-2"]);

  // Turn toggle OFF and ensure cleanup stops cleanly.
  await app.press("id:channel-more-menu");
  await fake.pumpUntil(app, () => app.count("id:more-listen-reports") === 1);
  await app.press("id:more-listen-reports");
  await fake.pump(app);
});

test("AgentConfig UI allows picking Agent.voice paired with Speech connection", async () => {
  setLocale("en");
  const workers = scenarios.typical.responses["agent.list"] as Agent[];
  const workerId = workers.find((a) => a.role === "worker")?.id ?? "laozhou";
  const fake = fakeHost(scenarios.typical, { route: `/agents/${workerId}`, locale: "en" });
  fake.respond("provider.get", () => flashProvider(scenarios.typical.responses["provider.get"] as ProviderStatus));
  fake.respond("provider.voice.list", () => ({
    connection: "moss",
    revision: 0,
    voices: [{ id: "voice-bright", name: "Bright Voice" }],
    hasMore: false,
  }));

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:agent-voice") === 1);
  expect(app.count("id:agent-voice")).toBe(1);
});
