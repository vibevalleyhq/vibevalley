import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { SayRequest, Skill } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import { commandNameables, commandOf, typedCommand } from "./commands";

const sampleSkills: Skill[] = [
  { id: "release-check", name: "Release Check", description: "Verify pre-release gates", body: "Run checks", builtIn: undefined },
  { id: "reviewer", name: "Code Review", description: "Built-in reviewer guide", body: "Review carefully", builtIn: true },
  { id: "imagegen", name: "Make an image", description: "Duplicate builtin id", body: "...", builtIn: true },
];

test("typedCommand and commandNameables support built-in commands plus user and built-in skills", () => {
  setLocale("en");
  expect(typedCommand("/rel", 4)).toEqual({ start: 0, query: "rel" });
  expect(typedCommand("/release-check", 14)).toEqual({ start: 0, query: "release-check" });
  expect(typedCommand("/usr/bin", 8)).toBeUndefined();

  const items = commandNameables(undefined, sampleSkills);
  expect(items.some((i) => i.token === "/issue")).toBe(true);
  expect(items.some((i) => i.token === "/release-check" && i.name === "Release Check")).toBe(true);
  expect(items.some((i) => i.token === "/reviewer" && i.name === "Code Review")).toBe(true);
  expect(items.filter((i) => i.token === "/imagegen")).toHaveLength(1);

  expect(commandOf("/release-check v1.2", sampleSkills)).toEqual({
    kind: "skill",
    skill: sampleSkills[0],
    args: "v1.2",
  });
  expect(commandOf("/issue Fix bug", sampleSkills)).toEqual({
    kind: "builtin",
    name: "issue",
    text: "Fix bug",
  });
});

test("channel composer autocompletes and sends /<skill> with structured ChannelCommand", async () => {
  setLocale("zh");
  const fake = fakeHost(scenarios.typical, { route: "/chat/general", locale: "zh" });
  const sent: SayRequest[] = [];
  fake.respond("skill.list", () => sampleSkills);
  fake.respond("channel.message.send", (input: unknown) => {
    const req = input as SayRequest;
    sent.push(req);
    return undefined;
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:composer-input") === 1);

  await app.type("id:composer-input", "/rel");
  await fake.pumpUntil(app, () => app.count("id:mention-/release-check") === 1);

  await app.press("id:mention-/release-check");
  await app.type("id:composer-input", "v2.0");
  await app.press("id:send");

  await fake.pumpUntil(app, () => sent.length === 1);
  expect(sent[0]?.text).toBe("/release-check v2.0");
  expect(sent[0]?.command).toEqual({ name: "release-check", args: "v2.0" });
});
