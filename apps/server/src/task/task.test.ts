import { describe, expect, it } from "@effect/vitest";
import type { Agent, Changes, Session, TaskGraph } from "@vibevalley/protocol";
import { blockedBy, isAcceptance, taskOf } from "./graph.ts";
import { inbox } from "../notice/inbox.ts";
import { clip } from "../base/text.ts";
import { graphOf, parseSplit, taskBrief, taskIssueID } from "./rules.ts";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Core } from "../core/core.ts";
import { Issues } from "../issue/issue.ts";
import { chooseAgent } from "../runtime/rules.ts";
import { splitBrief } from "./rules.ts";
import { type Hired, type HireOptions, type Roster, NotTakenIn, type SessionShape } from "../session/session.ts";
import { MergeFailure, type Workplace } from "../project/project.ts";
import { notTakenIn } from "../session/rules.ts";
import { testConfig } from "../testing/layers.ts";
import { worldBelowTasks } from "../testing/world.ts";
import { make, type TaskGit, type TaskWork } from "./task.ts";
import { untilGot } from "../testing/until.ts";
import * as q from "../../db/generated/task_event.sql.ts";
import { sessionId } from "@vibevalley/protocol/schema";

const step = (id: string, ...needs: string[]) => ({
  id,
  title: "步骤 " + id,
  brief: "写 steps/" + id + ".txt",
  needs,
  agent: "lab",
  check: "test -f steps/" + id + ".txt",
});

const graphs: Record<string, unknown> = {
  菱形: { title: "菱形", tasks: [step("a"), step("b", "a"), step("c", "a"), step("d", "b", "c")] },
  有坏步: {
    title: "有坏步",
    tasks: [(({ check: _, ...s }) => s)(step("boom")), step("flaky"), step("after", "boom")],
  },
  先给个圈: { tasks: [step("x", "y"), step("y", "x")] },
  慢: { title: "慢", tasks: [step("slow")] },
  验收先行: {
    title: "验收先行",
    tasks: [
      { id: "repro", title: "复现", brief: "写一个现在会失败的测试", needs: [], agent: "lab", check: "test -f steps/fix.txt", acceptance: true },
      { id: "fix", title: "修", brief: "修好它", needs: ["repro"], agent: "lab" },
    ],
  },
};

/** Sessions played: a splitter answers with the task graph its goal names, a step writes its file, a few misbehave. */
class FakeWork implements TaskWork {
  n = 0;
  last = new Map<string, string>();
  attempts = new Map<string, number>();
  written = new Set<string>();
  started = new Set<string>();
  touched = new Map<string, string[]>();
  told = new Map<string, string[]>();
  release!: () => void;
  released = new Promise<void>((r) => (this.release = r));

  constructor(
    readonly core: Core["Service"],
    readonly issues: Issues["Service"],
  ) {}

  private async work(h: Session, input: string): Promise<[string, string]> {
    if (!h.graph?.task) {
      const graph = input.includes("计划有问题") ? { title: "改好了", tasks: [step("fixed")] } : graphs[/要做的事：(\S+)/.exec(input)?.[1] ?? ""];
      return ["completed", "读完了。\n\n```json\n" + JSON.stringify(graph, null, 2) + "\n```\n\n结论：拆好了。"];
    }
    const id = h.graph.task;
    const n = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, n);
    this.started.add(id);
    if (id === "boom") return ["failed", "provider said no"];
    if (id === "slow" && n === 1) {
      await this.released;
      return ["interrupted", ""];
    }
    if (id === "b" || id === "c") {
      // b and c wait (a few seconds at most) until both have started: run side by side, they always overlap.
      for (let i = 0; i < 500 && !(this.started.has("b") && this.started.has("c")); i++) await new Promise((r) => setTimeout(r, 10));
    }
    if (id === "repro" && n === 1) {
      this.written.add("fix");
      this.touched.set(id, ["steps/fix.txt", "steps/repro_test.txt"]);
      return ["completed", "结论：写了测试，顺手修好了"];
    }
    if (id === "repro") {
      this.written.delete("fix");
      this.touched.set(id, ["steps/repro_test.txt"]);
      return ["completed", "结论：steps/repro_test.txt 现在会失败"];
    }
    if (id === "fix" && n === 1) {
      this.touched.set(id, ["steps/repro_test.txt"]);
      return ["completed", "结论：把测试改松了"];
    }
    if (id === "flaky" && n === 1) return ["completed", "结论：做完了"];
    this.written.add(id);
    this.touched.set(id, ["steps/" + id + ".txt"]);
    return ["completed", "结论：写好了 steps/" + id + ".txt"];
  }

  private async run(id: string, input: string) {
    await new Promise((r) => setTimeout(r, 0));
    const h = this.core.session(id);
    if (!h) return;
    const [outcome, said] = await this.work(h, input);
    this.last.set(id, said);
    const at = said.lastIndexOf("结论：");
    const summary = outcome === "failed" || at < 0 ? said : said.slice(at + 3);
    await Effect.runPromise(this.core.apply({ type: "report", id: sessionId(id), outcome: outcome as never, summary, runs: 1 }));
  }

  hire = (agent: Agent, task: string, project: string, opt: HireOptions): Effect.Effect<Hired> => {
    const self = this;
    return Effect.gen(function* () {
      const id = `w${++self.n}`;
      const h = {
        id,
        name: "帮工" + id,
        agent: agent.id,
        runtime: agent.runtime,
        brief: task,
        project,
        worktree: "/wt/" + id,
        hiredAt: Date.now(),
        runs: 0,
        phase: { _tag: "working", doing: { action: "thinking", label: "" } },
        ...(opt.taskGraph ? { graph: opt.taskGraph } : {}),
      } as Session;
      yield* self.core.apply({ type: "hired", session: h });
      if (opt.issue) yield* self.issues.ran(opt.issue, h).pipe(Effect.orDie);
      void self.run(id, task);
      return { session: h };
    });
  };

  tell = (id: string, text: string): Effect.Effect<string> => {
    const self = this;
    return Effect.gen(function* () {
      self.told.set(id, [...(self.told.get(id) ?? []), text]);
      yield* self.core.apply({ type: "run", id: sessionId(id) });
      void self.run(id, text);
      return "说了";
    });
  };

  dismiss = (id: string) => Effect.as(this.core.apply({ type: "left", id: sessionId(id) }), true);

  find = (id: string): Roster | undefined => {
    const session = this.core.session(id);
    return session ? { session, place: { project: "", cwd: "" }, lastText: this.last.get(id) ?? "" } : undefined;
  };

  handOver: SessionShape["handOver"] = (id, _closed, use, settle = "owner") =>
    use({ project: "", cwd: "/wt/" + id }, this.last.get(id) ?? "").pipe(
      Effect.mapError((e) => {
        const failure = e instanceof MergeFailure ? e : MergeFailure.error(String(e));
        const words = notTakenIn(failure, id, settle);
        return new NotTakenIn({ failure, ...words, message: words.owner });
      }),
    );
}

class FakeGit implements TaskGit {
  branches: string[] = [];
  from = new Map<string, string>();
  constructor(readonly work: FakeWork) {}
  run = (_cwd: string, command: string) =>
    Effect.sync(() => {
      for (const m of command.matchAll(/steps\/(\w+)\.txt/g))
        if (!this.work.written.has(m[1]!)) return { ok: false, output: "steps/" + m[1] + ".txt: no such file" };
      return { ok: true, output: "" };
    });
  changedFiles = (cwd: string) =>
    Effect.sync(() => {
      const h = this.work.core.session(cwd.replace(/^\/wt\//, ""));
      return h?.graph?.task ? [...(this.work.touched.get(h.graph.task) ?? [])] : [];
    });
  openBranch = (_project: string, branch: string, from = "") =>
    Effect.sync(() => {
      this.branches.push(branch);
      this.from.set(branch, from);
    });
  mergeBranch = (project: string) => Effect.succeed("合进了 " + project + " 的 main");
  mergeInto = (place: Workplace) => Effect.succeed({ text: "", commits: 1, hashes: ["c0ffee-" + place.cwd.replace(/^\/wt\//, "")] });
  branchChanges = (project: string, branch: string) => Effect.succeed({ project, base: "main", branch } as unknown as Changes);
}

/** The farm with the task service on played sessions and git; the graph's states as each issue fact left them. */
const farm = Effect.gen(function* () {
  const core = yield* Core;
  const issues = yield* Issues;
  const agents = yield* Agents;
  for (const a of agents.agents()) yield* agents.saveAgent({ ...a, effort: "" });
  const work = new FakeWork(core, issues);
  const git = new FakeGit(work);
  const states: TaskGraph[] = [];
  yield* Effect.forkScoped(
    Stream.runForEach(yield* core.subscribe, (e) =>
      Effect.sync(() => {
        if (e.type !== "issue" || (!e.issue.graph && !e.issue.parent)) return;
        const graph = graphOf(core.state(), e.issue.parent ?? e.issue.id);
        if (graph) states.push(graph);
      }),
    ),
  );
  const tasks = yield* make({ usable: () => true, work, git });
  // As the farm's startup does once the sessions came back.
  yield* tasks.comeBack;
  const news: string[] = [];
  yield* Effect.forkScoped(Stream.runForEach(yield* tasks.news, (n) => Effect.sync(() => news.push(n))));
  const until = (id: string, ready: (g: TaskGraph) => boolean) =>
    untilGot(
      () => {
        const g = graphOf(core.state(), id);
        return g && ready(g) ? g : undefined;
      },
      () => `task ${id} to get there: ${JSON.stringify(graphOf(core.state(), id))}`,
      8_000,
    );
  const split = (goal: string, project: string) => Effect.map(tasks.split(goal, project, "", "user"), (said) => /（(p\d+)）/.exec(said)![1]!);
  return { core, issues, tasks, work, git, states, news, until, split };
});

const state = (g: TaskGraph, id: string) => taskOf(g, id)?.state;

const run = <A, E>(
  body: (f: Effect.Success<typeof farm>) => Effect.Effect<A, E, Core | Issues | SqlClient.SqlClient | import("effect").Scope.Scope>,
  config = testConfig(),
) => Effect.flatMap(farm, body).pipe(Effect.scoped, Effect.provide(worldBelowTasks({ config })));

describe("task graphs", () => {
  it.live("an event with malformed payload keeps its durable identity but no invented details", () =>
    run((f) =>
      Effect.gen(function* () {
        const id = yield* f.split("菱形", "diamond");
        yield* Effect.orDie(
          q.addGraphEvent({
            id: "bad-payload",
            graph_id: id,
            task_id: null,
            kind: "splitting",
            actor: "system",
            payload: `{"session":"w1","changes":[{"field":"check","from":1,"to":"ok"}]}`,
            created_at: 1,
          }),
        );
        const bad = (yield* f.tasks.events(id)).find((e) => e.id === "bad-payload")!;
        expect(bad).toMatchObject({ id: "bad-payload", graph: id, kind: "splitting", actor: "system" });
        expect([bad.session, bad.changes]).toEqual([undefined, undefined]);
      }),
    ),
  );

  it.live("a diamond is split, worked side by side, and merged", () =>
    run((f) =>
      Effect.gen(function* () {
        const id = yield* f.split("菱形", "diamond");
        const draft = yield* f.until(id, (g) => g.state === "draft" && !f.core.state().sessions.some((h) => h.graph?.id === id));
        expect(draft.tasks.map((n) => [n.id, n.needs.join(",")])).toEqual([
          ["a", ""],
          ["b", "a"],
          ["c", "a"],
          ["d", "b,c"],
        ]);
        expect(f.news[0]).toMatch(new RegExp("^【计划】" + id + " 拆好了"));
        // A step's removal, tried: what goes and who stops waiting for it, and the graph as it was.
        const preview = yield* f.tasks.previewRemoveTask(id, "b");
        expect(preview.does).toEqual([`从计划「${draft.title}」删掉「${taskOf(draft, "b")!.title}」这一步`, `「${taskOf(draft, "d")!.title}」不再等它`]);
        expect((yield* f.until(id, () => true)).tasks.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
        // An act the draft does not allow is refused with the ones it does, as commands.
        expect(yield* Effect.flip(f.tasks.act(id, "pause", "user"))).toMatchObject({
          next: [
            { say: "开工", run: ["graph", "act", id, "--json", '{"action":"start"}'] },
            { say: "放弃", run: ["graph", "act", id, "--json", '{"action":"abandon"}'] },
          ],
        });
        yield* f.tasks.editTask(id, "d", { check: "test -f steps/b.txt && test -f steps/c.txt && test -f steps/d.txt" }, "orchestrator");
        expect(yield* f.tasks.act(id, "start", "user")).toContain("开工了，分支 vibevalley/task-" + id + "-");
        const ready = yield* f.until(id, (g) => g.state === "ready");
        const mine = f.states.filter((g) => g.id === id);
        expect(mine.some((g) => state(g, "b") === "working" && state(g, "c") === "working")).toBe(true);
        const d = mine.find((g) => state(g, "d") === "working")!;
        expect([state(d, "b"), state(d, "c")]).toEqual(["merged", "merged"]);
        for (const n of ready.tasks)
          expect([n.state, (n.commits ?? []).length > 0, n.conclusion, n.session]).toEqual(["merged", true, "写好了 steps/" + n.id + ".txt", undefined]);
        expect(yield* f.tasks.act(id, "merge", "user")).toContain("合进了 diamond 的 main");
        yield* f.until(id, (g) => g.state === "done");
        const history = yield* f.tasks.events(id);
        expect(
          history
            .filter((e) => !e.task)
            .map((e) => e.kind + "/" + e.actor)
            .join(" "),
        ).toBe("splitting/user drafted/system started/user ready/system merged/user");
        const edit = history.find((e) => e.kind === "task_edited")!;
        expect([edit.task, edit.actor, edit.actorText, edit.changes?.length, edit.changes?.[0]?.field]).toEqual(["d", "orchestrator", "管家", 1, "检查"]);
        expect(edit.text).toMatch(/^改了「.+」的检查$/);
        for (const s of ["a", "b", "c", "d"])
          expect(
            history
              .filter((e) => e.task === s && e.kind !== "task_edited")
              .map((e) => e.kind)
              .join(" "),
          ).toBe("task_started task_merged");
        const merged = history.find((e) => e.task === "a" && e.kind === "task_merged")!;
        expect([merged.session !== undefined, (merged.commits ?? []).length > 0, merged.detail]).toEqual([true, true, "写好了 steps/a.txt"]);
        for (let i = 1; i < history.length; i++) expect(history[i]!.id > history[i - 1]!.id).toBe(true);
      }),
    ),
  );

  it.live("an acceptance step comes first, and is frozen", () =>
    run((f) =>
      Effect.gen(function* () {
        const id = yield* f.split("验收先行", "bug");
        const draft = yield* f.until(id, (g) => g.state === "draft");
        expect([isAcceptance(taskOf(draft, "repro")!), isAcceptance(taskOf(draft, "fix")!)]).toEqual([true, false]);
        yield* f.tasks.act(id, "start", "user");
        const ready = yield* f.until(id, (g) => g.state === "ready");
        const repro = taskOf(ready, "repro")!;
        const fix = taskOf(ready, "fix")!;
        expect([repro.frozen, fix.frozen, repro.tries, fix.tries]).toEqual([["steps/repro_test.txt"], undefined, 1, 1]);
        const told = (s: string) =>
          [...f.work.told.entries()]
            .filter(([w]) => f.core.session(w)?.graph?.task === s)
            .flatMap(([, t]) => t)
            .join("\n");
        expect(told("repro")).toContain("现在就通过了");
        expect(told("fix")).toContain("steps/repro_test.txt");
        expect(told("fix")).toContain("冻结");
        const brief = taskBrief(ready, fix);
        expect(brief).toContain("冻结的，不能改：steps/repro_test.txt");
        expect(brief).toContain("收尾的一步");
      }),
    ),
  );

  it.live("a failing step is sent back, then left for the owner to retry or skip", () =>
    run((f) =>
      Effect.gen(function* () {
        const id = yield* f.split("有坏步", "shaky");
        yield* f.until(id, (g) => g.state === "draft");
        yield* f.tasks.act(id, "start", "user");
        let stuck = yield* f.until(id, (g) => state(g, "boom") === "failed" && state(g, "flaky") === "merged");
        expect([taskOf(stuck, "boom")!.tries, taskOf(stuck, "flaky")!.tries, taskOf(stuck, "boom")!.failures]).toEqual([2, 1, 1]);
        expect(
          (yield* f.tasks.events(id)).some(
            (e) => e.kind === "task_sent_back" && e.task === "flaky" && e.actor === "system" && (e.detail ?? "").includes("没通过"),
          ),
        ).toBe(true);
        yield* f.tasks.taskAct(id, "boom", "retry", "user");
        stuck = yield* f.until(id, (g) => state(g, "boom") === "failed" && taskOf(g, "boom")!.failures === 2);
        expect(inbox(f.core.state()).map((c) => c.id)).toContain(id + ":failed:boom:2");
        const after = taskOf(stuck, "after")!;
        expect([after.state, blockedBy(stuck, after), stuck.state]).toEqual(["waiting", ["boom"], "running"]);
        expect(yield* Effect.flip(f.tasks.taskAct(id, "nope", "skip", "user"))).toMatchObject({
          _tag: "Missing",
          what: expect.stringContaining("没有「nope」"),
        });
        expect(yield* f.tasks.taskAct(id, "boom", "skip", "user")).toContain("跳过了");
        const ready = yield* f.until(id, (g) => g.state === "ready");
        expect(ready.tasks.map((n) => n.state)).toEqual(["skipped", "merged", "merged"]);
        const said = yield* f.tasks.act(id, "abandon", "user");
        const gone = yield* f.until(id, (g) => g.state === "abandoned");
        expect(said).toContain("分支 " + gone.branch + " 留着");
        expect(yield* Effect.flip(f.tasks.act(id, "merge", "user"))).toMatchObject({ reason: expect.stringContaining("不能合进主分支") });
      }),
    ),
  );

  it.live("a task graph with a problem is sent back once", () =>
    run((f) =>
      Effect.gen(function* () {
        const id = yield* f.split("先给个圈", "circle");
        const draft = yield* f.until(id, (g) => g.state === "draft");
        expect([draft.title, draft.tasks.map((n) => n.id)]).toEqual(["改好了", ["fixed"]]);
        expect(yield* Effect.flip(f.tasks.editTask(id, "fixed", { needs: ["fixed"] }, "user"))).toMatchObject({
          reason: expect.stringContaining("不能等自己"),
        });
        expect(yield* Effect.flip(f.tasks.changes(id))).toMatchObject({ reason: expect.stringContaining("没有分支") });
        yield* f.tasks.act(id, "abandon", "user");
        expect((yield* Effect.flip(f.tasks.split(" ", "x", "", "user")))._tag).toBe("Refused");
      }),
    ),
  );

  it.live("a graph working when the farm stopped is paused, and goes on when resumed", () => {
    const config = { ...testConfig(), db: "" };
    let id = "";
    let session = "";
    return Effect.gen(function* () {
      yield* run(
        (f) =>
          Effect.gen(function* () {
            id = yield* f.split("慢", "slowpoke");
            yield* f.until(id, (g) => g.state === "draft");
            yield* f.tasks.act(id, "start", "user");
            session = taskOf(yield* f.until(id, (g) => state(g, "slow") === "working"), "slow")!.session!;
          }),
        config,
      );
      yield* run(
        (f) =>
          Effect.gen(function* () {
            f.work.attempts.set("slow", 1);
            f.work.n = 9;
            const paused = yield* f.until(id, (g) => g.state === "paused");
            expect(paused.note).toContain("重启");
            // What the sessions do as the farm comes back: the run cut off is reported.
            yield* f.core.apply({ type: "report", id: sessionId(session), outcome: "interrupted", summary: "VibeValley 重启了", runs: 1 });
            f.work.release();
            yield* f.tasks.act(id, "resume", "user");
            const ready = yield* f.until(id, (g) => g.state === "ready");
            expect(state(ready, "slow")).toBe("merged");
            expect((yield* f.tasks.events(id))[0]!.kind).toBe("splitting");
          }),
        config,
      );
    });
  });

  it("choosing a profile, and the splitter's brief", () => {
    const a = (id: string, runtime: string, ...tags: string[]) => ({ id, name: "名" + id, runtime, tags }) as Agent;
    const cands = [
      { agent: a("x", "pi", "测试"), usable: true },
      { agent: a("y", "claude", "前端", "页面"), usable: true },
      { agent: a("z", "codex"), usable: false },
    ];
    for (const [task, named, want] of [
      ["改页面的前端", "", "y"],
      ["随便", "", "x"],
      ["随便", "z", "z"],
      ["随便", "名y", "y"],
      ["随便", "claude", "y"],
      ["随便", "codex", "x"],
    ] as const)
      expect(chooseAgent(cands, task, named, "")?.id).toBe(want);
    expect(chooseAgent(cands.slice(2), "x", "", "")).toBeUndefined();
    expect(clip("  一二三\n四五  ", 4)).toBe("一二三…");
    const brief = splitBrief("做个打卡", "clock", [a("lab", "pi", "实验")]);
    for (const want of ["要做的事：做个打卡", '"agent": "lab"', "  - lab：名lab，适合的活：实验"]) expect(brief).toContain(want);
    const example = parseSplit(brief);
    expect(example.ok && isAcceptance(example.tasks[0]!)).toBe(true);
  });

  it.live("a graph is a parent issue, its steps the issues under it", () =>
    run((f) =>
      Effect.gen(function* () {
        const id = yield* f.split("菱形", "diamond");
        yield* f.until(id, (g) => g.state === "draft");
        const parent = yield* f.issues.get(id);
        expect([parent.graph !== undefined, parent.title, parent.sessions.length, parent.status]).toEqual([true, "菱形", 1, "in_review"]);
        const d = yield* f.issues.get(taskIssueID(id, "d"));
        expect([d.parent, d.blockedBy, d.status]).toEqual([id, [id + ".b", id + ".c"], "backlog"]);
        expect((yield* Effect.flip(f.issues.edit(d.id, { title: "改" })))._tag).toBe("Refused");
        expect((yield* Effect.flip(f.issues.start(d.id, "")))._tag).toBe("Refused");
        yield* f.tasks.act(id, "start", "user");
        yield* f.until(id, (g) => g.state === "ready");
        const a = yield* f.issues.get(taskIssueID(id, "a"));
        expect([a.sessions.length, a.delivered]).toEqual([1, "merged_into_parent"]);
        expect((yield* f.issues.get(a.sessions[0]!)).id).toBe(a.id);
        expect((yield* Effect.flip(f.issues.reopen(a.id, "", "")))._tag).toBe("Refused");
        yield* f.tasks.act(id, "merge", "user");
        yield* Effect.promise(async () => {
          for (let i = 0; i < 300; i++) {
            if ((await Effect.runPromise(f.issues.get(id))).delivered === "merged") return;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error("the graph's issue never closed as merged");
        });
      }),
    ),
  );

  it.live("a helper splits its issue, and its steps start at once", () =>
    run((f) =>
      Effect.gen(function* () {
        const issue = yield* f.issues.add({ title: "整个看板重做", description: "像 Linear 那样", project: "board", assignee: "lab" });
        yield* f.issues.edit(issue.id, { criteria: ["卡片紧凑"] });
        const helper = {
          id: "h1",
          name: "小吴",
          agent: "lab",
          runtime: "pi",
          brief: "",
          project: "board",
          branch: "vibevalley/issue-1",
          worktree: "/wt/h1",
          issue: issue.id,
          hiredAt: Date.now(),
          runs: 0,
          phase: { _tag: "working", doing: { action: "thinking", label: "" } },
        } as Session;
        yield* f.core.apply({ type: "hired", session: helper });
        yield* f.issues.ran(issue.id, helper).pipe(Effect.orDie);
        const steps = [
          { id: "a", brief: "卡片", check: "true" },
          { id: "b", brief: "列表", check: "true" },
          { id: "c", brief: "合起来", needs: ["a", "b"] },
        ];
        expect(yield* f.tasks.splitIssue("h1", "", steps)).toMatch(/3 张子工单/);
        const graph = yield* f.until(issue.id, (g) => state(g, "a") !== "waiting" && state(g, "b") !== "waiting");
        expect([graph.title, graph.goal, graph.project]).toEqual(["整个看板重做", "像 Linear 那样", "board"]);
        expect(f.git.from.get(graph.branch!)).toBe("vibevalley/issue-1");
        const parent = yield* f.issues.get(issue.id);
        expect([parent.number, parent.assignee, parent.criteria, parent.sessions[0]]).toEqual([issue.number, "lab", ["卡片紧凑"], "h1"]);
        expect((yield* f.issues.get(taskIssueID(issue.id, "c"))).parent).toBe(issue.id);
        expect((yield* Effect.exit(f.tasks.splitIssue("h1", "", steps)))._tag).toBe("Failure");
        yield* f.core.apply({ type: "report", id: sessionId("h1"), outcome: "completed", summary: "拆成了三步", runs: 1 });
        yield* Effect.promise(async () => {
          for (let i = 0; i < 300 && f.core.session("h1"); i++) await new Promise((r) => setTimeout(r, 10));
        });
        expect(f.core.session("h1")).toBeUndefined();
        expect((yield* f.issues.get(issue.id)).closedAt).toBeUndefined();
      }),
    ),
  );

  for (const action of ["pause", "resume", "abandon", "retry", "skip", "edit"] as const)
    it.live(`a graph that cannot be saved does nothing more: ${action}`, () =>
      run((f) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const graph = {
            id: "p900",
            title: "保存失败",
            goal: "",
            project: "test",
            state: action === "resume" ? "paused" : "running",
            parallel: 1,
            createdAt: 0,
            tasks: [{ id: "a", title: "步骤", brief: "做事", needs: [], state: "failed", session: sessionId("w900"), tries: 0 }],
          } as TaskGraph;
          yield* f.issues.putTask(graph);
          yield* f.core.apply({
            type: "hired",
            session: { id: "w900", name: "帮工", agent: "lab", runtime: "pi", brief: "", hiredAt: 0, runs: 0, phase: { _tag: "resting" } } as Session,
          });
          yield* sql
            .unsafe(`create function fail_save() returns trigger language plpgsql as $$ begin raise exception 'injected write failure'; end $$`)
            .pipe(Effect.orDie);
          yield* sql.unsafe(`create trigger fail_save before insert or update on issue for each row execute function fail_save()`).pipe(Effect.orDie);
          const before = { told: f.work.told.size, hired: f.work.n, left: f.core.session("w900") !== undefined };
          const done =
            action === "retry" || action === "skip"
              ? f.tasks.taskAct(graph.id, "a", action, "user")
              : action === "edit"
                ? f.tasks.editTask(graph.id, "a", { title: "changed" }, "user")
                : f.tasks.act(graph.id, action, "user");
          expect(yield* Effect.flip(done)).toMatchObject({ reason: expect.stringContaining("injected write failure") });
          expect({ told: f.work.told.size, hired: f.work.n, left: f.core.session("w900") !== undefined }).toEqual(before);
          const after = graphOf(f.core.state(), graph.id)!;
          expect([after.state, after.title, after.tasks[0]!.state]).toEqual([graph.state, graph.title, "failed"]);
          yield* sql.unsafe(`drop trigger fail_save on issue`).pipe(Effect.orDie);
          if (action === "pause") yield* f.tasks.act(graph.id, "pause", "user");
        }),
      ),
    );
});
