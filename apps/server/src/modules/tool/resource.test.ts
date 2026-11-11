import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { user, worker as sessionActor } from "#/base/actor.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { sampleAgent } from "#/modules/agent/seed.ts";
import { Channel } from "#/modules/channel/channel.ts";
import { Issue } from "#/modules/issue/issue.ts";
import { testIssues, world } from "#/testing/world.ts";

import { Tool } from "./tool.ts";

const Page = Schema.Struct({
  uri: Schema.String,
  offset: Schema.Int,
  totalChars: Schema.Int,
  nextOffset: Schema.optionalKey(Schema.Int),
  text: Schema.String,
});
const decodePage = Schema.decodeUnknownEffect(Schema.fromJsonString(Page));

const textResult = Effect.fnUntraced(function* (tool: ReturnType<Tool["Service"]["orchestrator"]>[number], input: unknown) {
  const result = yield* tool.execute(input, { id: "call" });
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
});

describe("resource_read", () => {
  it.live("keeps one UTF-16 snapshot across pages and refreshes it at offset zero", () =>
    Effect.gen(function* () {
      const channels = yield* Channel;
      const tools = yield* Tool;
      const caller = () => ({ agent: defaultOrchestrator, session: "", repo: "", here: channels.defaultChannel(), picked: "", envelope: "", actor: user });
      const read = tools.orchestrator(caller).find((item) => item.name === "resource_read");
      if (read === undefined) throw new Error("resource_read is missing");
      const original = "甲".repeat(500);
      const message = (yield* channels.post({ _tag: "User", text: original, sendKey: "" })).message;
      const uri = `vv://envelope/${message.id}`;
      const firstText = yield* textResult(read, { uri, offset: 0, limit: 120 });
      let page = yield* decodePage(firstText);
      let snapshot = page.text;
      yield* channels.edit(message.id, "乙".repeat(500));
      while (page.nextOffset !== undefined) {
        const textResult3 = yield* textResult(read, { uri, offset: page.nextOffset, limit: 120 });
        page = yield* decodePage(textResult3);
        snapshot += page.text;
      }
      expect(snapshot).toContain(original);
      expect(snapshot).not.toContain("乙".repeat(100));
      const textResult2 = yield* textResult(read, { uri, offset: 0, limit: 4000 });
      const refreshed = yield* decodePage(textResult2);
      expect(refreshed.text).toContain("乙".repeat(100));
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("holds a worker to its own conversation", () => {
    const runtime = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("done") });
    return Effect.gen(function* () {
      const channels = yield* Channel;
      const agents = yield* Agent;
      const issue2 = yield* Issue;
      const issues = testIssues(issue2);
      const tools = yield* Tool;
      const secret = yield* channels.openChannel("secret", "", "");
      const message = (yield* channels.post({ _tag: "User", text: "user only", channel: secret.id, sendKey: "" })).message;
      const agent = sampleAgent({ id: "lab" });
      yield* agents.save(agent);
      const issue = yield* issues.add({ title: "work", repo: "demo", agent: agent.id });
      const hired = (yield* issues.hire(agent, "work", "demo", { issue: issue.id })).session;
      if (hired === undefined) throw new Error("worker was not hired");
      const caller = () => ({
        agent: agent.id,
        session: hired.id,
        repo: "demo",
        here: channels.defaultChannel(),
        picked: "",
        envelope: "",
        actor: sessionActor(hired.id),
      });
      const read = tools.session(caller).find((item) => item.name === "resource_read");
      if (read === undefined) throw new Error("resource_read is missing");
      const refused = yield* Effect.flip(textResult(read, { uri: `vv://envelope/${message.id}` }));
      expect(refused.message).toContain("没有权限");
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
  });
});
