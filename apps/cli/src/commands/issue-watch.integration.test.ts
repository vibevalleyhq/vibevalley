import { describe, expect, it } from "vite-plus/test";

import { VibeValleyApi } from "@vibevalley/protocol";
import { IssueWatch } from "@vibevalley/protocol/schema";

import { cli, workingFarm } from "#/testing/testing.ts";

const rowsOf = (body: string) =>
  body
    .split("\n")
    .filter(Boolean)
    .map((line) => IssueWatch.parse(JSON.parse(line)));

describe("issue watch command", () => {
  it("regression: watch emits history then settled state and leaves global JSON a single document", async () => {
    await using running = await workingFarm();
    const server = running.url;
    const at = (...args: string[]) => [...args, "--server", server];
    const agent = (await cli(at("agent", "create", "fox", "--runtime", "pi"))).out.split("  ")[0]!;
    await cli(at("repo", "create", "clock"));
    const made = await cli(at("issue", "create", "打卡页提交", "--repo", "clock", "--agent", agent));
    const id = /^#(\d+)/u.exec(made.out)?.[1] ?? "";
    const started = await cli(at("issue", "status", id, "todo"));
    expect(started, started.err).toMatchObject({ code: 0 });
    const watched = await cli(at("issue", "watch", id, "--jsonl"));
    expect(watched.code).toBe(0);
    const rows = rowsOf(watched.out);
    expect(rows.some((r) => r.kind === "event" && r.event.type === "tool/result")).toBe(true);
    expect(rows.at(-1)).toMatchObject({ kind: "state", settled: true });
    const again = await cli(at("issue", "watch", id, "--jsonl"));
    expect(again.code).toBe(0);
    expect(rowsOf(again.out).at(-1)).toMatchObject({ kind: "state", settled: true });
    const json = await cli(at("issue", "watch", id, "--format", "json"));
    expect(json.code).toBe(2);
    expect(json.out).toBe("");
    expect((await cli(at("issue", "show", id, "--watch", "--format", "json"))).code).toBe(0);
    const stop = new AbortController();
    const follower = cli(at("issue", "watch", id, "--follow", "--jsonl"), "", {}, stop.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stop.abort();
    await follower;
    const api = new VibeValleyApi(server);
    const after = await api.issue.get({ id });
    expect(after.status).toBe("in_review");
    expect((await cli(at("issue", "status", id, "canceled"))).code).toBe(0);
    expect(rowsOf((await cli(at("issue", "watch", id, "--jsonl"))).out).at(-1)).toMatchObject({
      kind: "state",
      settled: true,
      issue: { status: "canceled" },
    });
  });
});
