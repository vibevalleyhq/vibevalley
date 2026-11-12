import { describe, expect, it } from "vite-plus/test";

import { endpoints } from "@vibevalley/protocol/api";
import { Preview } from "@vibevalley/protocol/schema";

import { cli, farm, lookIn, memoriesOf, workingFarm } from "#/testing/testing.ts";

const json = (text: string): unknown => JSON.parse(text);

const cliCommands = [
  "agent create",
  "agent delete",
  "agent list",
  "app open",
  "app quit",
  "app restart",
  "app status",
  "app update",
  "artifact list",
  "artifact read",
  "artifact show",
  "channel list",
  "channel message list",
  "channel message search",
  "channel message send",
  "chat",
  "cron create",
  "cron delete",
  "cron edit",
  "cron list",
  "doctor",
  "issue comment",
  "issue create",
  "issue delete",
  "issue diff",
  "issue edit",
  "issue list",
  "issue review",
  "issue show",
  "issue status",
  "issue timeline",
  "issue watch",
  "memory create",
  "memory delete",
  "memory list",
  "memory search",
  "pkm capture",
  "pkm journal show",
  "pkm page edit",
  "pkm page export",
  "pkm page list",
  "pkm page save",
  "pkm page show",
  "pkm radar",
  "pkm search",
  "repo create",
  "repo list",
  "repo pr submit",
  "runtime list",
  "runtime refresh",
  "session list",
  "session show",
  "session stop",
] as const;

describe("the command line", () => {
  it("gives every command a description and an example", async () => {
    for (const command of cliCommands) {
      const help = await cli([...command.split(" "), "--help"]);
      expect({ command, code: help.code, examples: help.out.includes("EXAMPLES") }).toEqual({ command, code: 0, examples: true });
    }
  });

  // A dry run is an endpoint of its own that takes what the real one takes, so --dry-run can call it with the same words.
  it("gives each command that changes what cannot be taken back a dry run of the same shape", () => {
    for (const e of endpoints.filter((x) => x.dryRun)) {
      const preview = endpoints.find((x) => x.op === e.dryRun);
      expect({ op: e.op, preview: preview?.op }).toEqual({ op: e.op, preview: e.dryRun });
      expect([preview!.about, preview!.input === e.input, preview!.result === Preview, preview!.can]).toEqual([e.about, true, true, e.can]);
    }
    expect(endpoints.filter((e) => e.op.endsWith(".delete") && !e.dryRun).map((e) => e.op)).toEqual([]);
  });

  it("answers in short lines, the name to use next first, and in the protocol's shape with --format json", async () => {
    await using running = await farm();
    const server = running.url;
    const at = (...args: string[]) => [...args, "--server", server];
    const made = await cli(at("issue", "create", "试一下", "--criterion", "能打开"));
    expect(made.out).toMatch(/^#1 {2}backlog {2}试一下$/u);
    const shown = (await cli(at("issue", "show", "#1"))).out;
    expect(shown).toContain("能打开");
    // It ends with what can be done now, each a command to run.
    expect(shown.split("\n").at(-1)).toMatch(/^ {2}vibevalley issue status 1 /u);
    const edited = await cli(at("issue", "edit", "1", "--title", "改一下"));
    expect(edited.out).toMatch(/^#1 {2}backlog {2}改一下$/u);
    const asJson = json((await cli(at("issue", "show", "1", "--format", "json"))).out) as { number: number; criteria: string[] };
    expect([asJson.number, asJson.criteria]).toEqual([1, ["能打开"]]);
    for (const title of ["二", "三", "四"]) await cli(at("issue", "create", title));
    const list = await cli(at("issue", "list"));
    const listJson = await cli(at("issue", "list", "--format", "json"));
    expect(list.out.split("\n")).toHaveLength(4);
    // What an agent reads by default is a small part of the whole.
    expect(list.out.length * 3).toBeLessThan(listJson.out.length);
    const limited = await cli(at("issue", "list", "--limit", "2"));
    expect(limited.out.split("\n").at(-1)).toContain("--limit 4");
    // With no --server, VIBEVALLEY_SERVER says where.
    expect((await cli(["issue", "show", "1"], "", { VIBEVALLEY_SERVER: server })).code).toBe(0);
  });

  it("fails with nothing on stdout, a JSON failure on stderr, an exit code by kind and the commands to go on with", async () => {
    await using running = await farm();
    const server = running.url;
    const at = (...args: string[]) => [...args, "--server", server];
    const missingArgument = await cli(at("issue", "show"));
    expect([missingArgument.code, missingArgument.out, missingArgument.failure?.tag]).toEqual([2, "", "MissingArgument"]);
    expect((await cli(at("issue", "list", "--bogus", "1"))).failure?.tag).toBe("UnrecognizedOption");
    const missing = await cli(at("issue", "show", "nope"));
    expect([missing.code, missing.failure?.tag, missing.failure?.next]).toEqual([4, "Missing", [{ say: "列出工单，找它的编号", run: ["issue", "list"] }]]);
    await cli(at("issue", "create", "还是草稿"));
    // A move the issue does not take now is refused by the server, with the moves it does take as commands to run.
    const refused = await cli(at("issue", "status", "1", "done"));
    expect([refused.code, refused.failure?.tag]).toEqual([3, "Refused"]);
    const cancel = refused.failure?.next?.find((n) => n.run?.join(" ") === "issue status 1 canceled");
    expect(cancel?.run).toEqual(["issue", "status", "1", "canceled"]);
    expect((await cli(at(...cancel!.run!))).out).toMatch(/^#1 {2}canceled/u);
    const noWords = await cli(at("issue", "comment", "1"));
    expect([noWords.code, noWords.failure?.tag]).toEqual([2, "MissingArgument"]);
    const nowhere = await cli(at("channel", "message", "list", "nowhere"));
    expect([nowhere.code, nowhere.failure?.tag]).toEqual([4, "Missing"]);
    expect(nowhere.failure?.message).toContain("general");
    expect((await cli(["issue", "list", "--server", "http://127.0.0.1:9"])).failure?.tag).toBe("Unreachable");
    const wrong = await cli(["issue", "nope"]);
    expect([wrong.code, wrong.out, wrong.failure?.tag]).toEqual([2, "", "UnknownSubcommand"]);
  });

  it("--dry-run says what would happen and changes nothing; a change with no dry run is refused", async () => {
    await using running = await farm();
    const server = running.url;
    const at = (...args: string[]) => [...args, "--server", server];
    await cli(at("issue", "create", "先试跑"));
    const cancel = await cli(at("issue", "status", "1", "canceled", "--dry-run"));
    expect([cancel.code, cancel.out]).toEqual([0, "#1 关成已取消：还没派过"]);
    expect((await cli(at("issue", "show", "1"))).out.split("\n")[1]).toMatch(/^backlog/u);
    const create = await cli(at("issue", "create", "不该建", "--dry-run"));
    expect([create.code, create.failure?.tag]).toEqual([2, "NoDryRun"]);
    const added = await cli(at("cron", "create", "早上看看", "看看昨天的改动", "--daily", "09:00"));
    const id = added.out.split("  ")[0]!;
    expect((await cli(at("cron", "delete", id, "--dry-run"))).out).toContain("删掉定时任务「早上看看」");
    expect((await cli(at("cron", "list"))).out).toContain(id);
    expect((await cli(at("agent", "delete", "docs", "--dry-run"))).out).toContain("删掉档案");
  });

  it("every place a missing thing points to is a command that is there", async () => {
    for (const next of [...Object.values(lookIn), memoriesOf("docs")]) {
      if (!next.run) continue;
      const help = await cli([...next.run.filter((w) => !w.startsWith("{")), "--help"]);
      expect({ run: next.run, code: help.code }).toEqual({ run: next.run, code: 0 });
    }
  });

  it("with no command it shows the help, never a conversation waiting on input", async () => {
    const bare = await cli([]);
    expect([bare.code, bare.out.includes("SUBCOMMANDS")]).toEqual([0, true]);
    const mixed = await cli(["chat", "claude", "--name", "fox"]);
    expect([mixed.code, mixed.failure?.tag]).toEqual([2, "InvalidValue"]);
  });

  it("regression: CLI watch returns for questions while the issue remains in progress", async () => {
    await using running = await workingFarm();
    const server = running.url;
    const at = (...args: string[]) => [...args, "--server", server];
    const profile = (await cli(at("agent", "create", "fox", "--runtime", "pi"))).out.split("  ")[0]!;
    expect((await cli(at("repo", "create", "clock"))).code).toBe(0);
    // The test helper asks which port when its issue says ask-first, with options when it says with-options, and commits clock.ts
    // when it says commit.
    const made = await cli(at("issue", "create", "打卡页先问清楚，给选项，提交", "--repo", "clock", "--agent", profile, "--criterion", "clock-in works"));
    const n = /^#(\d+)/u.exec(made.out)?.[1] ?? "";
    expect((await cli(at("issue", "status", n, "todo"))).code).toBe(0);
    expect((await cli(at("issue", "show", n, "--watch", "--timeout", "30"))).code).toBe(0);
    const asking = (await cli(at("issue", "show", n))).out;
    expect(asking.split("\n")[1]).toMatch(/^in_progress/u);
    expect(asking).toContain("用 8797");
    expect(asking).toContain(`vibevalley issue comment ${n} …`);
    expect((await cli(at("issue", "comment", n, "用 8797"))).code).toBe(0);
    expect((await cli(at("issue", "show", n, "--watch", "--timeout", "30"))).code).toBe(0);
    const handedBack = (await cli(at("issue", "show", n))).out;
    expect(handedBack.split("\n")[1]).toMatch(/^in_review/u);
    expect(handedBack).not.toContain("用 8797");
    expect((await cli(at("issue", "diff", n))).out).toContain("clock.ts");
    expect((await cli(at("issue", "review", n, "--pass"))).code).toBe(0);
    expect((await cli(at("issue", "status", n, "done"))).out).toMatch(new RegExp(`^#${n} {2}done`, "u"));
  });
});
