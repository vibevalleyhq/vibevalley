import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { Agent } from "#/agent/agent.ts";
import { owner } from "#/base/actor.ts";
import { Core } from "#/core/core.ts";
import { inbox } from "#/inbox/items.ts";
import { Issue } from "#/issue/issue.ts";
import { Repo } from "#/repo/repo.ts";
import { Session } from "#/session/session.ts";
import { gitSync } from "#/testing/git.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab } from "./farm.ts";

it.live("regression: a parent without a session can receive and resolve its own branch conflict", () => {
  let turns = 0;
  const f = farm({
    repos: ["parent-conflict"],
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        const fixing = turns++ > 0;
        if (fixing) expect(turn.input).toContain("same.ts");
        writeFileSync(join(turn.options.cwd, "same.ts"), fixing ? "main\n" : "child\n");
        gitSync(turn.options.cwd, "add", ".");
        gitSync(turn.options.cwd, "commit", "-m", fixing ? "Resolve conflict" : "Implement child");
        turn.say("done");
      },
    }),
  });
  return Effect.gen(function* () {
    const issues = yield* Issue;
    yield* (yield* Agent).save(lab());
    const root = join(f.config.workRoot, "repos", "parent-conflict");
    writeFileSync(join(root, "same.ts"), "base\n");
    gitSync(root, "add", ".");
    gitSync(root, "commit", "-m", "Prepare conflict file");
    const parent = yield* testIssues(issues).add({ title: "parent", repo: "parent-conflict", agent: "lab" });
    yield* issues.split(parent.id, "", [{ id: "child", title: "child", brief: "child work" }], owner);
    yield* await_(
      () => issues.get(parent.id),
      (item) => item.status === "in_review",
      "the child merged into its parent",
    );
    writeFileSync(join(root, "same.ts"), "main\n");
    gitSync(root, "add", ".");
    gitSync(root, "commit", "-m", "Change main");
    yield* issues.changes(parent.id, owner);
    const conflicted = yield* issues.get(parent.id);
    expect(conflicted.conflict).toEqual({ base: "main", files: ["same.ts"] });
    expect(conflicted.stage).toMatchObject({ state: "stuck", stuck: "conflict" });
    expect(inbox((yield* Core).state()).some((item) => item.kind === "conflict" && item.target.kind === "issue" && item.target.id === parent.id)).toBe(true);
    yield* issues.setStatus(parent.id, "todo", "", "", owner);
    const resolved = yield* await_(
      () => issues.get(parent.id),
      (item) => item.status === "in_review" && item.conflict === undefined,
      "the parent conflict resolved",
    );
    expect(latestSessionIdOf(resolved)).toBeDefined();
    expect((yield* issues.setStatus(parent.id, "done", "", "", owner)).status).toBe("done");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: splitting creates real queued issues whose dependencies merge into the parent", () => {
  const first = Promise.withResolvers<void>();
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        const next = existsSync(join(turn.options.cwd, "first.txt"));
        if (!next) await first.promise;
        writeFileSync(join(turn.options.cwd, next ? "second.txt" : "first.txt"), "done");
        gitSync(turn.options.cwd, "add", ".");
        gitSync(turn.options.cwd, "commit", "-m", "Implement child issue");
        turn.say("finished");
      },
    }),
  });
  return Effect.gen(function* () {
    const service = yield* Issue;
    const issues = testIssues(service);
    yield* (yield* Agent).save(lab());
    const parent = yield* issues.add({ title: "parent", agent: "lab", repo: "split" });
    yield* service.split(
      parent.id,
      "split parent",
      [
        { id: "first", title: "first", brief: "first work" },
        { id: "second", title: "second", brief: "second work", needs: ["first"] },
      ],
      owner,
    );
    const children = (yield* issues.list()).filter((item) => item.parent === parent.id);
    const a = children.find((item) => item.title === "first")!;
    const b = children.find((item) => item.title === "second")!;
    expect(children).toHaveLength(2);
    expect(b.blockedBy).toEqual([a.id]);
    expect(b.status).toBe("todo");
    expect(a.stage.acts.length).toBeGreaterThan(0);
    first.resolve();
    yield* await_(
      () => issues.get(a.id),
      (item) => item.status === "done",
      "the first child merged",
    );
    yield* (yield* Issue).refreshQueue;
    yield* await_(
      () => issues.get(b.id),
      (item) => item.status === "done",
      "the dependent child merged",
    );
    expect((yield* issues.get(parent.id)).status).toBe("in_review");
    const waiting = inbox((yield* Core).state()).filter((item) => item.kind === "review");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.target).toEqual({ kind: "issue", id: parent.id });
    expect((yield* service.changes(parent.id, owner)).commits.length).toBeGreaterThan(0);
    const place = yield* (yield* Repo).workplace("split", parent.number, true, "");
    expect(readFileSync(join(place.cwd, "second.txt"), "utf8")).toBe("done");
    yield* service.setStatus(parent.id, "done", "", "", owner);
    const core = yield* Core;
    yield* await_(
      () => core.state().progress,
      (progress) => progress?.counts.big_graph === 2,
      "the completed family reward",
    );
    expect(core.state().progress?.counts.s_split).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: a failed split commits no child, assignment, queue entry or parent rename", () => {
  const f = farm();
  return Effect.gen(function* () {
    const service = yield* Issue;
    const issues = testIssues(service);
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* Agent).save(lab());
    const parent = yield* issues.add({ title: "parent", agent: "lab", repo: "split-failure" });
    yield* sql
      .unsafe(
        "create trigger reject_child before insert on issue for each row when (NEW.title = 'second') begin select raise(abort, 'child write failed'); end",
      )
      .pipe(Effect.orDie);
    const result = yield* Effect.flip(
      service.split(
        parent.id,
        "renamed",
        [
          { id: "first", title: "first", brief: "work" },
          { id: "second", title: "second", brief: "work", needs: ["first"] },
        ],
        owner,
      ),
    );
    expect(result._tag).toBe("Refused");
    expect((yield* issues.list()).map((item) => [item.id, item.title])).toEqual([[parent.id, "parent"]]);
    expect((yield* Core).state().issues.map((item) => item.id)).toEqual([parent.id]);
    expect((yield* Session).presentSessions()).toEqual([]);
    const unsafe2 = yield* sql.unsafe("select * from mailbox_trigger where trigger_json->'meta'->'dispatch' = 'true'").pipe(Effect.orDie);
    expect(unsafe2).toHaveLength(0);
    const unsafe3 = yield* sql.unsafe("select * from mailbox_issue").pipe(Effect.orDie);
    expect(unsafe3).toHaveLength(0);
    const unsafe4 = yield* sql.unsafe("select * from issue_assignment").pipe(Effect.orDie);
    expect(unsafe4).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});
