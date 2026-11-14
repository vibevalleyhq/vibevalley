import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { withTimeout } from "@vibevalley/async";

import type { ServerConfig } from "#/infra/config.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { gitInEnv, gitSync, reposDir, repo, write } from "#/testing/git.ts";
import { testConfig, untilGot as until } from "#/testing/layers.ts";

import { activityOf, changedFiles, countsOf, type GitHubRun, makeRepo, type Repo, type RepoHooks, repoProblem, runCheck, tokeiArgs } from "./repo.ts";
import { MergeFailure } from "./workplace.ts";

/** gh is not installed. */
export const noGitHub: GitHubRun = () => Promise.resolve({ out: "", ok: false, missing: true });

const repos = async <A>(root: string, body: (p: Repo) => Promise<A>, change: Partial<ServerConfig> = {}, hooks: RepoHooks = {}): Promise<A> => {
  const p = await makeRepo({ config: testConfig({ workRoot: dirname(root), ...change }), clock: wallTime, log: keptLog() }, { gh: noGitHub, ...hooks });
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

/** The MergeFailure work threw. */
const mergeFailure = async (work: Promise<unknown>): Promise<MergeFailure> => {
  const e = await thrown(work);
  if (!(e instanceof MergeFailure)) throw e;
  return e;
};

const settled = <A>(work: Promise<A>) =>
  work.then(
    (value) => ({ _tag: "Success" as const, value }),
    (failure: unknown) => ({ _tag: "Failure" as const, failure }),
  );

describe("repos", () => {
  test("names and addresses", () => {
    for (const github of [
      "file:///tmp/repo",
      "https://github.com.evil/x/y",
      "https://u:secret@github.com/x/y",
      "https://github.com/x/y/tree/main",
      "--upload-pack=bad",
      "https://github.com/x/..",
    ])
      expect(repoProblem({ name: "ok", github })).not.toBe("");
    for (const name of ["../bad", "/tmp/bad", ".hidden", "-option", "a/b"]) expect(repoProblem({ name })).not.toBe("");
    expect(repoProblem({ name: "ok-name_1.2" })).toBe("");
    expect(repoProblem({ name: "x", github: "https://gitlab.com/a/b" })).toMatch(/GitHub/u);
  });

  test("a new repo has a first commit; an existing folder is refused and left alone; one of two at once", () => {
    const root = reposDir();
    mkdirSync(join(root, "existing"));
    writeFileSync(join(root, "existing", "keep"), "mine");
    return repos(root, async (p) => {
      const made = await p.create({ name: "garden" });
      expect(made.git).toBe(true);
      expect(gitSync(made.path, "rev-parse", "HEAD")).not.toBe("");
      expect((await thrown(p.create({ name: "existing" }))).message).toMatch(/已经存在/u);
      const both = await Promise.all([settled(p.create({ name: "same" })), settled(p.create({ name: "same" }))]);
      expect(both.filter((r) => r._tag === "Success")).toHaveLength(1);
      expect(readFileSync(join(root, "existing", "keep"), "utf8")).toBe("mine");
    });
  });

  test("a clone, offline; a failed one is cleaned up and can be tried again", () => {
    const root = reposDir();
    const source = join(root, ".source");
    mkdirSync(source);
    gitSync(root, "init", "-q", "-b", "main", source);
    writeFileSync(join(source, "README.md"), "seed");
    gitSync(source, "add", ".");
    gitSync(source, "commit", "-qm", "seed");
    const config = join(root, "gitconfig");
    writeFileSync(
      config,
      `[url "file://${source}"]\n insteadOf = https://github.com/test/source.git\n[url "file://${root}/.missing"]\n insteadOf = https://github.com/test/missing.git\n[protocol "file"]\n allow = always\n`,
    );
    const was = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    const putBack = () => {
      if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = was;
    };
    return repos(root, async (p) => {
      const cloned = await p.create({ name: "visit", github: "https://github.com/test/source" });
      expect(gitSync(cloned.path, "log", "-1", "--format=%s")).toBe("seed");
      expect(gitSync(cloned.path, "config", "--get", "remote.origin.url")).toBe("https://github.com/test/source.git");
      await thrown(p.create({ name: "retry", github: "https://github.com/test/missing" }));
      expect((await p.list()).some((x) => x.name === "retry")).toBe(false);
      await p.create({ name: "retry" });
    }).finally(putBack);
  });

  test("a parent issue's branch: a child merges into it, it merges into main", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      await p.openBranch("task", "vibevalley/task-1");
      const place = await p.checkout({ repo: "task", issue: 1, worktree: true, base: "vibevalley/task-1" });
      writeFileSync(join(place.cwd, "a.txt"), "a\n");
      gitSync(place.cwd, "add", "a.txt");
      gitSync(place.cwd, "commit", "-qm", "a");
      expect((await p.mergeInto(place, "vibevalley/task-1")).hashes).toHaveLength(1);
      const changes = await p.branchChanges("task", "vibevalley/task-1");
      expect(changes!.files.map((f) => f.path)).toEqual(["a.txt"]);
      expect(changes!.files[0]!.patch).toMatch(/^diff --git a\/a.txt b\/a.txt\n/u);
      const branchChanges2 = await p.branchChanges("task", "vibevalley/missing");
      expect(branchChanges2).toBeUndefined();
      const branchMerged = await p.mergeBranch("task", "vibevalley/task-1");
      expect(branchMerged).toMatch(/1 个提交合进了 task 的 main/u);
      const outcome = await runCheck(join(root, "task"), "cat a.txt && exit 3");
      expect(outcome).toEqual({
        ok: false,
        output: "a",
      });
    });
  });

  test("a branch's changes: each file's letter, its lines and its patch, a binary one with none", () => {
    const root = reposDir();
    const path = join(root, "described");
    repo(path, 1, 0);
    writeFileSync(join(path, "keep.txt"), "a\nb\n");
    writeFileSync(join(path, "gone.txt"), "x\n");
    gitSync(path, "add", ".");
    gitSync(path, "commit", "-qm", "base");
    return repos(root, async (p) => {
      const place = await p.checkout({ repo: "described", issue: 1, worktree: true, base: "" });
      writeFileSync(join(place.cwd, "keep.txt"), "a\nB\nc\n");
      writeFileSync(join(place.cwd, "b.bin"), Buffer.from([0, 1, 2]));
      writeFileSync(join(place.cwd, "sp ace.txt"), "new\n");
      gitSync(place.cwd, "rm", "-q", "gone.txt");
      gitSync(place.cwd, "add", "-A");
      gitSync(place.cwd, "commit", "-qm", "work");
      const changes = (await p.branchChanges("described", place.branch!))!;
      expect(changes.files.map((f) => [f.path, f.status, f.added, f.removed, f.patch !== undefined])).toEqual([
        ["b.bin", "A", -1, -1, false],
        ["gone.txt", "D", 0, 1, true],
        ["keep.txt", "M", 2, 1, true],
        ["sp ace.txt", "A", 1, 0, true],
      ]);
      expect(changes.files[2]!.patch).toBe(
        "diff --git a/keep.txt b/keep.txt\nindex 422c2b7..7be73ce 100644\n--- a/keep.txt\n+++ b/keep.txt\n@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c\n",
      );
      expect(changes.files[3]!.patch).toMatch(/^diff --git a\/sp ace.txt b\/sp ace.txt\n[\s\S]*\+new$/u);
      expect(changes.commits.map((c) => c.subject)).toEqual(["work"]);
    });
  });

  test("a new worktree runs the repo's .vibevalley/setup once, and one that fails still opens", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      const made = await p.create({ name: "setup" });
      mkdirSync(join(made.path, ".vibevalley"));
      write(join(made.path, ".vibevalley/setup"), "#!/bin/sh\necho once >> ready.txt\n", 0o755);
      gitSync(made.path, "add", ".vibevalley/setup");
      gitSync(made.path, "commit", "-qm", "setup");
      const place = await p.checkout({ repo: "setup", issue: 1, worktree: true, base: "" });
      expect(readFileSync(join(place.cwd, "ready.txt"), "utf8")).toBe("once\n");
      await p.checkout({ repo: "setup", issue: 1, worktree: true, base: "" });
      expect(readFileSync(join(place.cwd, "ready.txt"), "utf8")).toBe("once\n");

      write(join(made.path, ".vibevalley/setup"), "#!/bin/sh\nexit 3\n", 0o755);
      gitSync(made.path, "commit", "-qam", "a setup that fails");
      const failed = await p.checkout({ repo: "setup", issue: 2, worktree: true, base: "" });
      expect(existsSync(failed.cwd)).toBe(true);
    });
  });

  test("a branch opens where another stands", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      const place = await p.checkout({ repo: "task", issue: 1, worktree: true, base: "" });
      writeFileSync(join(place.cwd, "a.txt"), "before the split\n");
      gitSync(place.cwd, "add", "a.txt");
      gitSync(place.cwd, "commit", "-qm", "a");
      await p.openBranch("task", "vibevalley/task-1", place.branch);
      expect(gitSync(join(root, "task"), "show", "vibevalley/task-1:a.txt")).toBe("before the split");
    });
  });

  test("the files changed since the base, a rename under both names", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      await p.openBranch("task", "vibevalley/task-1");
      const work = (id: string, ...files: string[]) =>
        p.checkout({ repo: "task", issue: Number(id.slice(1)), worktree: true, base: "vibevalley/task-1" }).then((place) => {
          files.forEach((f) => writeFileSync(join(place.cwd, f), id + "\n"));
          return place;
        });
      const first = await work("w1", "a.txt", "b.txt");
      gitSync(first.cwd, "add", ".");
      gitSync(first.cwd, "commit", "-qm", "w1");
      await p.mergeInto(first, "vibevalley/task-1");
      const mine = await work("w2", "a.txt");
      gitSync(mine.cwd, "commit", "-qam", "a");
      gitSync(mine.cwd, "mv", "b.txt", "c.txt");
      writeFileSync(join(mine.cwd, "new.txt"), "new\n");
      const third = await work("w3", "later.txt");
      gitSync(third.cwd, "add", ".");
      gitSync(third.cwd, "commit", "-qm", "w3");
      await p.mergeInto(third, "vibevalley/task-1");
      const changedFiles2 = await changedFiles(mine.cwd, "vibevalley/task-1");
      expect(changedFiles2).toEqual(["a.txt", "b.txt", "c.txt", "new.txt"]);
    });
  });

  test("tokei's output", () => {
    const report = (name: string) => ({
      name,
      stats: { blanks: 0, code: 1, comments: 0, blobs: {} },
    });
    const lang = (blanks: number, code: number, comments: number, ...reports: object[]) => ({
      blanks,
      code,
      comments,
      inaccurate: false,
      reports,
      children: {},
    });
    const body = JSON.stringify({
      TypeScript: lang(30, 400, 50, report("a.ts"), report("b.ts")),
      Markdown: lang(10, 0, 600, report("README.md")),
      Go: lang(5, 440, 0, report("main.go")),
      Text: lang(9, 0, 0, report("empty.txt")),
      Total: lang(54, 850, 650),
    });
    expect(countsOf(body)).toEqual([
      { name: "Markdown", files: 1, code: 0, comments: 600, blanks: 10 },
      { name: "TypeScript", files: 2, code: 400, comments: 50, blanks: 30 },
      { name: "Go", files: 1, code: 440, comments: 0, blanks: 5 },
    ]);
    expect(countsOf("not json")).toBeUndefined();
    expect(countsOf(`{"TypeScript":{"code":"many"}}`)).toBeUndefined();
    const args = tokeiArgs("/work/app");
    expect(args.slice(0, 2)).toEqual(["--output", "json"]);
    expect(args.at(-1)).toBe("/work/app");
    for (const pattern of ["pnpm-lock.yaml", "package-lock.json", "Cargo.lock", "*.min.js", "node_modules/"]) expect(args).toContain(pattern);
  });

  test("commits by day and by author", () => {
    const at = (iso: string) => Date.parse(iso) / 1000;
    const log = [
      `${at("2026-10-02T09:00:00Z")}\tMe`,
      `${at("2026-10-01T10:00:00Z")}\tMe`,
      `${at("2026-10-02T20:00:00Z")}\tColleague`,
      "",
      "garbage",
      `${at("2026-10-02T21:00:00Z")}\t`,
    ].join("\n");
    const { days, authors } = activityOf(log, (ms) => new Date(ms).toISOString().slice(0, 10));
    expect(days).toEqual([
      { day: "2026-10-01", commits: 1 },
      { day: "2026-10-02", commits: 3 },
    ]);
    expect(authors).toEqual([
      { name: "Me", commits: 2 },
      { name: "Colleague", commits: 1 },
      { name: "无名", commits: 1 },
    ]);
  });

  const workRoot = () => {
    const root = reposDir();
    const app = join(root, "app");
    mkdirSync(app);
    gitSync(app, "init", "-q", "-b", "main");
    gitSync(app, "config", "user.email", "me@vibevalley.test");
    gitSync(app, "config", "user.name", "Me");
    writeFileSync(join(app, "main.ts"), "export const a = 1\n// a comment\n\nexport const b = 2\n");
    writeFileSync(join(app, "pnpm-lock.yaml"), "lockfileVersion: 9\n".repeat(500));
    gitSync(app, "add", ".");
    const dated = (date: string, ...args: string[]) => gitInEnv(app, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, ...args);
    dated("2026-10-01T10:00:00", "-c", "user.name=Me", "-c", "user.email=me@vibevalley.test", "commit", "-q", "-m", "first");
    gitSync(app, "checkout", "-q", "-b", "side");
    dated(
      "2026-10-02T10:00:00",
      "-c",
      "user.name=Me",
      "-c",
      "user.email=me@vibevalley.test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "second",
      "--author",
      "Colleague <c@vibevalley.test>",
    );
    gitSync(app, "checkout", "-q", "main");
    gitSync(app, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    mkdirSync(join(root, "notes"));
    return root;
  };

  test("repos with their newest commit", () => {
    const root = workRoot();
    return repos(root, async (p) => {
      const byName = Object.fromEntries((await p.summaries()).map((p) => [p.name, p]));
      expect(byName.app!.git).toBe(true);
      expect(byName.app!.last).toBeGreaterThan(0);
      expect(byName.notes).toEqual({
        name: "notes",
        path: join(realpathSync(root), "notes"),
        git: false,
        maxSessions: 3,
        pullRequest: { available: false, reason: "尚未检测仓库，请刷新 GitHub 状态" },
      });
    });
  });

  test("the repo limit is within maxRunning", async () => {
    for (const [limit, want] of [
      [3, 3],
      [1, 1],
      [0, 6],
      [9, 6],
    ] as const) {
      const maxSessions = await repos(reposDir(), (p) => Promise.resolve(p.maxSessions()), { repo: { maxSessions: limit, checkTimeoutSeconds: 1200 } });
      expect(maxSessions).toBe(want);
    }
  });

  test("a year of commits; merges do not count; only folders the work directory has", () => {
    const root = workRoot();
    return repos(root, async (p) => {
      const activity = (await p.activity("app"))!;
      expect(activity.total).toBe(2);
      expect(activity.days.map((d) => d.day)).toEqual(["2026-10-01", "2026-10-02"]);
      expect(activity.authors).toEqual([
        { name: "Colleague", commits: 1 },
        { name: "Me", commits: 1 },
      ]);
      expect(activity.first).toBe(new Date(2026, 9, 1, 10).getTime());
      const notes = (await p.activity("notes"))!;
      expect([notes.days.length, notes.total]).toEqual([0, 0]);
      const activity2 = await p.activity("../etc");
      expect(activity2).toBeUndefined();
    });
  });

  test("without tokei, it says how to get it", () =>
    repos(
      workRoot(),
      async (p) => {
        expect((await thrown(p.languages("app"))).message).toMatch(/tokei/u);
      },
      { tokei: "/nowhere/tokei" },
    ));

  test("a merge refuses uncommitted work, and caches stay out of what is committed", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      const place = await p.checkout({ repo: "left", issue: 1, worktree: true, base: "" });
      mkdirSync(join(place.cwd, "__pycache__"));
      writeFileSync(join(place.cwd, "__pycache__", "greet.cpython-312.pyc"), "cache");
      writeFileSync(join(place.cwd, "greet.py"), "def greet(): pass\n");
      const refused = await mergeFailure(p.merge(place));
      expect(refused.kind).toBe("error");
      expect(refused.message).toMatch(/没提交/u);
      expect(existsSync(place.cwd)).toBe(true);
      gitSync(place.cwd, "add", "greet.py");
      gitSync(place.cwd, "commit", "-qm", "greet");
      await p.merge(place);
      expect(gitSync(join(root, "left"), "ls-files").split("\n")).toEqual([".gitignore", "README.md", "greet.py"]);
    });
  });

  test("a published merge keeps its receipt when the worktree cannot be cleaned up", async () => {
    for (const intoTask of [false, true]) {
      const root = reposDir();
      await repos(root, async (p) => {
        const target = intoTask ? "task" : "main";
        if (intoTask) await p.openBranch("demo", target);
        const place = await p.checkout({ repo: "demo", issue: 1, worktree: true, base: intoTask ? target : "" });
        writeFileSync(join(place.cwd, "result.txt"), "kept");
        gitSync(place.cwd, "add", ".");
        gitSync(place.cwd, "commit", "-qm", "result");
        gitSync(join(root, "demo"), "worktree", "lock", place.cwd);
        const merged = intoTask ? await p.mergeInto(place, target) : await p.merge(place);
        expect(merged.commits).toBe(1);
        expect(merged.warning).toBeTruthy();
        expect(gitSync(join(root, "demo"), "show", `${target}:result.txt`)).toBe("kept");
        expect(existsSync(place.cwd)).toBe(true);
      });
    }
  });

  test("a merge runs the repo's check: absent, passing, failing with its output", async () => {
    for (const into of [false, true]) {
      for (const check of ["absent", "pass", "fail"]) {
        const root = reposDir();
        await repos(root, async (p) => {
          const target = into ? "vibevalley/task-1" : "main";
          if (into) await p.openBranch("checked", target);
          const place = await p.checkout({ repo: "checked", issue: 1, worktree: true, base: into ? target : "" });
          const path = join(root, "checked");
          const before = gitSync(path, "rev-parse", target);
          writeFileSync(join(place.cwd, "work.txt"), "work");
          if (check !== "absent") {
            mkdirSync(join(place.cwd, ".vibevalley"));
            let body = '#!/bin/sh\nset -eu\ntest -f work.txt\ntest -z "$(git status --porcelain)"\necho check-stdout\necho check-stderr >&2\n';
            if (check === "fail") body += "exit 7\n";
            write(join(place.cwd, ".vibevalley/check"), body, 0o755);
          }
          gitSync(place.cwd, "add", ".");
          gitSync(place.cwd, "commit", "-qm", "work");
          const result = await settled(into ? p.mergeInto(place, target) : p.merge(place));
          if (check === "fail") {
            expect(result._tag).toBe("Failure");
            const e = result._tag === "Failure" ? result.failure : undefined;
            if (!(e instanceof MergeFailure)) throw e;
            expect(e.message).toMatch(/check-stdout/u);
            expect(e.message).toMatch(/check-stderr/u);
            expect(gitSync(path, "rev-parse", target)).toBe(before);
            expect(existsSync(place.cwd)).toBe(true);
          } else {
            expect(result._tag).toBe("Success");
            expect(gitSync(path, "show", `${target}:work.txt`)).toBe("work");
          }
        });
      }
    }
  });

  test("a check that runs too long is stopped with its children, and its last lines said", () => {
    const root = reposDir();
    return repos(
      root,
      async (p) => {
        const place = await p.checkout({ repo: "timeout", issue: 1, worktree: true, base: "" });
        mkdirSync(join(place.cwd, ".vibevalley"));
        write(
          join(place.cwd, ".vibevalley/check"),
          "#!/bin/sh\necho discarded-first-line\ni=0\nwhile [ $i -lt 60 ]; do echo line-$i; i=$((i+1)); done\nsleep 30\n",
          0o755,
        );
        gitSync(place.cwd, "add", ".");
        gitSync(place.cwd, "commit", "-qm", "check");
        // The process's deadline is real time: so is how long the merge took.
        const started = wallTime.now();
        const e = await thrown(p.merge(place));
        expect(e.message).toMatch(/超时/u);
        expect(e.message).toMatch(/line-59/u);
        expect(e.message).not.toMatch(/discarded-first-line/u);
        const ended = wallTime.now();
        expect(ended - started).toBeLessThan(10_000);
        expect(existsSync(place.cwd)).toBe(true);
      },
      { repo: { maxSessions: 3, checkTimeoutSeconds: 2 } },
    );
  }, 20_000);

  test("a check that cannot run refuses", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      const place = await p.checkout({ repo: "permissions", issue: 1, worktree: true, base: "" });
      mkdirSync(join(place.cwd, ".vibevalley"));
      write(join(place.cwd, ".vibevalley/check"), "#!/bin/sh\nexit 0\n", 0o644);
      gitSync(place.cwd, "add", ".");
      gitSync(place.cwd, "commit", "-qm", "a check that is not executable");
      const e = await mergeFailure(p.merge(place));
      expect(e.kind).toBe("check");
      expect(existsSync(place.cwd)).toBe(true);
    });
  });

  test("a failed git inspection does not claim an issue's branch was released", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      await p.openBranch("demo", "vibevalley/issue-9");
      const path = join(root, "demo");
      renameSync(join(path, ".git"), join(path, ".git-held"));
      try {
        const clear2 = await p.clearCheckout("demo", 9);
        expect(clear2).toMatchObject({ kept: true });
      } finally {
        renameSync(join(path, ".git-held"), join(path, ".git"));
      }
    });
  });

  test("an issue's worktree: reset to main, cleared with an empty branch, a branch with commits kept", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      const path = join(root, "demo");
      const place = await p.checkout({ repo: "demo", issue: 7, worktree: true, base: "" });
      const main = gitSync(path, "rev-parse", "main");
      writeFileSync(join(place.cwd, "refined.txt"), "x");
      gitSync(place.cwd, "add", ".");
      gitSync(place.cwd, "commit", "-qm", "not the draft's to keep");
      writeFileSync(join(place.cwd, "scratch.txt"), "y");
      await p.resetCheckout(place);
      expect([gitSync(place.cwd, "rev-parse", "HEAD"), gitSync(place.cwd, "status", "--porcelain"), gitSync(place.cwd, "branch", "--show-current")]).toEqual([
        main,
        "",
        place.branch,
      ]);
      await thrown(p.resetCheckout({ repo: "demo", cwd: path }));
      writeFileSync(join(place.cwd, "scratch.txt"), "y");
      const clear2 = await p.clearCheckout("demo", 7, "preserve");
      expect(clear2).toMatchObject({ kept: true });
      expect(existsSync(join(place.cwd, "scratch.txt"))).toBe(true);
      const clear3 = await p.clearCheckout("demo", 7);
      expect(clear3).toEqual({ kept: false });
      expect(existsSync(place.cwd)).toBe(false);
      expect(() => gitSync(path, "show-ref", "--verify", "refs/heads/" + place.branch)).toThrow();
      const kept = await p.checkout({ repo: "demo", issue: 8, worktree: true, base: "" });
      writeFileSync(join(kept.cwd, "work.txt"), "z");
      gitSync(kept.cwd, "add", ".");
      gitSync(kept.cwd, "commit", "-qm", "work");
      const clear4 = await p.clearCheckout("demo", 8);
      expect(clear4).toMatchObject({
        kept: true,
        reason: expect.stringMatching(/分支留着/u),
      });
      const clear5 = await p.clearCheckout("missing", 9);
      expect(clear5).toEqual({ kept: false });
    });
  });

  test("an issue comes back to the same worktree, whatever happened to the last session", async () => {
    for (const mode of ["existing", "cancelled", "merged", "dirty", "base"]) {
      const root = reposDir();
      await repos(root, async (p) => {
        const path = join(root, "demo");
        let base = "";
        let baseHead = "";
        if (mode === "base") {
          base = "vibevalley/task-42";
          await p.openBranch("demo", base);
          const tree = gitSync(path, "rev-parse", "HEAD^{tree}");
          baseHead = gitSync(path, "commit-tree", tree, "-p", "HEAD", "-m", "task only");
          gitSync(path, "update-ref", "refs/heads/" + base, baseHead);
        }
        const first = await p.checkout({ repo: "demo", issue: 42, worktree: true, base });
        if (baseHead) expect(gitSync(first.cwd, "rev-parse", "HEAD")).toBe(baseHead);
        expect(first.branch).toBe("vibevalley/issue-42");
        expect(first.cwd).toBe(join(dirname(root), "worktrees", "demo.42"));
        writeFileSync(join(first.cwd, "previous.txt"), "previous");
        if (mode !== "dirty") {
          gitSync(first.cwd, "add", ".");
          gitSync(first.cwd, "commit", "-qm", "previous");
        }
        let before = gitSync(first.cwd, "rev-parse", "HEAD");
        if (mode === "cancelled" || mode === "dirty") await p.releaseCheckout(first);
        if (mode === "merged") {
          await p.merge(first);
          gitSync(path, "commit", "--allow-empty", "-m", "later");
          before = gitSync(path, "rev-parse", "HEAD");
        }
        const second = await p.checkout({ repo: "demo", issue: 42, worktree: true, base });
        expect(second).toEqual(first);
        expect(gitSync(second.cwd, "rev-parse", "HEAD")).toBe(before);
        expect(readFileSync(join(second.cwd, "previous.txt"), "utf8")).toBe("previous");
      });
    }
  });

  test("the check runs outside the repo's turn; a branch changed meanwhile is refused", async () => {
    for (const into of [false, true]) {
      for (const changed of [false, true]) {
        const root = reposDir();
        await repos(root, async (p) => {
          const target = into ? "vibevalley/task-42" : "main";
          if (into) await p.openBranch("demo", target);
          const place = await p.checkout({ repo: "demo", issue: 1, worktree: true, base: into ? target : "" });
          const before = gitSync(join(root, "demo"), "rev-parse", target);
          const signal = reposDir();
          const started = join(signal, "started");
          const release = join(signal, "release");
          mkdirSync(join(place.cwd, ".vibevalley"));
          write(join(place.cwd, ".vibevalley/check"), `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`, 0o755);
          gitSync(place.cwd, "add", ".");
          gitSync(place.cwd, "commit", "-qm", "check");
          const merging = settled(into ? p.mergeInto(place, target) : p.merge(place));
          await until(() => existsSync(started), "the check started");
          await withTimeout(() => p.checkout({ repo: "demo", issue: 2, worktree: true, base: "" }), 2000, { clock: wallTime });
          if (changed) gitSync(place.cwd, "commit", "--allow-empty", "-m", "changed during check");
          writeFileSync(release, "");
          const result = await merging;
          if (changed) {
            expect(result._tag).toBe("Failure");
            expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({ message: expect.stringMatching(/检查以后/u) });
            expect(gitSync(join(root, "demo"), "rev-parse", target)).toBe(before);
            expect(existsSync(place.cwd)).toBe(true);
          } else expect(result._tag).toBe("Success");
        });
      }
    }
  }, 30_000);

  test("a local merge checks the tree with main's changes in it", () => {
    const root = reposDir();
    return repos(root, async (p) => {
      const place = await p.checkout({ repo: "combined", issue: 1, worktree: true, base: "" });
      const path = join(root, "combined");
      writeFileSync(join(path, "main-only"), "main");
      gitSync(path, "add", ".");
      gitSync(path, "commit", "-qm", "main advanced");
      mkdirSync(join(place.cwd, ".vibevalley"));
      write(join(place.cwd, ".vibevalley/check"), "#!/bin/sh\ntest -f main-only\n", 0o755);
      gitSync(place.cwd, "add", ".");
      gitSync(place.cwd, "commit", "-qm", "check");
      await p.merge(place);
    });
  });

  test("a repo symlinked outside the work root is refused", () => {
    const root = reposDir();
    const outside = reposDir();
    repo(join(outside, "elsewhere"), 1, 0);
    symlinkSync(join(outside, "elsewhere"), join(root, "linked"));
    return repos(root, async (p) => {
      expect((await thrown(p.checkout({ repo: "linked", issue: 1, worktree: true, base: "" }))).message).toMatch(/工作目录里面/u);
    });
  });
});
