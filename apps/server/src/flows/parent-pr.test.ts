import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { Agent } from "@/agent/agent.ts";
import { owner } from "@/base/actor.ts";
import { Issue } from "@/issue/issue.ts";
import { explicitMandate } from "@/issue/mandate.ts";
import { Project } from "@/project/project.ts";
import { testConfig } from "@/testing/layers.ts";

import { await_, farm, git, lab } from "./farm.ts";

for (const ending of ["MERGED", "CLOSED"] as const) {
  it.live(`regression: a parent without a session closes after its PR is ${ending.toLowerCase()}`, () => {
    const base = testConfig();
    const config = { ...base, github: { ...base.github, prProjects: ["family-pr"] } };
    const path = join(config.workRoot, "projects", "family-pr");
    const bare = join(config.workRoot, "origin.git");
    let state = "OPEN";
    const f = farm({
      config,
      repos: ["family-pr"],
      projects: {
        gh: (...args) =>
          Effect.sync(() => {
            const ok = (out: string) => ({ out, ok: true, missing: false });
            if (args[0] === "--version") return ok("gh version 2.80.0");
            if (args[0] === "auth") return ok("Logged in to github.com account gardener (keyring)");
            if (args[0] === "repo") return ok('{"viewerPermission":"WRITE"}');
            if (args[0] === "pr" && args[1] === "list") return ok("[]");
            if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/test/family-pr/pull/1");
            if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ state, mergedAt: null }));
            return { out: "", ok: false, missing: false };
          }),
        push: (cwd, branch) =>
          Effect.sync(() => {
            git(cwd, "push", bare, branch);
            return true;
          }),
        fetch: () => Effect.succeed(false),
      },
    });
    return Effect.gen(function* () {
      const issues = yield* Issue;
      const projects = yield* Project;
      yield* (yield* Agent).save(lab());
      git(config.workRoot, "init", "--bare", bare);
      git(path, "remote", "add", "origin", "https://github.com/test/family-pr.git");
      yield* projects.refreshGitHub();
      const parent = yield* issues.add({ title: "parent", project: "family-pr", agent: "lab" }, explicitMandate());
      yield* issues.split(parent.id, "", [{ id: "clock", brief: "写打卡并提交" }], owner);
      yield* await_(
        () => issues.get(parent.id),
        (issue) => issue.status === "in_review",
        "the parent ready for review",
      );
      const submitted = yield* issues.setStatus(parent.id, "done", "", "", owner);
      expect(latestSessionIdOf(submitted)).toBeUndefined();
      expect(submitted.pullRequest?.state).toBe("open");
      const place = yield* projects.workplace("family-pr", parent.number, true, "");
      expect(existsSync(place.cwd)).toBe(true);
      state = ending;
      yield* issues.refreshPullRequests;
      const finished = yield* issues.get(parent.id);
      expect(finished.status).toBe(ending === "MERGED" ? "done" : "canceled");
      expect(finished.pullRequest?.state).toBe(ending === "MERGED" ? "merged" : "closed");
      expect(existsSync(place.cwd)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
}
