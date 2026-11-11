import { Array as Arr, Option } from "effect";
import { expect, test } from "vite-plus/test";

import type { Feature, Readiness } from "@vibevalley/protocol";

import { commandNameables, commandOf, runCommand, typedCommand } from "./commands";

const everywhere = (readiness: Readiness): Record<Feature, Readiness> => ({
  orchestrator: readiness,
  image: readiness,
  understanding: readiness,
  speech: readiness,
  speakers: readiness,
  voiceDesign: readiness,
  transcription: readiness,
  dictation: readiness,
  live: readiness,
  vision: readiness,
  call: readiness,
});

test("a line that is a command runs it with the words after it; any other line is said as it is", () => {
  expect(commandOf("/issue 给打卡页加分页")).toEqual({ name: "issue", text: "给打卡页加分页" });
  expect(commandOf("  /stop  ")).toEqual({ name: "stop", text: "" });
  expect(commandOf("/remember 提交信息写中文\n别用缩写")).toEqual({ name: "remember", text: "提交信息写中文\n别用缩写" });
  expect(commandOf("/imagegen 一只在麦田里打盹的橘猫")).toEqual({ name: "imagegen", text: "一只在麦田里打盹的橘猫" });
  expect([commandOf("/usr/bin/env"), commandOf("/issues"), commandOf("看 /issue 怎么用"), commandOf("/")]).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("the menu follows a command only while it is typed first in the box", () => {
  expect(typedCommand("/is", 3)).toEqual({ start: 0, query: "is" });
  expect(typedCommand("/", 1)).toEqual({ start: 0, query: "" });
  expect([typedCommand("/issue 标题", 9), typedCommand("说 /is", 5), typedCommand("/is", 0)]).toEqual([undefined, undefined, undefined]);
});

test("/imagegen with images not set up opens the setting that fixes it instead of saying the line, and its menu row says why", () => {
  const readiness = everywhere({ ready: false, missing: "binding" });
  const noteOf = (r: Record<Feature, Readiness>) => Arr.findFirst(commandNameables(r), (n) => n.token === "/imagegen").pipe(Option.map((n) => n.note));
  expect(noteOf(readiness)).not.toEqual(noteOf(everywhere({ ready: true })));
  return runCommand({ name: "imagegen", text: "一只猫" }, { channel: undefined, orchestrator: "orchestrator", readiness }).then((done) => {
    expect(done).toEqual({ open: "/settings/providers" });
  });
});
