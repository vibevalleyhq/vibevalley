import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type { Issue } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import type { ServerConfig } from "#/infra/config.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { gitSync, reposDir, repo, write } from "#/testing/git.ts";
import { testConfig } from "#/testing/layers.ts";

import { GitError, run } from "./git.ts";
import { actionsJobOf } from "./pullSnapshot.ts";
import { githubOrigin, type GitHubRun, makeRepo, probeGitHub, type Repo, type RepoHooks } from "./repo.ts";
import { repository } from "./repository.ts";

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

/** What work threw; it failing to throw fails the test. */
const thrown = (work: Promise<unknown>): Promise<Error> =>
  work.then(
    () => expect.unreachable("it went through"),
    (e: unknown) => (e instanceof Error ? e : expect.unreachable(String(e))),
  );

const loggedIn = (permission: () => string) =>
  gh((args) => {
    if (args[0] === "--version") return { out: "gh version 2.80.0" };
    if (args[0] === "auth") return { out: "Logged in to github.com account gardener (keyring)\n- Active account: true" };
    return { out: `{"viewerPermission":"${permission()}"}` };
  });

describe("GitHub", () => {
  test("finds the Actions job in a check's URL, and none elsewhere", () => {
    expect(actionsJobOf("https://github.com/o/r/actions/runs/1/job/127709499860")).toBe("127709499860");
    expect(actionsJobOf("https://example.test/checks/1")).toBe("");
  });

  test("regression: GitHub snapshots read all collection pages and overflowing review threads", () => {
    const root = reposDir();
    const resolved: string[] = [];
    let failReviews = false;
    const author = (login: string) => ({ login, __typename: login.endsWith("[bot]") ? "Bot" : "User" });
    const inline = Array.from({ length: 101 }, (_, i) => ({
      id: `I${i}`,
      fullDatabaseId: String(2_147_483_657 + i),
      author: author("bob"),
      body: `inline ${i}`,
      url: `https://comments/${i}`,
      createdAt: "2026-11-01T00:02:00Z",
      path: "src/a.ts",
      line: i + 1,
      originalLine: i + 1,
      diffHunk: "@@\n-old\n+new",
      pullRequestReview: { id: "R1" },
    }));
    const pull = (key: string, nodes: unknown[]) => ({ data: { repository: { pullRequest: { [key]: { nodes } } } } });
    repo(join(root, "sample"), 1, 0);
    gitSync(join(root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
    return repos(
      root,
      async (repo) => {
        const snapshot = await repo.githubSnapshot("sample", 7);
        expect(snapshot.viewer).toBe("gardener");
        expect(snapshot.checks).toEqual([
          { name: "test", status: "COMPLETED", conclusion: "FAILURE", url: "https://checks/1" },
          { name: "legacy", status: "SUCCESS", conclusion: "", url: "https://checks/2" },
        ]);
        expect(snapshot.reviews.map((review) => review.id)).toEqual(["R1", "R2"]);
        expect(snapshot.comments).toHaveLength(104);
        expect(snapshot.comments.find((comment) => comment.id === "I100")).toMatchObject({
          databaseId: "2147483757",
          line: 101,
          threadId: "PRRT_9",
          reviewId: "R1",
          diffHunk: "@@\n-old\n+new",
        });
        expect(snapshot.comments.find((comment) => comment.id === "SECOND")).toMatchObject({ threadId: "PRRT_second", resolved: true });
        failReviews = true;
        expect((await thrown(repo.githubSnapshot("sample", 7))).name).toBe("RepoError");
        await repo.resolveReviewThread("sample", "PRRT_9");
        expect(resolved).toEqual(["PRRT_9"]);
      },
      {},
      {
        gh: gh((args) => {
          if (args[0] === "pr") return { out: JSON.stringify({ headRefOid: "abc" }) };
          if (args[1] === "user") return { out: JSON.stringify({ login: "gardener" }) };
          const thread = args.find((arg) => arg.startsWith("thread="))?.slice(7);
          if (thread) {
            resolved.push(thread);
            return { out: JSON.stringify({ data: { resolveReviewThread: { thread: { id: thread, isResolved: true } } } }) };
          }
          expect(args).toContain("--paginate");
          expect(args).toContain("--slurp");
          const query = args.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
          expect(query).not.toContain("databaseId");
          if (query.startsWith("query PullChecks("))
            return {
              out: JSON.stringify([
                {
                  data: {
                    repository: {
                      object: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://checks/1" }],
                          },
                        },
                      },
                    },
                  },
                },
                {
                  data: {
                    repository: {
                      object: {
                        statusCheckRollup: {
                          contexts: { nodes: [{ __typename: "StatusContext", context: "legacy", state: "SUCCESS", targetUrl: "https://checks/2" }] },
                        },
                      },
                    },
                  },
                },
              ]),
            };
          if (query.startsWith("query PullReviews("))
            return failReviews
              ? { out: "not available", ok: false }
              : {
                  out: JSON.stringify(
                    [1, 2].map((i) =>
                      pull("reviews", [
                        {
                          id: `R${i}`,
                          author: author("review-bot[bot]"),
                          state: "CHANGES_REQUESTED",
                          body: "fix it",
                          submittedAt: "2026-11-01T00:00:00Z",
                        },
                      ]),
                    ),
                  ),
                };
          if (query.startsWith("query PullComments("))
            return {
              out: JSON.stringify(
                [1, 2].map((i) =>
                  pull("comments", [
                    {
                      id: `C${i}`,
                      author: author("alice"),
                      body: "general",
                      url: `https://comments/${i}`,
                      createdAt: "2026-11-01T00:01:00Z",
                    },
                  ]),
                ),
              ),
            };
          if (query.startsWith("query PullThreads("))
            return {
              out: JSON.stringify([
                pull("reviewThreads", [
                  {
                    id: "PRRT_9",
                    isResolved: false,
                    comments: { totalCount: 101, edges: inline.slice(0, 100).map((node, i) => ({ cursor: `edge${i}`, node })) },
                  },
                ]),
                pull("reviewThreads", [
                  { id: "PRRT_second", isResolved: true, comments: { totalCount: 1, edges: [{ cursor: "last", node: { ...inline[0], id: "SECOND" } }] } },
                ]),
              ]),
            };
          expect(query.startsWith("query PullThreadComments(")).toBe(true);
          expect(args).toContain("id=PRRT_9");
          expect(args).toContain("endCursor=edge99");
          return { out: JSON.stringify([{ data: { node: { comments: { nodes: [inline[100]] } } } }]) };
        }),
      },
    );
  });

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

  test("a pull request: the check first, then the push, and one already open is found again", () => {
    let pushes = 0;
    let calls = 0;
    let pushFails = true;
    const issue = { number: 1, title: "sample" } as Issue;
    return repos(
      reposDir(),
      async (p) => {
        const place = await p.checkout({ repo: "sample", issue: 1, worktree: true, base: "" });
        gitSync(join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
        mkdirSync(join(place.cwd, ".vibevalley"));
        const check = join(place.cwd, ".vibevalley/check");
        write(check, "#!/bin/sh\necho check-failed\nexit 1\n", 0o755);
        gitSync(place.cwd, "add", ".vibevalley/check");
        gitSync(place.cwd, "commit", "-qm", "check");
        await thrown(p.submitPullRequest(place, issue, "done"));
        expect([pushes, calls]).toEqual([0, 0]);
        write(check, "#!/bin/sh\nprintf changed > generated.ts\nexit 0\n", 0o755);
        gitSync(place.cwd, "commit", "-qam", "check again");
        await thrown(p.submitPullRequest(place, issue, "done"));
        expect([pushes, calls]).toEqual([0, 0]);
        write(check, "#!/bin/sh\nexit 0\n", 0o755);
        gitSync(place.cwd, "commit", "-qam", "passing check");
        await thrown(p.submitPullRequest(place, issue, "done"));
        expect(calls).toBe(0);
        gitSync(place.cwd, "clean", "-fd");
        pushFails = false;
        expect((await p.submitPullRequest(place, issue, "done")).number).toBe(4);
        expect(calls).toBe(1);
      },
      {},
      {
        publication: {
          tip: (cwd) => repository(cwd).tip("main"),
          fetch: () => Promise.resolve(),
          push: () => {
            pushes++;
            return pushFails ? Promise.reject(GitError.of(1, "push refused")) : Promise.resolve();
          },
        },
        gh: gh((args) => {
          calls++;
          expect(args.slice(0, 2)).toEqual(["pr", "list"]);
          return { out: `[{"url":"https://github.com/test/sample/pull/4","number":4,"isCrossRepository":false,"state":"OPEN"}]` };
        }),
      },
    );
  });

  test("an answer from gh that is not the shape asked for is refused, not taken as a pull request", () => {
    const issue = { number: 1, title: "sample" } as Issue;
    return repos(
      reposDir(),
      async (p) => {
        const place = await p.checkout({ repo: "sample", issue: 1, worktree: true, base: "" });
        gitSync(join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
        expect((await thrown(p.submitPullRequest(place, issue, "done"))).message).toContain("已推送");
        expect((await thrown(p.pullRequestState("sample", 3))).message).toBe("无法读取 PR #3 状态");
      },
      {},
      {
        publication: { tip: (cwd) => repository(cwd).tip("main"), fetch: () => Promise.resolve(), push: () => Promise.resolve() },
        gh: gh((args) => ({ out: args[1] === "list" ? `[{"html_url":"https://github.com/test/sample/pull/4"}]` : "null" })),
      },
    );
  });

  test("the pull request's body says whether the check ran", async () => {
    for (const hasCheck of [false, true]) {
      let body = "";
      await repos(
        reposDir(),
        async (p) => {
          const place = await p.checkout({ repo: "sample", issue: 1, worktree: true, base: "" });
          gitSync(join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
          if (hasCheck) {
            mkdirSync(join(place.cwd, ".vibevalley"));
            write(join(place.cwd, ".vibevalley/check"), "#!/bin/sh\nexit 0\n", 0o755);
            gitSync(place.cwd, "add", ".vibevalley/check");
            gitSync(place.cwd, "commit", "-qm", "check");
          }
          await p.submitPullRequest(place, { number: 1, title: "sample" } as Issue, "done");
          expect(body).toBe("工单 #1\n\ndone\n\n" + (hasCheck ? ".vibevalley/check 通过。" : "这个仓库没有 .vibevalley/check，没跑检查。"));
        },
        {},
        {
          publication: { tip: (cwd) => repository(cwd).tip("main"), fetch: () => Promise.resolve(), push: () => Promise.resolve() },
          gh: gh((args) => {
            if (args[1] === "list") return { out: "[]" };
            body = args.at(-1)!;
            return { out: "https://github.com/test/sample/pull/1" };
          }),
        },
      );
    }
  });

  test("the helper's own title and body, left in the worktree's git directory, open the pull request", () => {
    let args: string[] = [];
    return repos(
      reposDir(),
      async (p) => {
        const place = await p.checkout({ repo: "sample", issue: 1, worktree: true, base: "" });
        gitSync(join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
        const file = gitSync(place.cwd, "rev-parse", "--path-format=absolute", "--git-path", "vibevalley-pr.md").trim();
        writeFileSync(file, "# The board keeps its order\n\n## What changed\n\nIt does.\n");
        await p.submitPullRequest(place, { number: 1, title: "看板不乱了" } as Issue, "done");
        expect(args.slice(args.indexOf("--title"))).toEqual(["--title", "The board keeps its order", "--body", "## What changed\n\nIt does."]);
        // Not committed: the tree is clean.
        expect(gitSync(place.cwd, "status", "--porcelain").trim()).toBe("");
      },
      {},
      {
        publication: { tip: (cwd) => repository(cwd).tip("main"), fetch: () => Promise.resolve(), push: () => Promise.resolve() },
        gh: gh((given) => {
          if (given[1] === "list") return { out: "[]" };
          args = given;
          return { out: "https://github.com/test/sample/pull/1" };
        }),
      },
    );
  });

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
