import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { user } from "#/base/actor.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import { repository } from "#/modules/repo/repository.ts";
import { testConfig } from "#/testing/layers.ts";

import { await_, farm, git, lab } from "./farm.ts";

for (const ending of ["MERGED", "CLOSED"] as const) {
  test(`regression: a parent without a session closes after its PR is ${ending.toLowerCase()}`, async () => {
    const base = testConfig();
    const config = { ...base, github: { ...base.github, prRepos: ["family-pr"] } };
    const path = join(config.workRoot, "repos", "family-pr");
    const bare = join(config.workRoot, "origin.git");
    let state = "OPEN";
    const f = farm({
      config,
      repos: ["family-pr"],
      repoHooks: {
        gh: (...args) =>
          (async () => {
            const ok = (out: string) => ({ out, ok: true, missing: false });
            if (args[0] === "--version") return ok("gh version 2.80.0");
            if (args[0] === "auth") return ok("Logged in to github.com account gardener (keyring)");
            if (args[0] === "repo") return ok('{"viewerPermission":"WRITE","defaultBranchRef":{"name":"main"}}');
            if (args[0] === "pr" && args[1] === "list") return ok("[]");
            if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/test/family-pr/pull/1");
            if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ state, mergedAt: null }));
            return { out: "", ok: false, missing: false };
          })(),
        publication: {
          tip: () => repository(path).head(),
          fetch: () => Promise.resolve(),
          push: (cwd, _url, branch, sha) => repository(cwd).push(bare, branch, sha),
        },
        fetch: () => Promise.resolve(false),
      },
    });
    await using fw = await f.open();
    const issues = fw.issue;
    const repos = fw.repo;
    await fw.agent.save(lab());
    git(config.workRoot, "init", "--bare", bare);
    git(path, "remote", "add", "origin", "https://github.com/test/family-pr.git");
    await repos.refreshGitHub();
    const parent = await issues.add({ title: "parent", repo: "family-pr", agent: "lab" }, explicitMandate());
    await issues.split(parent.id, "", [{ id: "clock", brief: "写打卡并提交" }], user);
    await await_(
      () => issues.get(parent.id),
      (issue) => issue.status === "in_review",
      "the parent ready for review",
    );
    const submitted = await issues.setStatus(parent.id, "done", "", "", user);
    expect(latestSessionIdOf(submitted)).toBeUndefined();
    expect(submitted.pullRequest?.state).toBe("open");
    const place = await repos.checkout({ repo: "family-pr", issue: parent.number, worktree: true, base: "" });
    expect(existsSync(place.cwd)).toBe(true);
    state = ending;
    await issues.refreshPullRequests();
    const finished = await issues.get(parent.id);
    expect(finished.status).toBe(ending === "MERGED" ? "done" : "canceled");
    expect(finished.pullRequest?.state).toBe(ending === "MERGED" ? "merged" : "closed");
    expect(existsSync(place.cwd)).toBe(false);
  });
}
