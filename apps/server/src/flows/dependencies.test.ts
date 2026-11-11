import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { assignedAgentOf, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { user } from "#/base/actor.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { Issue } from "#/modules/issue/issue.ts";
import { issueBranch, Repo } from "#/modules/repo/repo.ts";
import { Session } from "#/modules/session/session.ts";
import { gitSync } from "#/testing/git.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab } from "./farm.ts";

it.live("regression: native child issues wait for prerequisites and start from their parent's branch", () => {
  const release = Promise.withResolvers<void>();
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        await release.promise;
        turn.say("收到");
      },
    }),
  });
  return Effect.gen(function* () {
    const service = yield* Issue;
    const issues = testIssues(service);
    const sessions = yield* Session;
    yield* (yield* Agent).save(lab());
    const parent = yield* issues.add({ title: "父工单", agent: "lab", repo: "native" });
    const parentPlace = yield* (yield* Repo).workplace("native", parent.number, true, "");
    gitSync(parentPlace.cwd, "commit", "--allow-empty", "-m", "Prepare parent work");
    const parentHead = gitSync(parentPlace.cwd, "rev-parse", "HEAD");
    const prerequisite = yield* issues.add({ title: "前置工单", agent: "lab", repo: "native" });
    const child = yield* issues.add({ title: "子工单", parent: parent.id, blockedBy: [prerequisite.id] });
    expect([child.repo, assignedAgentOf(child)]).toEqual([parent.repo, "lab"]);
    expect(child.stage.acts.map((act) => act.act)).toContain("start");
    expect((yield* issues.start(child.id, "")).queued).toBeDefined();
    yield* (yield* Issue).refreshQueue;
    expect(sessions.hired()).toEqual([]);
    yield* service.setStatus(prerequisite.id, "canceled", "", "", user);
    yield* (yield* Issue).refreshQueue;
    const started = yield* await_(
      () => issues.get(child.id),
      (item) => latestSessionIdOf(item) !== undefined,
      "the unblocked child",
    );
    const session = sessions.sessionOf(latestSessionIdOf(started)!)!;
    expect(session.branch).toBe(issueBranch(child.number));
    expect(gitSync(session.worktree!, "merge-base", parentHead, "HEAD")).toBe(parentHead);
    expect((yield* issues.get(child.id)).blockedBy).toEqual([prerequisite.id]);
  }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())), Effect.scoped, Effect.provide(f.layer));
});
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

it.live("regression: child changes merge into the parent worktree and reach main only after parent acceptance", () => {
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        writeFileSync(join(turn.options.cwd, "child.txt"), "child result");
        gitSync(turn.options.cwd, "add", "child.txt");
        gitSync(turn.options.cwd, "commit", "-m", "Implement child work");
        turn.say("完成");
      },
    }),
  });
  return Effect.gen(function* () {
    const service = yield* Issue;
    const issues = testIssues(service);
    const repos = yield* Repo;
    yield* (yield* Agent).save(lab());
    const parent = yield* issues.add({ title: "父工单", agent: "lab", repo: "merge-family" });
    const child = yield* issues.add({ title: "子工单", parent: parent.id });
    yield* issues.start(parent.id, "");
    const completed = yield* await_(
      () => issues.get(child.id),
      (item) => item.status === "done",
      "the child merged into its parent",
    );
    expect(completed.delivered).toBe("merged_into_parent");
    expect((yield* issues.get(parent.id)).status).toBe("in_review");
    const place = yield* repos.workplace("merge-family", parent.number, true, "");
    expect(readFileSync(join(place.cwd, "child.txt"), "utf8")).toBe("child result");
    expect(gitSync(place.cwd, "status", "--porcelain")).toBe("");
    const main = join(f.config.workRoot, "repos", "merge-family");
    expect(existsSync(join(main, "child.txt"))).toBe(false);
    yield* service.setStatus(parent.id, "done", "", "", user);
    expect(readFileSync(join(main, "child.txt"), "utf8")).toBe("child result");
    expect((yield* issues.get(parent.id)).delivered).toBe("merged");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: automatic child merge preserves uncommitted parent work", () => {
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        writeFileSync(join(turn.options.cwd, "child.txt"), "child result");
        gitSync(turn.options.cwd, "add", "child.txt");
        gitSync(turn.options.cwd, "commit", "-m", "Implement child work");
        turn.say("完成");
      },
    }),
  });
  return Effect.gen(function* () {
    const issue = yield* Issue;
    const issues = testIssues(issue);
    yield* (yield* Agent).save(lab());
    const parent = yield* issues.add({ title: "父工单", agent: "lab", repo: "dirty-parent" });
    const place = yield* (yield* Repo).workplace("dirty-parent", parent.number, true, "");
    writeFileSync(join(place.cwd, "user.txt"), "unfinished user work");
    const before = gitSync(place.cwd, "rev-parse", "HEAD");
    const child = yield* issues.add({ title: "子工单", parent: parent.id });
    yield* issues.start(child.id, "");
    yield* await_(
      () => issues.get(child.id),
      (item) => item.questions.length > 0,
      "the blocked merge explained",
    );
    expect((yield* issues.get(child.id)).delivered).toBeUndefined();
    expect(gitSync(place.cwd, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(place.cwd, "user.txt"), "utf8")).toBe("unfinished user work");
    expect(existsSync(join(place.cwd, "child.txt"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});
