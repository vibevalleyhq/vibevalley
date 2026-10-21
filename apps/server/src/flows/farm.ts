// A whole farm for the flow tests, which go through several services at once (an issue drafted, sent, harvested; a
// memory kept by one session and recalled by the next). No binary, login or model: the helpers are oar's scripted
// runtime over real git repositories in temporary folders, doing what the words of their job say (helper below).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Runtime } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import type { Agent, Fact, FactReport, Session } from "@vibevalley/protocol";
import { seedAgents } from "@vibevalley/protocol/rules";
import { Effect, Layer, Stream } from "effect";
import type { Config } from "../base/config.ts";
import { Core } from "../core/core.ts";
import { layer as game } from "../game/game.ts";
import { jobBreak } from "../session/rules.ts";
import { type Hired, ready as sessionsReady } from "../session/session.ts";
import { testConfig } from "../testing/layers.ts";
import { world, type WorldOptions } from "../testing/world.ts";

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
 * clock.ts; 先问清楚 asks the owner until 用 8797 is said; 记一笔 notes two memories. It answers with its job and persona. */
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
      if (input.includes("先问清楚") && !input.includes("用 8797")) notes += "\n\n要问主人：用 8787 还是 8797？";
      if (input.includes("记一笔")) notes = "\n\n记住：这个项目用 pnpm test 跑测试\n记住（所有项目）：提交信息写中文";
      turn.say("做完了：" + input + "｜人设：" + (turn.options.appendSystemPrompt ?? "无") + notes);
    },
  });

/** The seed profile on pi, with no effort: the scripted runtime has no models, so no effort levels. */
export const lab = (): Agent => ({ ...seedAgents().find((a) => a.id === "lab")!, effort: "" });

const farmLayer = (options: WorldOptions) => sessionsReady.pipe(Layer.provideMerge(game.pipe(Layer.provideMerge(world(options)))));

export interface Farm {
  readonly config: Config;
  readonly turns: ScriptedTurn[];
  readonly layer: ReturnType<typeof farmLayer>;
}

/** The farm with its one runtime, pi: the helper above unless the test gives its own. As the server starts it, sessions
 * left on the farm by the last run come back (sessionsReady), and the game keeps its ledger. */
export function farm(options: Omit<WorldOptions, "runtimes"> & { readonly change?: (c: Config) => Config; readonly runtime?: Runtime } = {}): Farm {
  const base = options.config ?? testConfig();
  const config = options.change ? options.change(base) : base;
  const turns: ScriptedTurn[] = [];
  return { config, turns, layer: farmLayer({ ...options, config, runtimes: [options.runtime ?? helper(turns)] }) };
}

/** Every fact and notice from now on, kept as they come. */
export const watch = Effect.gen(function* () {
  const core = yield* Core;
  const facts: Fact[] = [];
  const notes: string[] = [];
  const events = yield* core.subscribe;
  yield* Effect.forkScoped(
    Stream.runForEach(events, (e) =>
      Effect.sync(() => {
        if (e.type === "notice") notes.push(e.text);
        else if (e.type !== "snapshot" && e.type !== "event" && e.type !== "runtime") facts.push(e);
      }),
    ),
  );
  let taken = 0;
  /** The next report not cut off by a stop, in order. */
  const nextReport = until(
    () => facts.filter((f): f is FactReport => f.type === "report" && f.outcome !== "interrupted").length > taken,
    "the next report",
  ).pipe(Effect.map(() => facts.filter((f): f is FactReport => f.type === "report" && f.outcome !== "interrupted")[taken++]!));
  return { facts, notes, nextReport };
});

/** Polls until ok, or fails the test after about ten seconds. */
export const until = (ok: () => boolean | Promise<boolean>, what: string) =>
  Effect.promise(async () => {
    for (let i = 0; i < 1000; i++) {
      if (await ok()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waited for ${what}`);
  });

/** The value got once ok says so. */
export const await_ = <A>(get: () => Effect.Effect<A, unknown> | A, ok: (a: A) => boolean, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const got = get();
      const a = Effect.isEffect(got) ? yield* Effect.orDie(got) : got;
      if (ok(a)) return a;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(new Error(`waited for ${what}`));
  });

export const mustHire = (h: Hired): Session => {
  if (!h.session) throw new Error("refused: " + h.refused);
  return h.session;
};

export const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
