import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import type { ServerConfig } from "#/infra/config.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { gitSync, reposDir, repo } from "#/testing/git.ts";
import { testConfig } from "#/testing/layers.ts";

import { run } from "./git.ts";
import { githubOrigin, type GitHubRun, makeRepo, probeGitHub, type Repo, type RepoHooks } from "./repo.ts";

const noGitHub: GitHubRun = () => Promise.resolve({ out: "", ok: false, missing: true });
const gh =
  (answer: (args: string[]) => { out: string; ok?: boolean; missing?: boolean }): GitHubRun =>
  (...args) =>
    Promise.resolve().then(() => ({
      ok: true,
      missing: false,
      ...(args.includes("defaultBranchRef")
        ? { out: '{"defaultBranchRef":{"name":"main"}}' }
        : args[0] === "auth" && args.length === 4
          ? { out: "logged in" }
          : answer(args)),
    }));

const repos = async <A>(root: string, body: (p: Repo) => Promise<A>, change: Partial<ServerConfig> = {}, hooks: RepoHooks = {}): Promise<A> => {
  const p = await makeRepo(
    { config: testConfig({ workRoot: dirname(root), ...change }), clock: wallTime, log: keptLog() },
    { gh: noGitHub, command: (file, args, options) => run("sh", [file, ...args], options), ...hooks },
  );
  try {
    return await body(p);
  } finally {
    await p.close();
  }
};

const loggedIn = (permission: () => string) =>
  gh((args) => {
    if (args[0] === "--version") return { out: "gh version 2.80.0" };
    if (args[0] === "auth") return { out: "Logged in to github.com account gardener (keyring)\n- Active account: true" };
    return { out: `{"viewerPermission":"${permission()}"}` };
  });

describe("GitHub", () => {
  test("the probe says whether gh is there and logged in, and never what it printed", async () => {
    for (const [name, version, auth, want] of [
      ["missing", { out: "", ok: false, missing: true }, { out: "" }, { installed: false, loggedIn: false, reason: "没装 gh" }],
      ["logged out", { out: "gh version 2.80.0 (2025-09-01)\n" }, { out: "secret", ok: false }, { installed: true, loggedIn: false, reason: "没登录 GitHub" }],
      [
        "logged in",
        { out: "gh version 2.80.0 (2025-09-01)\n" },
        {
          out: "github.com\n  ✓ Logged in to github.com account gardener (keyring)\n  - Active account: true\n  - Token: secret",
        },
        { installed: true, loggedIn: true, account: "gardener" },
      ],
    ] as const) {
      const got = await probeGitHub(
        gh((args) => (args[0] === "--version" ? version : auth)),
        wallTime,
      );
      expect(got, name).toMatchObject(want);
      const shown = JSON.stringify(got);
      expect(shown).not.toContain("secret");
    }
  });

  test("origins", () => {
    for (const s of ["git@github.com:user/repo.git", "ssh://git@github.com/user/repo.git", "https://github.com/user/repo.git"])
      expect(githubOrigin(s)).toBe("user/repo");
    for (const s of ["https://github.com.evil/o/r", "https://token@github.com/o/r", "/tmp/repo", "https://github.com/o/r/issues"])
      expect(githubOrigin(s)).toBe("");
  });

  test("permissions are found on a refresh and kept: a summary questions gh nothing", () => {
    let permission = "WRITE";
    let calls = 0;
    const counted: GitHubRun = async (...args) => {
      const r = await loggedIn(() => permission)(...args);
      calls++;
      return r;
    };
    return repos(
      reposDir(),
      async (p) => {
        const made = await p.create({ name: "garden" });
        gitSync(made.path, "remote", "add", "origin", "git@github.com:user/repo.git");
        for (const perm of ["WRITE", "ADMIN", "MAINTAIN", "READ", "TRIAGE"]) {
          permission = perm;
          await p.refreshGitHub();
          const before = calls;
          const want = ["WRITE", "ADMIN", "MAINTAIN"].includes(perm);
          expect((await p.summary(made)).pullRequest).toEqual(want ? { available: true, reason: "" } : { available: false, reason: "没有写权限" });
          expect(calls).toBe(before);
        }
        gitSync(made.path, "remote", "set-url", "origin", "https://gitlab.com/user/repo");
        await p.refreshGitHub();
        expect((await p.summary(made)).pullRequest).toEqual({
          available: false,
          reason: "不是 GitHub 仓库",
        });
      },
      {},
      { gh: counted },
    );
  });

  test("logged out or gone, the permissions are dropped", () => {
    let mode = "logged in";
    const changing: GitHubRun = (...args) =>
      mode === "missing"
        ? Promise.resolve({ out: "", ok: false, missing: true })
        : mode === "logged out" && args[0] !== "--version"
          ? Promise.resolve({ out: "token: secret", ok: false, missing: false })
          : loggedIn(() => "WRITE")(...args);
    return repos(
      reposDir(),
      async (p) => {
        const made = await p.create({ name: "garden" });
        gitSync(made.path, "remote", "add", "origin", "https://github.com/user/repo.git");
        await p.refreshGitHub();
        expect((await p.summary(made)).pullRequest.available).toBe(true);
        for (const [m, reason] of [
          ["logged out", "没登录 GitHub"],
          ["missing", "没装 gh"],
        ] as const) {
          mode = m;
          const status = await p.refreshGitHub();
          expect(status.reason).toBe(reason);
          expect((await p.summary(made)).pullRequest).toEqual({ available: false, reason });
        }
      },
      {},
      { gh: changing },
    );
  });

  test("a private repository is cloned by the logged-in gh", () => {
    const root = reposDir();
    const cloning = gh((args) => {
      if (args[0] === "--version") return { out: "gh version 2.80.0" };
      if (args[0] === "auth") return { out: "Logged in to github.com account gardener (keyring)" };
      expect(args.slice(0, 3)).toEqual(["repo", "clone", "user/private"]);
      gitSync(root, "init", "-q", "-b", "main", args[3]!);
      return { out: "" };
    });
    return repos(
      root,
      async (p) => {
        expect(
          (
            await p.create({
              name: "private",
              github: "https://github.com/user/private",
            })
          ).git,
        ).toBe(true);
      },
      {},
      { gh: cloning },
    );
  });

  test("pull requests need the repo opted in and the permission", () =>
    repos(
      reposDir(),
      async (p) => {
        for (const name of ["enabled", "other"]) {
          const made = await p.create({ name });
          gitSync(made.path, "remote", "add", "origin", `https://github.com/user/${name}.git`);
        }
        expect(p.usesPullRequests("enabled")).toBe(false);
        await p.refreshGitHub();
        expect(p.usesPullRequests("enabled")).toBe(true);
        expect(p.usesPullRequests("other")).toBe(false);
      },
      { github: { prRepos: ["enabled"], prPollSeconds: 180 } },
      { gh: loggedIn(() => "WRITE") },
    ));

  test("a new issue starts from origin's main when it can be fast-forwarded to", async () => {
    for (const mode of ["checked-out", "other-branch", "dirty", "diverged", "fetch-failure", "not-enabled"]) {
      const root = reposDir();
      const hooks: RepoHooks = {
        gh: loggedIn(() => (mode === "not-enabled" ? "READ" : "WRITE")),
      };
      let failFetch = false;
      let originPath = "";
      await repos(
        root,
        async (p) => {
          await p.create({ name: "sample" });
          const path = join(root, "sample");
          const origin = join(tempDir("vibevalley-origin-"), "origin.git");
          gitSync(path, "clone", "-q", "--bare", path, origin);
          // gh sees a GitHub repository; git fetches the local one.
          gitSync(path, "remote", "add", "origin", "https://github.com/test/sample.git");
          gitSync(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
          originPath = origin;
          await p.refreshGitHub();
          const old = gitSync(path, "rev-parse", "main");
          const remote = join(tempDir("vibevalley-remote-"), "remote");
          gitSync(path, "clone", "-q", origin, remote);
          gitSync(remote, "commit", "--allow-empty", "-m", "remote change");
          gitSync(remote, "push", "-q", "origin", "main");
          let want = gitSync(remote, "rev-parse", "HEAD");
          if (mode === "other-branch") gitSync(path, "checkout", "-q", "-b", "personal");
          if (mode === "dirty") {
            writeFileSync(join(path, "dirty"), "keep");
            want = old;
          }
          if (mode === "diverged") {
            gitSync(path, "commit", "--allow-empty", "-m", "local change");
            want = gitSync(path, "rev-parse", "HEAD");
          }
          if (mode === "fetch-failure") {
            failFetch = true;
            want = old;
          }
          if (mode === "not-enabled") want = old;
          const place = await p.checkout({ repo: "sample", issue: 1, worktree: true, base: "" });
          expect([mode, gitSync(place.cwd, "rev-parse", "HEAD")]).toEqual([mode, want]);
          expect([mode, gitSync(path, "rev-parse", "main")]).toEqual([mode, want]);
          if (mode === "checked-out") {
            gitSync(remote, "commit", "--allow-empty", "-m", "merged PR");
            gitSync(remote, "push", "-q", "origin", "main");
            await p.finishPullRequest("sample", 1);
            expect(gitSync(path, "rev-parse", "main")).toBe(gitSync(remote, "rev-parse", "HEAD"));
          }
        },
        { github: { prRepos: ["sample"], prPollSeconds: 180 } },
        {
          ...hooks,
          fetch: (cwd, branch) =>
            failFetch
              ? Promise.resolve(false)
              : Promise.resolve().then(() => {
                  gitSync(cwd, "fetch", "-q", originPath, branch);
                  return true;
                }),
        },
      );
    }
  });

  test("contributions count once per repository, its worktrees too", () => {
    const root = reposDir();
    const nested = join(root, "nested", "repo");
    repo(nested, 2, 1);
    gitSync(nested, "worktree", "add", "-q", "-b", "side", join(dirname(root), "worktrees", "copy"));
    return repos(root, async (p) => {
      const repos = await p.contributions([]);
      expect(repos.map((r) => r.commits)).toEqual([2]);
    });
  });
});
