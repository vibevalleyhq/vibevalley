import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { Issue } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import { ServerConfig } from "@/base/config.ts";
import { gitSync, projectsDir, repo, write } from "@/testing/git.ts";
import { testConfig } from "@/testing/layers.ts";

import { Project, githubOrigin, type GitHubRun, probeGitHub, type ProjectHooks } from "./project.ts";

const noGitHub: GitHubRun = () => Effect.succeed({ out: "", ok: false, missing: true });
const gh =
  (answer: (args: string[]) => { out: string; ok?: boolean; missing?: boolean }): GitHubRun =>
  (...args) =>
    Effect.sync(() => ({ ok: true, missing: false, ...answer(args) }));

const projects = <A, E>(root: string, body: Effect.Effect<A, E, Project>, change: Partial<ServerConfig["Service"]> = {}, hooks: ProjectHooks = {}) =>
  body.pipe(
    Effect.provide(
      Project.layer({ gh: noGitHub, ...hooks }).pipe(
        Layer.provide(Layer.merge(Layer.succeed(ServerConfig, testConfig({ workRoot: dirname(root), ...change })), NodeServices.layer)),
      ),
    ),
  );

const loggedIn = (permission: () => string) =>
  gh((args) => {
    if (args[0] === "--version") return { out: "gh version 2.80.0" };
    if (args[0] === "auth") return { out: "Logged in to github.com account gardener (keyring)\n- Active account: true" };
    return { out: `{"viewerPermission":"${permission()}"}` };
  });

describe("GitHub", () => {
  it.effect("the probe says whether gh is there and logged in, and never what it printed", () =>
    Effect.gen(function* () {
      for (const [name, version, auth, want] of [
        ["missing", { out: "", ok: false, missing: true }, { out: "" }, { installed: false, loggedIn: false, reason: "没装 gh" }],
        [
          "logged out",
          { out: "gh version 2.80.0 (2025-09-01)\n" },
          { out: "secret", ok: false },
          { installed: true, loggedIn: false, reason: "没登录 GitHub" },
        ],
        [
          "logged in",
          { out: "gh version 2.80.0 (2025-09-01)\n" },
          {
            out: "github.com\n  ✓ Logged in to github.com account gardener (keyring)\n  - Active account: true\n  - Token: secret",
          },
          { installed: true, loggedIn: true, account: "gardener" },
        ],
      ] as const) {
        const got = yield* probeGitHub(gh((args) => (args[0] === "--version" ? version : auth)));
        expect(got, name).toMatchObject(want);
        expect(JSON.stringify(got)).not.toContain("secret");
      }
    }),
  );

  it("origins", () => {
    for (const s of ["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo.git"])
      expect(githubOrigin(s)).toBe("owner/repo");
    for (const s of ["https://github.com.evil/o/r", "https://token@github.com/o/r", "/tmp/repo", "https://github.com/o/r/issues"])
      expect(githubOrigin(s)).toBe("");
  });

  it.effect("permissions are found on a refresh and kept: a summary questions gh nothing", () => {
    let permission = "WRITE";
    let calls = 0;
    const counted: GitHubRun = (...args) => Effect.tap(loggedIn(() => permission)(...args), () => Effect.sync(() => calls++));
    return projects(
      projectsDir(),
      Effect.gen(function* () {
        const p = yield* Project;
        const made = yield* p.create({ name: "garden" });
        gitSync(made.path, "remote", "add", "origin", "git@github.com:owner/repo.git");
        for (const perm of ["WRITE", "ADMIN", "MAINTAIN", "READ", "TRIAGE"]) {
          permission = perm;
          yield* p.refreshGitHub();
          const before = calls;
          const want = ["WRITE", "ADMIN", "MAINTAIN"].includes(perm);
          expect((yield* p.summary(made)).pullRequest).toEqual(want ? { available: true, reason: "" } : { available: false, reason: "没有写权限" });
          expect(calls).toBe(before);
        }
        gitSync(made.path, "remote", "set-url", "origin", "https://gitlab.com/owner/repo");
        yield* p.refreshGitHub();
        expect((yield* p.summary(made)).pullRequest).toEqual({
          available: false,
          reason: "不是 GitHub 仓库",
        });
      }),
      {},
      { gh: counted },
    );
  });

  it.effect("logged out or gone, the permissions are dropped", () => {
    let mode = "logged in";
    const changing: GitHubRun = (...args) =>
      mode === "missing"
        ? Effect.succeed({ out: "", ok: false, missing: true })
        : mode === "logged out" && args[0] !== "--version"
          ? Effect.succeed({ out: "token: secret", ok: false, missing: false })
          : loggedIn(() => "WRITE")(...args);
    return projects(
      projectsDir(),
      Effect.gen(function* () {
        const p = yield* Project;
        const made = yield* p.create({ name: "garden" });
        gitSync(made.path, "remote", "add", "origin", "https://github.com/owner/repo.git");
        yield* p.refreshGitHub();
        expect((yield* p.summary(made)).pullRequest.available).toBe(true);
        for (const [m, reason] of [
          ["logged out", "没登录 GitHub"],
          ["missing", "没装 gh"],
        ] as const) {
          mode = m;
          const status = yield* p.refreshGitHub();
          expect(status.reason).toBe(reason);
          expect((yield* p.summary(made)).pullRequest).toEqual({ available: false, reason });
        }
      }),
      {},
      { gh: changing },
    );
  });

  it.effect("a private repository is cloned by the logged-in gh", () => {
    const root = projectsDir();
    const cloning = gh((args) => {
      if (args[0] === "--version") return { out: "gh version 2.80.0" };
      if (args[0] === "auth") return { out: "Logged in to github.com account gardener (keyring)" };
      expect(args.slice(0, 3)).toEqual(["repo", "clone", "owner/private"]);
      gitSync(root, "init", "-q", "-b", "main", args[3]!);
      return { out: "" };
    });
    return projects(
      root,
      Effect.gen(function* () {
        expect(
          (yield* (yield* Project).create({
            name: "private",
            github: "https://github.com/owner/private",
          })).git,
        ).toBe(true);
      }),
      {},
      { gh: cloning },
    );
  });

  it.effect("pull requests need the project opted in and the permission", () =>
    projects(
      projectsDir(),
      Effect.gen(function* () {
        const p = yield* Project;
        for (const name of ["enabled", "other"]) {
          const made = yield* p.create({ name });
          gitSync(made.path, "remote", "add", "origin", `https://github.com/owner/${name}.git`);
        }
        expect(p.usesPullRequests("enabled")).toBe(false);
        yield* p.refreshGitHub();
        expect(p.usesPullRequests("enabled")).toBe(true);
        expect(p.usesPullRequests("other")).toBe(false);
      }),
      { github: { prProjects: ["enabled"], prPollSeconds: 180 } },
      { gh: loggedIn(() => "WRITE") },
    ),
  );

  it.effect("a pull request: the check first, then the push, and one already open is found again", () => {
    let pushes = 0;
    let calls = 0;
    let pushFails = true;
    const issue = { number: 1, title: "sample" } as Issue;
    return projects(
      projectsDir(),
      Effect.gen(function* () {
        const p = yield* Project;
        const place = yield* p.workplace("sample", 1, true, "");
        gitSync(join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
        mkdirSync(join(place.cwd, ".vibevalley"));
        const check = join(place.cwd, ".vibevalley/check");
        write(check, "#!/bin/sh\necho check-failed\nexit 1\n", 0o755);
        yield* Effect.flip(p.submitPullRequest(place, issue, "done"));
        expect([pushes, calls]).toEqual([0, 0]);
        write(check, "#!/bin/sh\nexit 0\n", 0o755);
        yield* Effect.flip(p.submitPullRequest(place, issue, "done"));
        expect(calls).toBe(0);
        pushFails = false;
        expect((yield* p.submitPullRequest(place, issue, "done")).number).toBe(4);
        expect(calls).toBe(1);
      }),
      {},
      {
        push: () => Effect.sync(() => (pushes++, !pushFails)),
        gh: gh((args) => {
          calls++;
          expect(args.slice(0, 2)).toEqual(["pr", "list"]);
          return { out: `[{"url":"https://github.com/test/sample/pull/4","number":4}]` };
        }),
      },
    );
  });

  it.effect("an answer from gh that is not the shape asked for is refused, not taken as a pull request", () => {
    const issue = { number: 1, title: "sample" } as Issue;
    return projects(
      projectsDir(),
      Effect.gen(function* () {
        const p = yield* Project;
        const place = yield* p.workplace("sample", 1, true, "");
        gitSync(join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
        expect((yield* Effect.flip(p.submitPullRequest(place, issue, "done"))).message).toBe("无法读取已有 PR");
        expect((yield* Effect.flip(p.pullRequestState("sample", 3))).message).toBe("无法读取 PR #3 状态");
      }),
      {},
      {
        push: () => Effect.succeed(true),
        gh: gh((args) => ({ out: args[1] === "list" ? `[{"html_url":"https://github.com/test/sample/pull/4"}]` : "null" })),
      },
    );
  });

  it.effect("the pull request's body says whether the check ran", () =>
    Effect.gen(function* () {
      for (const hasCheck of [false, true]) {
        let body = "";
        yield* projects(
          projectsDir(),
          Effect.gen(function* () {
            const p = yield* Project;
            const place = yield* p.workplace("sample", 1, true, "");
            gitSync(join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
            if (hasCheck) {
              mkdirSync(join(place.cwd, ".vibevalley"));
              write(join(place.cwd, ".vibevalley/check"), "#!/bin/sh\nexit 0\n", 0o755);
            }
            yield* p.submitPullRequest(place, { number: 1, title: "sample" } as Issue, "done");
            expect(body).toBe("工单 #1\n\ndone\n\n" + (hasCheck ? ".vibevalley/check 通过。" : "这个项目没有 .vibevalley/check，没跑检查。"));
          }),
          {},
          {
            push: () => Effect.succeed(true),
            gh: gh((args) => {
              if (args[1] === "list") return { out: "[]" };
              body = args.at(-1)!;
              return { out: "https://github.com/test/sample/pull/1" };
            }),
          },
        );
      }
    }),
  );

  it.effect("the helper's own title and body, left in the worktree's git directory, open the pull request", () => {
    let args: string[] = [];
    return projects(
      projectsDir(),
      Effect.gen(function* () {
        const p = yield* Project;
        const place = yield* p.workplace("sample", 1, true, "");
        gitSync(join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
        const file = gitSync(place.cwd, "rev-parse", "--path-format=absolute", "--git-path", "vibevalley-pr.md").trim();
        writeFileSync(file, "# The board keeps its order\n\n## What changed\n\nIt does.\n");
        yield* p.submitPullRequest(place, { number: 1, title: "看板不乱了" } as Issue, "done");
        expect(args.slice(args.indexOf("--title"))).toEqual(["--title", "The board keeps its order", "--body", "## What changed\n\nIt does."]);
        // Not committed: the tree is clean.
        expect(gitSync(place.cwd, "status", "--porcelain").trim()).toBe("");
      }),
      {},
      {
        push: () => Effect.succeed(true),
        gh: gh((given) => {
          if (given[1] === "list") return { out: "[]" };
          args = given;
          return { out: "https://github.com/test/sample/pull/1" };
        }),
      },
    );
  });

  it.effect("a new issue starts from origin's main when it can be fast-forwarded to", () =>
    Effect.gen(function* () {
      for (const mode of ["checked-out", "other-branch", "dirty", "diverged", "fetch-failure", "not-enabled"]) {
        const root = projectsDir();
        const hooks: ProjectHooks = {
          gh: loggedIn(() => (mode === "not-enabled" ? "READ" : "WRITE")),
        };
        let failFetch = false;
        let originPath = "";
        yield* projects(
          root,
          Effect.gen(function* () {
            const p = yield* Project;
            yield* p.create({ name: "sample" });
            const path = join(root, "sample");
            const origin = join(tempDir("vibevalley-origin-"), "origin.git");
            gitSync(path, "clone", "-q", "--bare", path, origin);
            // gh sees a GitHub repository; git fetches the local one.
            gitSync(path, "remote", "add", "origin", "https://github.com/test/sample.git");
            gitSync(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
            originPath = origin;
            yield* p.refreshGitHub();
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
            const place = yield* p.workplace("sample", 1, true, "");
            expect([mode, gitSync(place.cwd, "rev-parse", "HEAD")]).toEqual([mode, want]);
            expect([mode, gitSync(path, "rev-parse", "main")]).toEqual([mode, want]);
            if (mode === "checked-out") {
              gitSync(remote, "commit", "--allow-empty", "-m", "merged PR");
              gitSync(remote, "push", "-q", "origin", "main");
              yield* p.finishPullRequest("sample", 1);
              expect(gitSync(path, "rev-parse", "main")).toBe(gitSync(remote, "rev-parse", "HEAD"));
            }
          }),
          { github: { prProjects: ["sample"], prPollSeconds: 180 } },
          {
            ...hooks,
            fetch: (cwd, branch) =>
              failFetch
                ? Effect.succeed(false)
                : Effect.sync(() => {
                    gitSync(cwd, "fetch", "-q", originPath, branch);
                    return true;
                  }),
          },
        );
      }
    }),
  );

  it.effect("contributions count once per repository, its worktrees too", () => {
    const root = projectsDir();
    const nested = join(root, "nested", "repo");
    repo(nested, 2, 1);
    gitSync(nested, "worktree", "add", "-q", "-b", "side", join(dirname(root), "worktrees", "copy"));
    return projects(
      root,
      Effect.gen(function* () {
        const repos = yield* (yield* Project).contributions([]);
        expect(repos.map((r) => r.commits)).toEqual([2]);
      }),
    );
  });
});
