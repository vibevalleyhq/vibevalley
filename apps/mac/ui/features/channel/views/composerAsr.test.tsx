import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

test("Channel composer dictates speech via host.asr* and sends dictated message", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "en" });
  let step = 0;
  let active = false;
  fake.respond("host.asrStart", () => {
    active = true;
    step = 0;
    return { phase: "listening", micLevel: 0.55, text: "", partial: "Check", problem: null };
  });
  fake.respond("host.asrState", () => {
    if (!active) return { phase: "idle", micLevel: 0, text: "Check the logs", partial: "", problem: null };
    step++;
    return {
      phase: "listening",
      micLevel: step % 2 === 0 ? 0.72 : 0.4,
      text: "Check",
      partial: "the logs",
      problem: null,
    };
  });
  fake.respond("host.asrStop", () => {
    active = false;
    return { phase: "idle", micLevel: 0, text: "Check the logs", partial: "", problem: null };
  });
  fake.respond("channel.message.send", () => null);

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:composer-dictate") === 1);

  await app.press("id:composer-dictate");
  await fake.pumpUntil(app, () => app.count("id:composer-dictating") === 1);
  expect(app.count("id:composer-waveform")).toBe(1);
  expect(app.value("id:composer-input")).toBe("Check");

  await app.press("id:composer-dictate");
  await fake.pump(app);
  expect(app.count("id:composer-dictating")).toBe(0);
  expect(app.value("id:composer-input")).toBe("Check the logs");

  await app.press("id:send");
  await fake.pump(app);
  const sent = fake.calls.findLast((c) => c.op === "channel.message.send");
  expect(sent).toBeDefined();
  expect((sent!.payload as { text: string }).text).toBe("Check the logs");
});

test("Composer dictation works in issue comment box and surfaces ASR refusal cleanly", async () => {
  setLocale("en");
  const issueId =
    scenarios.typical.state.collab.chat?.channels.find((c) => c.type === "thread" && c.subjectId !== undefined)?.subjectId ??
    scenarios.typical.state.board.issues[1].id;
  const fake = fakeHost(scenarios.typical, { route: `/issues/${issueId}`, locale: "en" });
  fake.respond("host.asrStart", () => ({
    bizCode: 100004,
    message: "Bind an enabled connection to MOSS Live or Speech Transcription in AI services first",
    data: null,
  }));

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:composer-dictate") === 1);

  await app.press("id:composer-dictate");
  await fake.pumpUntil(app, () => app.count("id:chat-problem") === 1);
  expect(app.texts().some((line) => line.includes("MOSS Live"))).toBe(true);
});

test("Composer distinguishes transcribing vs polishing phases and supports one-click revert to raw transcript", async () => {
  setLocale("zh");
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "zh" });
  let phase: "listening" | "finishing" | "polishing" | "idle" = "listening";
  fake.respond("host.asrStart", () => {
    phase = "listening";
    return { phase: "listening", micLevel: 0.45, text: "呃那个", partial: "", problem: null };
  });
  fake.respond("host.asrStop", () => {
    phase = "finishing";
    return { phase: "finishing", micLevel: 0, text: "呃那个 我想看一下日志", partial: "", problem: null };
  });
  fake.respond("host.asrState", () => {
    if (phase === "finishing") {
      return { phase: "finishing", micLevel: 0, text: "呃那个 我想看一下日志", partial: "", problem: null };
    }
    if (phase === "polishing") {
      return { phase: "polishing", micLevel: 0, text: "呃那个 我想看一下日志", partial: "", problem: null };
    }
    if (phase === "idle") {
      return {
        phase: "idle",
        micLevel: 0,
        text: "我想看一下日志。",
        partial: "",
        rawText: "呃那个 我想看一下日志",
        problem: null,
      };
    }
    return { phase: "listening", micLevel: 0.5, text: "呃那个", partial: "我想看", problem: null };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:composer-dictate") === 1);

  // Pre-existing prefix to verify anchor splicing works across polish & raw revert.
  await app.type("id:composer-input", "备注：");
  await app.press("id:composer-dictate");
  await fake.pumpUntil(app, () => app.count("id:composer-dictating") === 1);
  expect(app.texts()).toContain("正在听写…");

  // Stop recording -> enters "识别中…" (finishing).
  await app.press("id:composer-dictate");
  await fake.pumpUntil(app, () => app.texts().includes("识别中…"));
  expect(app.texts()).not.toContain("润色中…");

  // Transitions to "润色中…" (polishing).
  phase = "polishing";
  await fake.pumpUntil(app, () => app.texts().includes("润色中…"), 500);
  expect(app.texts()).not.toContain("识别中…");

  // Polishing finishes -> polished text applied and one-click revert pill appears.
  phase = "idle";
  await fake.pumpUntil(app, () => app.count("id:composer-dictate-revert") === 1, 500);
  expect(app.count("id:composer-dictating")).toBe(0);
  expect(app.value("id:composer-input")).toBe("备注：我想看一下日志。");

  // One-click revert restores the unpolished raw transcript while keeping the prefix.
  await app.press("id:composer-dictate-revert");
  await fake.pump(app);
  expect(app.value("id:composer-input")).toBe("备注：呃那个 我想看一下日志");
  expect(app.count("id:composer-dictate-revert")).toBe(0);
});

test("Composer hides raw revert when transcript is unchanged and clears revert on manual edit", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "en" });
  let unchanged = true;
  fake.respond("host.asrStart", () => ({ phase: "listening", micLevel: 0.3, text: "Hello", partial: "", problem: null }));
  fake.respond("host.asrStop", () => {
    if (unchanged) {
      return { phase: "idle", micLevel: 0, text: "Hello", partial: "", rawText: "Hello", problem: null };
    }
    return { phase: "idle", micLevel: 0, text: "Hello, world.", partial: "", rawText: "um hello world", problem: null };
  });
  fake.respond("channel.message.send", () => null);

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:composer-dictate") === 1);

  // Unchanged polish result does not show revert button.
  await app.press("id:composer-dictate");
  await fake.pumpUntil(app, () => app.count("id:composer-dictating") === 1);
  await app.press("id:composer-dictate");
  await fake.pumpUntil(app, () => app.count("id:composer-dictating") === 0);
  expect(app.count("id:composer-dictate-revert")).toBe(0);

  // Send clears the composer, then a changed polish result shows revert and manual editing clears it.
  unchanged = false;
  await app.press("id:send");
  await fake.pumpUntil(app, () => app.value("id:composer-input") === "");
  await app.press("id:composer-dictate");
  await fake.pumpUntil(app, () => app.count("id:composer-dictating") === 1);
  await app.press("id:composer-dictate");
  await fake.pumpUntil(app, () => app.count("id:composer-dictate-revert") === 1);
  expect(app.value("id:composer-input")).toBe("Hello, world.");

  await app.type("id:composer-input", "Hello, world!");
  await fake.pump(app);
  expect(app.count("id:composer-dictate-revert")).toBe(0);
});
