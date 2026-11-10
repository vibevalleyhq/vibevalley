import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Formatter, Layer } from "effect";

import type * as T from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";
import { waitFor } from "@vibevalley/testkit/until";

import { ServerConfig } from "#/infra/config.ts";
import { gitSync, repo, write } from "#/testing/git.ts";
import { testConfig } from "#/testing/layers.ts";

import { GitError, run } from "./git.ts";
import { type GitHubRun } from "./github.ts";
import { hostedOrigin } from "./hosting.ts";
import { Repo, type RepoHooks } from "./repo.ts";
import { repository } from "./repository.ts";

function fixture(platform: T.PublishPlatform = "github", script = "#!/bin/sh\nexit 0\n", existing = false) {
  const dir = tempDir("publish-");
  const cwd = join(dir, "checkout");
  const bare = join(dir, "origin.git");
  repo(cwd, 1, 0);
  gitSync(cwd, "clone", "--bare", cwd, bare);
  gitSync(cwd, "checkout", "-b", "feat/publish");
  mkdirSync(join(cwd, ".vibevalley"));
  write(join(cwd, ".vibevalley/check"), script, 0o755);
  gitSync(cwd, "add", ".");
  gitSync(cwd, "commit", "-m", "check");

  gitSync(cwd, "remote", "add", "origin", `https://${platform}.com/team/repo.git`);
  const req: T.SubmitBranch = { cwd, branch: "feat/publish", sha: gitSync(cwd, "rev-parse", "HEAD"), base: "main", title: "Feature", body: "Details" };
  const calls: string[][] = [];
  let created = existing;
  const url = `https://${platform}.com/team/repo/${platform === "github" ? "pull" : "-/merge_requests"}/7`;
  const command: GitHubRun = (...args) =>
    Effect.sync(() => {
      calls.push(args);
      if (args[0] === "auth") return { ok: true, missing: false, out: "" };
      if (args.includes("defaultBranchRef")) return { ok: true, missing: false, out: Formatter.formatJson({ defaultBranchRef: { name: "main" } }) };
      if (args[1] === "projects/team%2Frepo") return { ok: true, missing: false, out: Formatter.formatJson({ default_branch: "main" }) };
      const item =
        platform === "github"
          ? { number: 7, url, isCrossRepository: false, state: "OPEN" }
          : { iid: 7, web_url: url, source_project_id: 1, target_project_id: 1, state: "opened" };
      if (args[1] === "list" || args[1]?.includes("?state=opened") === true)
        return { ok: true, missing: false, out: Formatter.formatJson(created ? [item] : []) };
      created = true;
      return { ok: true, missing: false, out: platform === "github" ? url : Formatter.formatJson(item) };
    });
  const pushed: string[][] = [];
  const hooks: RepoHooks = {
    command: (file, args, options) => run("sh", [file, ...args], options),
    gh: command,
    glab: command,
    publication: {
      tip: (_cwd, _url, branch) => repository(bare).tip(branch),
      fetch: (path, _url, branch) => repository(path).fetch(bare, branch),
      push: (path, url, branch, sha) => {
        pushed.push([url, branch, sha]);
        return repository(path).push(bare, branch, sha);
      },
    },
  };
  const layer = Repo.layer(hooks).pipe(
    Layer.provide(Layer.merge(NodeServices.layer, Layer.succeed(ServerConfig, testConfig({ workRoot: join(dir, "space") })))),
  );
  return { cwd, bare, req, calls, url, pushed, hooks, layer };
}

for (const platform of ["github", "gitlab"] as const) {
  for (const existing of [false, true]) {
    it.effect(`${platform} publishes the checked SHA and ${existing ? "reuses" : "creates"} an open request`, () => {
      const f = fixture(platform, "#!/bin/sh\nexit 0\n", existing);
      return Effect.gen(function* () {
        const result = yield* (yield* Repo).submitBranch(f.req);
        expect(result).toMatchObject({ url: f.url, check: "passed", pushed: true, reused: existing });
        expect(f.pushed).toEqual([[`https://${platform}.com/team/repo.git`, f.req.branch, f.req.sha]]);
        expect(gitSync(f.bare, "rev-parse", f.req.branch)).toBe(f.req.sha);
        expect(gitSync(f.cwd, "status", "--porcelain")).toBe("");
      }).pipe(Effect.provide(f.layer));
    });
  }
}

it.effect("preview does not run the check or contact the Git network", () => {
  const f = fixture("github", "#!/bin/sh\nexit 1\n");
  return Effect.gen(function* () {
    const branchSubmitted = yield* (yield* Repo).submitBranch({ ...f.req, dryRun: true });
    expect(branchSubmitted).toMatchObject({ pushed: false, check: "preview" });
    expect(f.pushed).toEqual([]);
    expect(f.calls.map((args) => args[0])).toEqual(["auth", "repo"]);
  }).pipe(Effect.provide(f.layer));
});

for (const scenario of [
  "dirty",
  "wrong-branch",
  "wrong-sha",
  "detached",
  "default",
  "invalid-ref",
  "pushurl",
  "ambiguous",
  "rewrite",
  "check-failed",
  "check-dirty",
  "check-head",
  "check-remote",
  "check-base",
] as const) {
  it.effect(`publication refuses ${scenario} without pushing or removing the checkout`, () => {
    const scripts: Partial<Record<typeof scenario, string>> = {
      "check-failed": "exit 1",
      "check-dirty": "echo changed > new-file",
      "check-head": "git -c user.name=test -c user.email=test@test commit --allow-empty -m moved",
      "check-remote": "git remote set-url origin https://github.com/other/repo.git",
      "check-base": "git push ../origin.git HEAD:refs/heads/main",
    };
    const f = fixture("github", `#!/bin/sh\n${scripts[scenario] ?? "exit 0"}\n`);
    let req = f.req;
    if (scenario === "dirty") write(join(f.cwd, "dirty"), "dirty");
    if (scenario === "wrong-branch") req = { ...req, branch: "feat/other" };
    if (scenario === "wrong-sha") req = { ...req, sha: "0".repeat(40) };
    if (scenario === "detached") gitSync(f.cwd, "checkout", "--detach");
    if (scenario === "default") {
      gitSync(f.cwd, "checkout", "main");
      req = { ...req, branch: "main", sha: gitSync(f.cwd, "rev-parse", "HEAD") };
    }
    if (scenario === "invalid-ref") req = { ...req, base: "main~1" };
    if (scenario === "pushurl") gitSync(f.cwd, "remote", "set-url", "--push", "origin", "https://github.com/other/repo.git");
    if (scenario === "ambiguous") gitSync(f.cwd, "remote", "add", "other", "https://gitlab.com/other/repo.git");
    if (scenario === "rewrite") gitSync(f.cwd, "config", "url.https://github.com/other/.pushInsteadOf", "https://github.com/team/");

    return Effect.gen(function* () {
      yield* Effect.flip((yield* Repo).submitBranch(req));
      expect(f.pushed).toEqual([]);
      expect(existsSync(f.cwd)).toBe(true);
      expect(gitSync(f.bare, "branch", "--list", f.req.branch)).toBe("");
    }).pipe(Effect.provide(f.layer));
  });
}

for (const stage of ["missing", "auth", "decode", "create"] as const) {
  it.effect(`platform ${stage} failures report whether pushing happened`, () => {
    const f = fixture("gitlab");
    const original = f.hooks.glab ?? (() => Effect.succeed({ ok: false, missing: true, out: "" }));
    const glab: GitHubRun = (...args) =>
      stage === "create" && !args.includes("POST")
        ? original(...args)
        : Effect.succeed({ ok: stage === "decode", missing: stage === "missing", out: "untrusted token must stay private" });
    const layer = Repo.layer({ ...f.hooks, glab }).pipe(Layer.provide(Layer.merge(NodeServices.layer, Layer.succeed(ServerConfig, testConfig()))));
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Repo).submitBranch(f.req));
      expect(error.message).not.toContain("untrusted token");
      expect(f.pushed.length).toBe(stage === "create" ? 1 : 0);
      if (stage === "create") expect(error.message).toContain("已推送");
    }).pipe(Effect.provide(layer));
  });
}

it("only known hosting domains are recognized", () => {
  expect(hostedOrigin("git@gitlab.com:group/subgroup/repo.git")).toMatchObject({ platform: "gitlab", name: "group/subgroup/repo" });
  for (const url of [
    "git@github.com/team/repo",
    "https://github.com:team/repo",
    "git@unknown.test:group/repo",
    "https://token@gitlab.com/g/r",
    "https://gitlab.com.evil/g/r",
    "git@github.com:org/repo/extra",
  ])
    expect(hostedOrigin(url)).toBeUndefined();
});

it.effect("canceling a running check kills its process and retains the checkout", () => {
  const f = fixture("github", "#!/bin/sh\necho $$ > ../check.pid\nexec sleep 60\n");
  const pidFile = join(f.cwd, "..", "check.pid");
  return Effect.gen(function* () {
    const service = yield* Repo;
    const fiber = yield* service.submitBranch(f.req).pipe(Effect.forkChild);
    yield* waitFor(
      Effect.sync(() => existsSync(pidFile)),
      Boolean,
      "check started",
    );
    const pid = readFileSync(pidFile, "utf8").trim();
    yield* Fiber.interrupt(fiber);
    yield* waitFor(run("kill", ["-0", pid]), (r) => r.code !== 0, "check stopped");
    expect(f.pushed).toEqual([]);
    expect(existsSync(f.cwd)).toBe(true);
    expect(gitSync(f.cwd, "rev-parse", "HEAD")).toBe(f.req.sha);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect("a missing check is reported as not-run", () => {
  const f = fixture();
  gitSync(f.cwd, "rm", ".vibevalley/check");
  gitSync(f.cwd, "commit", "-m", "no check");
  return Effect.gen(function* () {
    const result = yield* (yield* Repo).submitBranch({ ...f.req, sha: gitSync(f.cwd, "rev-parse", "HEAD") });
    expect(result.check).toBe("not-run");
    expect(result.url).toBe(f.url);
  }).pipe(Effect.provide(f.layer));
});

it.effect("a branch moved at the network boundary cannot change the pushed SHA", () => {
  const f = fixture();
  const layer = Repo.layer({
    ...f.hooks,
    publication: {
      tip: (_cwd, _url, branch) => repository(f.bare).tip(branch),
      fetch: (cwd, _url, branch) => repository(cwd).fetch(f.bare, branch),
      push: Effect.fnUntraced(function* (cwd, _url, branch, sha) {
        gitSync(cwd, "commit", "--allow-empty", "-m", "external process moved branch");
        return yield* repository(cwd).push(f.bare, branch, sha);
      }),
    },
  }).pipe(Layer.provide(Layer.merge(NodeServices.layer, Layer.succeed(ServerConfig, testConfig()))));
  return Effect.gen(function* () {
    yield* (yield* Repo).submitBranch(f.req);
    expect(gitSync(f.bare, "rev-parse", f.req.branch)).toBe(f.req.sha);
    expect(gitSync(f.cwd, "rev-parse", "HEAD")).not.toBe(f.req.sha);
  }).pipe(Effect.provide(layer));
});

it.effect("worktrees list their branch and safe removal preserves dirty files and the original checkout", () => {
  const f = fixture();
  const other = join(f.cwd, "..", "other");
  return Effect.gen(function* () {
    const r = repository(f.cwd);
    yield* r.addWorktree(other, "feat/other", f.req.sha);
    const worktrees2 = yield* r.worktrees;
    expect(worktrees2).toContain("branch refs/heads/feat/other\0");
    write(join(other, "keep"), "uncommitted");
    const worktreeRemoved = yield* r.removeWorktree(other, false);
    expect(worktreeRemoved).not.toBe("");
    expect(readFileSync(join(other, "keep"), "utf8")).toBe("uncommitted");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(join(other, "keep"));
    const worktreeRemoved2 = yield* r.removeWorktree(other, false);
    expect(worktreeRemoved2).toBe("");
    expect(existsSync(f.cwd)).toBe(true);
    const head2 = yield* r.head;
    expect(head2).toBe(f.req.sha);
  }).pipe(Effect.provide(NodeServices.layer));
});

it.effect("conflicting base changes are refused before running a check or pushing", () => {
  const f = fixture();
  gitSync(f.cwd, "checkout", "main");
  write(join(f.cwd, ".vibevalley"), "base owns this path");
  gitSync(f.cwd, "add", ".vibevalley");
  gitSync(f.cwd, "commit", "-m", "base change");
  gitSync(f.cwd, "push", f.bare, "main");
  gitSync(f.cwd, "checkout", "feat/publish");
  return Effect.gen(function* () {
    const error = yield* Effect.flip((yield* Repo).submitBranch(f.req));
    expect(error).toMatchObject({ _tag: "MergeFailure", kind: "conflict" });
    expect(f.pushed).toEqual([]);
    expect(gitSync(f.cwd, "status", "--porcelain")).toBe("");
  }).pipe(Effect.provide(f.layer));
});

it.effect("a failed push is reported separately from a failed PR creation", () => {
  const f = fixture();
  const layer = Repo.layer({
    ...f.hooks,
    publication: {
      tip: (_cwd, _url, branch) => repository(f.bare).tip(branch),
      fetch: (cwd, _url, branch) => repository(cwd).fetch(f.bare, branch),
      push: () => Effect.fail(GitError.of(1, "transport closed")),
    },
  }).pipe(Layer.provide(Layer.merge(NodeServices.layer, Layer.succeed(ServerConfig, testConfig()))));
  return Effect.gen(function* () {
    const error = yield* Effect.flip((yield* Repo).submitBranch(f.req));
    expect(error.message).toContain(f.req.sha);
    expect(error.message).toContain("推送未确认成功");
    expect(f.calls.some((args) => args[0] === "pr")).toBe(false);
    expect(existsSync(f.cwd)).toBe(true);
  }).pipe(Effect.provide(layer));
});
