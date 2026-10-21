// The helper the farm's tests hire (the flows, and the page's tests through VIBEVALLEY_TEST_RUNTIMES): oar's scripted
// runtime over a real git worktree, doing what the words of its job say. No binary, login or model.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Runtime } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import type { AccountUsage, RuntimeInfo } from "@vibevalley/protocol";
import { factsOf, presetOf } from "@vibevalley/protocol/rules";
import { criteriaHead } from "../issue/rules.ts";
import { jobBreak } from "../session/rules.ts";

const sessionGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=session", "-c", "user.email=session@vibevalley.test", ...args], { cwd, stdio: "ignore" });

const version = /写版本(\w)/;

/** Waits ms, or until the turn is stopped: true when it was. */
const idle = (turn: ScriptedTurn, ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    turn.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/** A drafting session: 慢慢 takes its time, 顺手提交 changes and commits what it should not, 乱写 hands back no block; the
 * answer 用 8797 makes the second version, which asks nothing. */
async function draft(turn: ScriptedTurn, input: string) {
  if (input.includes("慢慢") && (await idle(turn, 1500))) return;
  if (input.includes("乱写")) return turn.say("看了一圈，不知道写什么。\n\n结论：没写出来");
  const cwd = turn.options.cwd!;
  if (input.includes("顺手提交")) {
    await turn.tool("bash", `{"command":"git commit"}`, () => {
      writeFileSync(join(cwd, "board.ts"), "export const drag = 1\n");
      sessionGit(cwd, "add", "board.ts");
      sessionGit(cwd, "commit", "-q", "-m", "起草时不该有的提交");
      writeFileSync(join(cwd, "board.ts"), "export const drag = 2\n");
      writeFileSync(join(cwd, "scratch.md"), "草稿\n");
      return "";
    });
  }
  let [title, criteria, asks] = ["看板拖卡改用 issue.status", `["拖到待办就开工"]`, "要问主人：用 8787 还是 8797？\n\n"];
  if (input.includes("主人的回答：用 8797")) [title, criteria, asks] = ["看板拖卡改用 8797 端口", `["拖到待办就开工", "端口是 8797"]`, ""];
  turn.say(
    "看过代码了。\n\n" +
      asks +
      "```json\n" +
      `{"title": "${title}", "why": "看板还在调旧接口", "todo": ["改 board.dart"], "criteria": ${criteria}, "notDoing": [], "files": ["board.dart"]}` +
      "\n```\n\n结论：草稿写好了",
  );
}

/** The helper every flow hires: what it does is in the words of its job (the part after the reminders). 只起草工单 drafts;
 * 必败 fails; 发呆 idles a while; 写版本X commits same.ts as X; 有冲突 merges main and settles same.ts; 提交 commits
 * clock.ts; 先问清楚 asks the owner until 用 8797 is said (给选项: with 用 8787 and 用 8797 to pick); 记一笔 notes two
 * memories. It answers with its job and persona, and says of each numbered criterion that it was met. */
export const helper = (turns: ScriptedTurn[] = []): Runtime =>
  scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      turns.push(turn);
      const parts = turn.input.split(jobBreak);
      const input = parts[parts.length - 1]!;
      if (input.includes("只起草工单")) return draft(turn, input);
      if (input.includes("必败")) throw new Error("provider said no");
      if (input.includes("发呆") && (await idle(turn, 1500))) return;
      const cwd = turn.options.cwd!;
      const v = version.exec(input)?.[1];
      if (v !== undefined) {
        await turn.tool("bash", `{"command":"git commit"}`, () => {
          writeFileSync(join(cwd, "same.ts"), `export const v = '${v}'\n`);
          sessionGit(cwd, "add", "same.ts");
          sessionGit(cwd, "commit", "-q", "-m", "版本 " + v);
          return "";
        });
      }
      if (input.includes("有冲突")) {
        await turn.tool("bash", `{"command":"git merge main"}`, () => {
          try {
            sessionGit(cwd, "merge", "main");
          } catch {
            // The conflict is the point: same.ts is settled next.
          }
          writeFileSync(join(cwd, "same.ts"), "export const v = 'A+B'\n");
          sessionGit(cwd, "add", "same.ts");
          sessionGit(cwd, "commit", "-q", "--no-edit");
          return "";
        });
      }
      await turn.tool("bash", `{"command":"echo hi"}`, () => "hi");
      if (input.includes("提交")) {
        await turn.tool("bash", `{"command":"git commit"}`, () => {
          writeFileSync(join(cwd, "clock.ts"), 'export const clockIn = () => "ok"\n');
          sessionGit(cwd, "add", "clock.ts");
          // Asked again on a branch that has it (a reopen, another round), it has nothing new to commit, as an agent would.
          if (execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim() !== "") sessionGit(cwd, "commit", "-q", "-m", "加上打卡");
          return "";
        });
      }
      let notes = "";
      if (input.includes("先问清楚") && !input.includes("用 8797"))
        notes += "\n\n要问主人：用 8787 还是 8797？" + (input.includes("给选项") ? "（选项：用 8787｜用 8797）" : "");
      if (input.includes("记一笔")) notes = "\n\n记住：这个项目用 pnpm test 跑测试\n记住（所有项目）：提交信息写中文";
      const criteria = input.includes(criteriaHead)
        ? input
            .slice(input.indexOf(criteriaHead))
            .split("\n")
            .filter((l) => /^\d+\. /.test(l))
        : [];
      if (criteria.length > 0) notes += "\n\n" + criteria.map((_, i) => `标准 ${i + 1}：做到了 —— 跑了 echo hi`).join("\n");
      turn.say("做完了：" + input + "｜人设：" + (turn.options.appendSystemPrompt ?? "无") + notes);
    },
  });

/** A probe that finds every runtime given, bundled, and no other. */
export const installedOnly =
  (given: readonly Runtime[], usage: () => AccountUsage | null = () => null) =>
  async (id: string): Promise<RuntimeInfo> => ({
    id,
    preset: presetOf(id),
    facts: factsOf(id),
    installation: given.some((r) => r.id === id) ? { status: "available", via: "bundled", command: id, version: null } : { status: "not_found" },
    models: null,
    usage: given.some((r) => r.id === id) ? usage() : null,
    skills: null,
    mcpServers: null,
    tools: null,
    settings: { enabled: true, binPath: "", defaultModel: "", defaultEffort: "", env: {} },
    checkedAt: Date.now(),
  });
