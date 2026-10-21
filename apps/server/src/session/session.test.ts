import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import type { Agent, Session } from "@vibevalley/protocol";
import { seedAgents } from "../agent/seed.ts";
import { Effect, Fiber, Stream } from "effect";
import { Core } from "../core/core.ts";
import { Projects } from "../project/project.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { type LaunchActivity } from "../channel/chat.ts";
import { Sessions } from "./session.ts";

const lab = (): Agent => ({ ...seedAgents().find((a) => a.id === "lab")!, effort: "" });

const until = (ok: () => boolean, what: string) =>
  Effect.promise(async () => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!ok()) throw new Error(`waited for ${what}`);
  });

/** A helper that writes a file, commits it and reports, as the farm's rules ask. */
const worker = (turns: ScriptedTurn[]) =>
  scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      turns.push(turn);
      await turn.tool("bash", JSON.stringify({ command: `cd ${turn.options.cwd} && touch done.txt` }), () => {
        writeFileSync(join(turn.options.cwd, `done-${turns.length}.txt`), "done\n");
        execFileSync("git", ["-c", "user.name=w", "-c", "user.email=w@x", "add", "-A"], { cwd: turn.options.cwd });
        execFileSync("git", ["-c", "user.name=w", "-c", "user.email=w@x", "commit", "-qm", `做完第 ${turns.length} 轮`], { cwd: turn.options.cwd });
        return "ok";
      });
      turn.say(`改好了。\n\n记住：这个项目用 pnpm test\n\n结论：做完了第 ${turns.length} 轮`);
    },
  });

const phase = (core: Core["Service"], id: string) => core.session(id)?.phase._tag;

describe("sessions", () => {
  it.live("a session is sent, works its run, reports, takes a word and is harvested", () => {
    const turns: ScriptedTurn[] = [];
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const seen: LaunchActivity[] = [];
      const following = yield* Effect.forkScoped(Stream.runForEach(yield* sessions.launches, (a) => Effect.sync(() => seen.push(a))));
      yield* Effect.sleep(5);

      const hired = yield* sessions.send(lab(), "给打卡接口加分页", "demo", { issue: "i1", worktree: true });
      const id = hired.session!.id;
      expect(id).toBe("w1");
      yield* until(() => phase(core, id) === "ripe", "the first run's report");
      const session = core.session(id)!;
      expect([session.lastRun?.outcome, session.lastRun?.summary, session.runs]).toEqual(["completed", "做完了第 1 轮", 1]);
      expect(turns[0]!.options.mcpServers?.[0]).toMatchObject({ name: "vibevalley", type: "http" });
      expect(sessions.who(((turns[0]!.options.mcpServers![0] as { headers: Record<string, string> }).headers.authorization ?? "").replace("Bearer ", ""))).toBe(
        id,
      );
      expect(turns[0]!.input).toContain("给打卡接口加分页");
      expect(turns[0]!.options.cwd).toBe(sessions.place(id)!.cwd);

      const events = sessions.events(id)!;
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(["run/start", "user/message", "tool/call", "tool/result", "assistant/message", "run/end"]),
      );
      // The run's end is written just after the report's fact.
      let runs = yield* sessions.runs("i1");
      for (let i = 0; i < 100 && runs[0]?.outcome === undefined; i++) {
        yield* Effect.sleep(10);
        runs = yield* sessions.runs("i1");
      }
      expect(runs.map((r) => [r.triggeredBy.kind, r.outcome])).toEqual([["issue", "completed"]]);
      expect(sessions.currentRun(id)).toBe("");

      const told = yield* sessions.tell(id, "再加个测试", { kind: "comment", message: "m1" });
      expect(told).toBe("老实人 开始新的一轮".replace("老实人", session.name));
      yield* until(() => core.session(id)?.runs === 2 && phase(core, id) === "ripe", "the second run");
      expect((yield* sessions.runs("i1")).map((r) => r.triggeredBy.kind)).toEqual(["issue", "comment"]);
      expect(seen.some((a) => a.kind === "ended" && a.id === id)).toBe(true);

      const projects = yield* Projects;
      const merged = yield* sessions.handOver(id, "merged", (place) => projects.merge(place));
      expect(merged.commits).toBe(2);
      expect(core.session(id)).toBeUndefined();
      const gone = (yield* sessions.get(id))!;
      expect([gone.phase, gone.runs, gone.lastRun?.outcome]).toMatchObject([{ _tag: "closed", closed: "merged" }, 2, "completed"]);
      expect((yield* sessions.list("lab")).map((s) => s.id)).toEqual([id]);
      expect(sessions.who("nothing")).toBe("");
      yield* Fiber.interrupt(following);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [worker(turns)], repos: ["demo"] })));
  });

  it.live("a turn asked for holds its room until it is working", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const s = sessions as typeof sessions & {
        hands: Map<string, unknown>;
        expect: (h: unknown, by: unknown) => void;
        unexpect: (h: unknown) => void;
        hired: () => number;
      };
      yield* core.apply({
        type: "hired",
        session: { id: "w1", name: "w1", agent: "lab", runtime: "pi", brief: "", project: "demo", hiredAt: 0, runs: 0, phase: { _tag: "ripe" } } as Session,
      });
      const h = {
        id: "w1",
        place: { project: "demo", cwd: "/nowhere" },
        journal: sessions.trajectories.openLog("w1"),
        oarSessionId: "",
        lastText: "",
        tracking: {},
        launch: "",
        spoke: false,
        recalled: new Set(),
        triggers: [] as unknown[],
        run: "",
        heard: [],
      };
      s.hands.set("w1", h);
      s.expect(h, { kind: "comment" });
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect(phase(core, "w1")).toBe("ripe");
      expect((yield* Effect.flip(sessions.handOver("w1", "merged", () => Effect.succeed({ text: "", commits: 0 })))) as { _tag: string }).toMatchObject({
        _tag: "Refused",
      });
      for (const step of ["pending", "started"]) {
        if (step === "started") {
          yield* core.apply({ type: "run", id: "w1" });
          s.unexpect(h);
        }
        const got = yield* sessions.send(lab(), "another", "demo");
        expect([got.session, got.refused !== undefined, s.hired()]).toEqual([undefined, true, 0]);
      }
      yield* core.apply({ type: "report", id: "w1", outcome: "completed", summary: "", runs: 1 });
      expect(sessions.noRoom("pi", "demo")).toBe("");
    }).pipe(Effect.scoped, Effect.provide(world({ config: { ...testConfig(), project: { maxSessions: 1, checkTimeoutSeconds: 60 } }, repos: ["demo"] }))),
  );
});
