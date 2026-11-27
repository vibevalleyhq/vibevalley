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
