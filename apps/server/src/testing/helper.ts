// The helper the farm's tests hire (the flows, and the page's tests through VIBEVALLEY_TEST_RUNTIMES): oar's scripted
// runtime over a real git worktree, doing what the words of its job say. No binary, login or model.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Runtime } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import type { AccountUsage, RuntimeInfo } from "@vibevalley/protocol";
import { factsOf, presetOf } from "@/agent/seed.ts";
import { answerOpening, criteriaHead } from "@/issue/prompts.ts";
import { jobBreak } from "@/session/rules.ts";
import { Effect } from "effect";
import { until } from "./until.ts";

const sessionGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=session", "-c", "user.email=session@vibevalley.test", ...args], { cwd, stdio: "ignore" });

const version = /写版本(\w)/;

/** Turns held by 慢慢 or 发呆 until the test lets them go on (releaseHeld), 1.5 s pass, or they are stopped: a test acts
 * while a session is busy, then says when it may finish, instead of waiting out a timer. */
const held = new Set<() => void>();

/** Once n turns are held, lets every held turn go on: a turn not yet at its hold would miss a release made before. */
export const releaseHeld = (n = 1) =>
  Effect.andThen(
    until(() => held.size >= n, `${n} held turn${n === 1 ? "" : "s"}`),
    Effect.sync(() => {
      for (const go of [...held]) go();
    }),
  );

/** Holds the turn as above: true when it was stopped. */
const hold = (turn: ScriptedTurn) =>
  new Promise<boolean>((resolve) => {
    // The page's tests cannot release: a turn goes on by itself after this long, as it always did.
    const timer = setTimeout(() => go(), 1_500);
    const go = () => {
      clearTimeout(timer);
      held.delete(go);
      resolve(false);
    };
    held.add(go);
    turn.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        held.delete(go);
        resolve(true);
      },
      { once: true },
    );
  });

/** A drafting session: 慢慢 is held (releaseHeld), 顺手提交 changes and commits what it should not, 乱写 hands back no
 * block; the answer 用 8797 makes the second version, which asks nothing. */
async function draft(turn: ScriptedTurn, input: string) {
  if (input.includes("慢慢") && (await hold(turn))) return;
  if (input.includes("乱写")) return turn.say("看了一圈，不知道写什么。\n\n结论：没写出来");
  const cwd = turn.options.cwd;
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
  let [title, criteria, questions] = ["看板拖卡改用 issue.status", `["拖到待办就开工"]`, "要问主人：用 8787 还是 8797？\n\n"];
  if (input.includes("主人的回答：用 8797")) [title, criteria, questions] = ["看板拖卡改用 8797 端口", `["拖到待办就开工", "端口是 8797"]`, ""];
  turn.say(
    "看过代码了。\n\n" +
      questions +
      "```json\n" +
      `{"title": "${title}", "why": "看板还在调旧接口", "todo": ["改 board.dart"], "criteria": ${criteria}, "notDoing": [], "files": ["board.dart"]}` +
      "\n```\n\n结论：草稿写好了",
  );
}

/** An answer issue's round (or 接着修 on one whose answer could not be read): 顺手提交 changes and commits what it should
 * not, 乱写 hands back no block; else a conclusion that rests on clock.ts. */
async function answer(turn: ScriptedTurn, input: string) {
  const cwd = turn.options.cwd;
  if (input.includes("顺手提交")) {
    await turn.tool("bash", `{"command":"git commit"}`, () => {
      writeFileSync(join(cwd, "probe.ts"), "export const probe = 1\n");
      sessionGit(cwd, "add", "probe.ts");
      sessionGit(cwd, "commit", "-q", "-m", "查的时候不该有的提交");
      return "";
    });
  }
  if (input.includes("乱写")) return turn.say("看了一圈，说不清。\n\n结论：没查出来");
  const found = { conclusion: "打卡慢是因为每次都重读配置", evidence: ["clock.ts:1 每次调用都读一遍配置"], unsure: [], next: ["把配置读一次缓存起来"] };
  turn.say("查过了。\n\n```json\n" + JSON.stringify(found) + "\n```\n\n结论：查清楚了");
}

/** The helper every flow hires: what it does is in the words of its job (the part after the reminders). 只起草工单 drafts;
 * 必败 fails; 发呆 is held (releaseHeld); 写版本X commits same.ts as X; 有冲突 merges main and settles same.ts; 提交 commits
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
      if (input.includes(answerOpening) || input.includes("结论读不出来")) return answer(turn, input);
      if (input.includes("必败")) throw new Error("provider said no");
      if (input.includes("发呆") && (await hold(turn))) return;
      const cwd = turn.options.cwd;
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
    stop: "",
    usage: given.some((r) => r.id === id) ? usage() : null,
    skills: null,
    mcpServers: null,
    tools: null,
    settings: { enabled: true, binPath: "", defaultModel: "", defaultEffort: "", env: {} },
    checkedAt: Date.now(),
  });
