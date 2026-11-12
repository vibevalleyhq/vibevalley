import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";
import { waitFor } from "@vibevalley/testkit/until";

import type { ServerConfig } from "#/infra/config.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { gitSync, repo, write } from "#/testing/git.ts";
import { testConfig } from "#/testing/layers.ts";

import { GitError, run } from "./git.ts";
import { type GitHubRun } from "./github.ts";
import { hostedOrigin } from "./hosting.ts";
import { makeRepo, type RepoHooks } from "./repo.ts";
import { repository } from "./repository.ts";

const fmt = (v: unknown) => JSON.stringify(v, null, 2);

/** The repos of a farm with this config, as a test makes them. */
const repos = (hooks: RepoHooks, config: ServerConfig = testConfig()) => makeRepo({ config, clock: wallTime, log: keptLog() }, hooks);

function fixture(platform: T.BranchPublication["platform"] = "github", script = "#!/bin/sh\nexit 0\n", existing = false) {
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
    Promise.resolve().then(() => {
      calls.push(args);
      if (args[0] === "auth") return { ok: true, missing: false, out: "" };
      if (args.includes("defaultBranchRef")) return { ok: true, missing: false, out: fmt({ defaultBranchRef: { name: "main" } }) };
      if (args[1] === "projects/team%2Frepo") return { ok: true, missing: false, out: fmt({ default_branch: "main" }) };
      const item =
        platform === "github"
          ? { number: 7, url, isCrossRepository: false, state: "OPEN" }
          : { iid: 7, web_url: url, source_project_id: 1, target_project_id: 1, state: "opened" };
      if (args[1] === "list" || args[1]?.includes("?state=opened") === true) return { ok: true, missing: false, out: fmt(created ? [item] : []) };
      created = true;
      return { ok: true, missing: false, out: platform === "github" ? url : fmt(item) };
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
  const made = () => repos(hooks, testConfig({ workRoot: join(dir, "space") }));
  return { cwd, bare, req, calls, url, pushed, hooks, made };
}

for (const platform of ["github", "gitlab"] as const) {
  for (const existing of [false, true]) {
    test(`${platform} publishes the checked SHA and ${existing ? "reuses" : "creates"} an open request`, async () => {
      const f = fixture(platform, "#!/bin/sh\nexit 0\n", existing);
      {
        const result = await (await f.made()).submitBranch(f.req);
        expect(result).toMatchObject({ url: f.url, check: "passed", pushed: true, reused: existing });
        expect(f.pushed).toEqual([[`https://${platform}.com/team/repo.git`, f.req.branch, f.req.sha]]);
        expect(gitSync(f.bare, "rev-parse", f.req.branch)).toBe(f.req.sha);
        expect(gitSync(f.cwd, "status", "--porcelain")).toBe("");
      }
    });
  }
}

test("preview does not run the check or contact the Git network", async () => {
  const f = fixture("github", "#!/bin/sh\nexit 1\n");
  {
    const branchSubmitted = await (await f.made()).submitBranch({ ...f.req, dryRun: true });
    expect(branchSubmitted).toMatchObject({ pushed: false, check: "preview" });
    expect(f.pushed).toEqual([]);
    expect(f.calls.map((args) => args[0])).toEqual(["auth", "repo"]);
  }
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
  test(`publication refuses ${scenario} without pushing or removing the checkout`, async () => {
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

    {
      const e = await (await f.made()).submitBranch(req).catch((e: unknown) => e);
      expect(e).toBeInstanceOf(Error);
      expect(f.pushed).toEqual([]);
      expect(existsSync(f.cwd)).toBe(true);
      expect(gitSync(f.bare, "branch", "--list", f.req.branch)).toBe("");
    }
  });
}

for (const stage of ["missing", "auth", "decode", "create"] as const) {
  test(`platform ${stage} failures report whether pushing happened`, async () => {
    const f = fixture("gitlab");
    const original = f.hooks.glab ?? (() => Promise.resolve({ ok: false, missing: true, out: "" }));
    const glab: GitHubRun = (...args) =>
      stage === "create" && !args.includes("POST")
        ? original(...args)
        : Promise.resolve({ ok: stage === "decode", missing: stage === "missing", out: "untrusted token must stay private" });
    {
      const error = await (await repos({ ...f.hooks, glab })).submitBranch(f.req).then(
        () => expect.unreachable("published"),
        (e: unknown) => (e instanceof Error ? e : expect.unreachable(String(e))),
      );
      expect(error.message).not.toContain("untrusted token");
      expect(f.pushed.length).toBe(stage === "create" ? 1 : 0);
      if (stage === "create") expect(error.message).toContain("已推送");
    }
  });
}

test("only known hosting domains are recognized", () => {
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

test("canceling a running check kills its process and retains the checkout", async () => {
  const f = fixture("github", "#!/bin/sh\necho $$ > ../check.pid\nexec sleep 60\n");
  const pidFile = join(f.cwd, "..", "check.pid");
  {
    const service = await f.made();
    const cancel = new AbortController();
    const submitting = service.submitBranch(f.req, cancel.signal).catch((e: unknown) => e);
    await waitFor(() => existsSync(pidFile), Boolean, "check started");
    const pid = readFileSync(pidFile, "utf8").trim();
    cancel.abort();
    await submitting;
    await waitFor(
      () => run("kill", ["-0", pid]),
      (r) => r.code !== 0,
      "check stopped",
    );
    expect(f.pushed).toEqual([]);
    expect(existsSync(f.cwd)).toBe(true);
    expect(gitSync(f.cwd, "rev-parse", "HEAD")).toBe(f.req.sha);
  }
});

test("a missing check is reported as not-run", async () => {
  const f = fixture();
  gitSync(f.cwd, "rm", ".vibevalley/check");
  gitSync(f.cwd, "commit", "-m", "no check");
  {
    const result = await (await f.made()).submitBranch({ ...f.req, sha: gitSync(f.cwd, "rev-parse", "HEAD") });
    expect(result.check).toBe("not-run");
    expect(result.url).toBe(f.url);
  }
});

test("a branch moved at the network boundary cannot change the pushed SHA", async () => {
  const f = fixture();
  const made = await repos({
    ...f.hooks,
    publication: {
      tip: (_cwd, _url, branch) => repository(f.bare).tip(branch),
      fetch: (cwd, _url, branch) => repository(cwd).fetch(f.bare, branch),
      push: (cwd, _url, branch, sha) => {
        gitSync(cwd, "commit", "--allow-empty", "-m", "external process moved branch");
        return repository(cwd).push(f.bare, branch, sha);
      },
    },
  });
  {
    await made.submitBranch(f.req);
    expect(gitSync(f.bare, "rev-parse", f.req.branch)).toBe(f.req.sha);
    expect(gitSync(f.cwd, "rev-parse", "HEAD")).not.toBe(f.req.sha);
  }
});

test("worktrees list their branch and safe removal preserves dirty files and the original checkout", async () => {
  const f = fixture();
  const other = join(f.cwd, "..", "other");
  {
    const r = repository(f.cwd);
    await r.addWorktree(other, "feat/other", f.req.sha);
    const worktrees2 = await r.worktrees();
    expect(worktrees2).toContain("branch refs/heads/feat/other\0");
    write(join(other, "keep"), "uncommitted");
    const worktreeRemoved = await r.removeWorktree(other, false);
    expect(worktreeRemoved).not.toBe("");
    expect(readFileSync(join(other, "keep"), "utf8")).toBe("uncommitted");
    await rm(join(other, "keep"));
    const worktreeRemoved2 = await r.removeWorktree(other, false);
    expect(worktreeRemoved2).toBe("");
    expect(existsSync(f.cwd)).toBe(true);
    const head2 = await r.head();
    expect(head2).toBe(f.req.sha);
  }
});

test("conflicting base changes are refused before running a check or pushing", async () => {
  const f = fixture();
  gitSync(f.cwd, "checkout", "main");
  write(join(f.cwd, ".vibevalley"), "base owns this path");
  gitSync(f.cwd, "add", ".vibevalley");
  gitSync(f.cwd, "commit", "-m", "base change");
  gitSync(f.cwd, "push", f.bare, "main");
  gitSync(f.cwd, "checkout", "feat/publish");
  {
    const error = await (await f.made()).submitBranch(f.req).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "MergeFailure", kind: "conflict" });
    expect(f.pushed).toEqual([]);
    expect(gitSync(f.cwd, "status", "--porcelain")).toBe("");
  }
});

test("a failed push is reported separately from a failed PR creation", async () => {
  const f = fixture();
  const made = await repos({
    ...f.hooks,
    publication: {
      tip: (_cwd, _url, branch) => repository(f.bare).tip(branch),
      fetch: (cwd, _url, branch) => repository(cwd).fetch(f.bare, branch),
      push: () => Promise.reject(GitError.of(1, "transport closed")),
    },
  });
  {
    const error = await made.submitBranch(f.req).then(
      () => expect.unreachable("pushed"),
      (e: unknown) => (e instanceof Error ? e : expect.unreachable(String(e))),
    );
    expect(error.message).toContain(f.req.sha);
    expect(error.message).toContain("推送未确认成功");
    expect(f.calls.some((args) => args[0] === "pr")).toBe(false);
    expect(existsSync(f.cwd)).toBe(true);
  }
});
