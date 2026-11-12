import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { user, worker as sessionActor } from "#/base/actor.ts";
import { sampleAgent } from "#/modules/agent/seed.ts";
import { testIssues, world } from "#/testing/world.ts";

import type { Tool } from "./tool.ts";

const Page = z.object({
  uri: z.string(),
  offset: z.number().int(),
  totalChars: z.number().int(),
  nextOffset: z.exactOptional(z.number().int()),
  text: z.string(),
});
const decodePage = (text: string) => Page.parse(JSON.parse(text));

const textResult = async (tool: ReturnType<Tool["orchestrator"]>[number], input: unknown) => {
  const result = await tool.execute(input, { id: "call" });
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

describe("resource_read", () => {
  test("keeps one UTF-16 snapshot across pages and refreshes it at offset zero", async () => {
    await using farm = await world();
    const channels = farm.channel;
    const tools = farm.tool;
    const caller = () => ({ agent: defaultOrchestrator, session: "", repo: "", here: channels.defaultChannel(), picked: "", envelope: "", actor: user });
    const read = tools.orchestrator(caller).find((item) => item.name === "resource_read");
    if (read === undefined) throw new Error("resource_read is missing");
    const original = "甲".repeat(500);
    const message = (await channels.post({ _tag: "User", text: original, sendKey: "" })).message;
    const uri = `vv://envelope/${message.id}`;
    const firstText = await textResult(read, { uri, offset: 0, limit: 120 });
    let page = decodePage(firstText);
    let snapshot = page.text;
    await channels.edit(message.id, "乙".repeat(500));
    while (page.nextOffset !== undefined) {
      const textResult3 = await textResult(read, { uri, offset: page.nextOffset, limit: 120 });
      page = decodePage(textResult3);
      snapshot += page.text;
    }
    expect(snapshot).toContain(original);
    expect(snapshot).not.toContain("乙".repeat(100));
    const textResult2 = await textResult(read, { uri, offset: 0, limit: 4000 });
    const refreshed = decodePage(textResult2);
    expect(refreshed.text).toContain("乙".repeat(100));
  });

  test("holds a worker to its own conversation", async () => {
    const runtime = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("done") });
    await using farm = await world({ runtimes: [runtime], repos: ["demo"] });
    const channels = farm.channel;
    const issues = testIssues(farm.issue);
    const tools = farm.tool;
    const secret = await channels.openChannel("secret", "", "");
    const message = (await channels.post({ _tag: "User", text: "user only", channel: secret.id, sendKey: "" })).message;
    const agent = sampleAgent({ id: "lab" });
    await farm.agent.save(agent);
    const issue = await issues.add({ title: "work", repo: "demo", agent: agent.id });
    const hired = (await issues.hire(agent, "work", "demo", { issue: issue.id })).session;
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
    const refused = await textResult(read, { uri: `vv://envelope/${message.id}` }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).toMatchObject({ message: expect.stringContaining("没有权限") });
  });
});
