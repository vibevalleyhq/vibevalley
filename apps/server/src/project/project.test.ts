import { execFileSync } from "node:child_process";
import { NodeServices } from "@effect/platform-node";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { type Config, Settings } from "../base/config.ts";
import { gitSync, projectsDir, repo, write } from "../testing/git.ts";
import { testConfig } from "../testing/layers.ts";
import {
  activityOf,
  countsOf,
  githubRepository,
  type GitHubRun,
  MergeFailure,
  type ProjectHooks,
  projectProblem,
  Projects,
  layer,
  tokeiArgs,
} from "./project.ts";

/** gh is not installed. */
export const noGitHub: GitHubRun = () => Effect.succeed({ out: "", ok: false, missing: true });

const projects = <A, E>(root: string, body: Effect.Effect<A, E, Projects>, change: Partial<Config> = {}, hooks: ProjectHooks = {}) =>
  body.pipe(
    Effect.provide(
      layer({ gh: noGitHub, ...hooks }).pipe(
        Layer.provide(Layer.merge(Layer.succeed(Settings, testConfig({ workRoot: dirname(root), ...change })), NodeServices.layer)),
      ),
    ),
  );

describe("projects", () => {
  it("names and addresses", () => {
    expect(githubRepository(" https://github.com/botiverse/raft-source.git/ ")).toEqual({
      name: "raft-source",
      url: "https://github.com/botiverse/raft-source.git",
    });
    for (const github of [
      "file:///tmp/repo",
      "https://github.com.evil/x/y",
      "https://u:secret@github.com/x/y",
      "https://github.com/x/y/tree/main",
      "--upload-pack=bad",
      "https://github.com/x/..",
    ])
      expect(projectProblem({ name: "ok", github })).not.toBe("");
    for (const name of ["../bad", "/tmp/bad", ".hidden", "-option", "a/b"]) expect(projectProblem({ name })).not.toBe("");
    expect(projectProblem({ name: "ok-name_1.2" })).toBe("");
    expect(projectProblem({ name: "x", github: "https://gitlab.com/a/b" })).toMatch(/GitHub/);
  });

  it.effect("a new project has a first commit; an existing folder is refused and left alone; one of two at once", () => {
    const root = projectsDir();
    mkdirSync(join(root, "existing"));
    writeFileSync(join(root, "existing", "keep"), "mine");
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        const made = yield* p.create({ name: "garden" });
        expect(made.git).toBe(true);
        expect(gitSync(made.path, "rev-parse", "HEAD")).not.toBe("");
        expect((yield* Effect.flip(p.create({ name: "existing" }))).message).toMatch(/已经存在/);
        const both = yield* Effect.all([Effect.result(p.create({ name: "same" })), Effect.result(p.create({ name: "same" }))], { concurrency: 2 });
        expect(both.filter((r) => r._tag === "Success")).toHaveLength(1);
        expect(readFileSync(join(root, "existing", "keep"), "utf8")).toBe("mine");
      }),
    );
  });

  it.effect("a clone, offline; a failed one is cleaned up and can be tried again", () => {
    const root = projectsDir();
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
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        const cloned = yield* p.create({ name: "visit", github: "https://github.com/test/source" });
        expect(gitSync(cloned.path, "log", "-1", "--format=%s")).toBe("seed");
        expect(gitSync(cloned.path, "config", "--get", "remote.origin.url")).toBe("https://github.com/test/source.git");
        yield* Effect.flip(p.create({ name: "retry", github: "https://github.com/test/missing" }));
        expect((yield* p.list()).some((x) => x.name === "retry")).toBe(false);
        yield* p.create({ name: "retry" });
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => (was === undefined ? delete process.env.GIT_CONFIG_GLOBAL : (process.env.GIT_CONFIG_GLOBAL = was)))));
  });

  it.effect("a graph's branch: a step merges into it, it merges into main", () => {
    const root = projectsDir();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        yield* p.openBranch("task", "vibevalley/task-1");
        const place = yield* p.workplace("task", 1, true, "vibevalley/task-1");
        writeFileSync(join(place.cwd, "a.txt"), "a\n");
        expect((yield* p.mergeInto(place, "vibevalley/task-1")).hashes).toHaveLength(1);
        const changes = yield* p.branchChanges("task", "vibevalley/task-1");
        expect(changes.files.map((f) => f.path)).toEqual(["a.txt"]);
        expect(changes.files[0]!.patch).toMatch(/^diff --git a\/a.txt b\/a.txt\n/);
        expect(yield* p.mergeBranch("task", "vibevalley/task-1")).toMatch(/1 个提交合进了 task 的 main/);
        expect(yield* p.run(join(root, "task"), "cat a.txt && exit 3")).toEqual({
          ok: false,
          output: "a",
        });
      }),
    );
  });

  it.effect("a branch opens where another stands", () => {
    const root = projectsDir();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        const place = yield* p.workplace("task", 1, true, "");
        writeFileSync(join(place.cwd, "a.txt"), "before the split\n");
        gitSync(place.cwd, "add", "a.txt");
        gitSync(place.cwd, "commit", "-qm", "a");
        yield* p.openBranch("task", "vibevalley/task-1", place.branch);
        expect(gitSync(join(root, "task"), "show", "vibevalley/task-1:a.txt")).toBe("before the split");
      }),
    );
  });

  it.effect("the files changed since the base, a rename under both names", () => {
    const root = projectsDir();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        yield* p.openBranch("task", "vibevalley/task-1");
        const work = (id: string, ...files: string[]) =>
          Effect.tap(p.workplace("task", Number(id.slice(1)), true, "vibevalley/task-1"), (place) =>
            Effect.sync(() => files.forEach((f) => writeFileSync(join(place.cwd, f), id + "\n"))),
          );
        yield* p.mergeInto(yield* work("w1", "a.txt", "b.txt"), "vibevalley/task-1");
        const mine = yield* work("w2", "a.txt");
        gitSync(mine.cwd, "commit", "-qam", "a");
        gitSync(mine.cwd, "mv", "b.txt", "c.txt");
        writeFileSync(join(mine.cwd, "new.txt"), "new\n");
        yield* p.mergeInto(yield* work("w3", "later.txt"), "vibevalley/task-1");
        expect(yield* p.changedFiles(mine.cwd, "vibevalley/task-1")).toEqual(["a.txt", "b.txt", "c.txt", "new.txt"]);
      }),
    );
  });

  it("tokei's output", () => {
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

  it("commits by day and by author", () => {
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
    const root = projectsDir();
    const app = join(root, "app");
    mkdirSync(app);
    gitSync(app, "init", "-q", "-b", "main");
    gitSync(app, "config", "user.email", "me@vibevalley.test");
    gitSync(app, "config", "user.name", "Me");
    writeFileSync(join(app, "main.ts"), "export const a = 1\n// a comment\n\nexport const b = 2\n");
    writeFileSync(join(app, "pnpm-lock.yaml"), "lockfileVersion: 9\n".repeat(500));
    gitSync(app, "add", ".");
    const dated = (date: string, ...args: string[]) => execFileSyncEnv(app, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, ...args);
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

  it.effect("projects with their newest commit", () => {
    const root = workRoot();
    return projects(
      root,
      Effect.gen(function* () {
        const byName = Object.fromEntries((yield* (yield* Projects).summaries()).map((p) => [p.name, p]));
        expect(byName.app!.git).toBe(true);
        expect(byName.app!.last).toBeGreaterThan(0);
        expect(byName.notes).toEqual({
          name: "notes",
          path: join(realpathSync(root), "notes"),
          git: false,
          maxSessions: 3,
          pullRequest: { available: false, reason: "尚未检测项目，请刷新 GitHub 状态" },
        });
      }),
    );
  });

  it.effect("the project limit is within maxRunning", () =>
    Effect.gen(function* () {
      for (const [limit, want] of [
        [3, 3],
        [1, 1],
        [0, 6],
        [9, 6],
      ] as const)
        expect(
          yield* projects(
            projectsDir(),
            Effect.map(Projects, (p) => p.maxSessions()),
            { project: { maxSessions: limit, checkTimeoutSeconds: 1200 } },
          ),
        ).toBe(want);
    }),
  );

  it.effect("a year of commits; merges do not count; only folders the work directory has", () => {
    const root = workRoot();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        const activity = (yield* p.activity("app"))!;
        expect(activity.total).toBe(2);
        expect(activity.days.map((d) => d.day)).toEqual(["2026-10-01", "2026-10-02"]);
        expect(activity.authors).toEqual([
          { name: "Colleague", commits: 1 },
          { name: "Me", commits: 1 },
        ]);
        expect(activity.first).toBe(new Date(2026, 9, 1, 10).getTime());
        const notes = (yield* p.activity("notes"))!;
        expect([notes.days.length, notes.total]).toEqual([0, 0]);
        expect(yield* p.activity("../etc")).toBeUndefined();
      }),
    );
  });

  it.effect("without tokei, it says how to get it", () =>
    projects(
      workRoot(),
      Effect.gen(function* () {
        expect((yield* Effect.flip((yield* Projects).languages("app"))).message).toMatch(/tokei/);
      }),
      { tokei: "/nowhere/tokei" },
    ),
  );

  it.effect("what a session left is committed without caches", () => {
    const root = projectsDir();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        const place = yield* p.workplace("left", 1, true, "");
        mkdirSync(join(place.cwd, "__pycache__"));
        writeFileSync(join(place.cwd, "__pycache__", "greet.cpython-312.pyc"), "cache");
        writeFileSync(join(place.cwd, "greet.py"), "def greet(): pass\n");
        yield* p.merge(place);
        expect(gitSync(join(root, "left"), "ls-files").split("\n")).toEqual([".gitignore", "README.md", "greet.py"]);
      }),
    );
  });

  it.effect("a published merge keeps its receipt when the worktree cannot be cleaned up", () =>
    Effect.gen(function* () {
      for (const intoTask of [false, true]) {
        const root = projectsDir();
        yield* projects(
          root,
          Effect.gen(function* () {
            const p = yield* Projects;
            const target = intoTask ? "task" : "main";
            if (intoTask) yield* p.openBranch("demo", target);
            const place = yield* p.workplace("demo", 1, true, intoTask ? target : "");
            writeFileSync(join(place.cwd, "result.txt"), "kept");
            gitSync(join(root, "demo"), "worktree", "lock", place.cwd);
            const merged = intoTask ? yield* p.mergeInto(place, target) : yield* p.merge(place);
            expect(merged.commits).toBe(1);
            expect(merged.warning).toBeTruthy();
            expect(gitSync(join(root, "demo"), "show", `${target}:result.txt`)).toBe("kept");
            expect(existsSync(place.cwd)).toBe(true);
          }),
        );
      }
    }),
  );

  it.effect("a merge runs the project's check: absent, passing, failing with its output", () =>
    Effect.gen(function* () {
      for (const into of [false, true]) {
        for (const check of ["absent", "pass", "fail"]) {
          const root = projectsDir();
          yield* projects(
            root,
            Effect.gen(function* () {
              const p = yield* Projects;
              const target = into ? "vibevalley/task-1" : "main";
              if (into) yield* p.openBranch("checked", target);
              const place = yield* p.workplace("checked", 1, true, into ? target : "");
              const path = join(root, "checked");
              const before = gitSync(path, "rev-parse", target);
              writeFileSync(join(place.cwd, "work.txt"), "work");
              if (check !== "absent") {
                mkdirSync(join(place.cwd, ".vibevalley"));
                let body = '#!/bin/sh\nset -eu\ntest -f work.txt\ntest -z "$(git status --porcelain)"\necho check-stdout\necho check-stderr >&2\n';
                if (check === "fail") body += "exit 7\n";
                write(join(place.cwd, ".vibevalley/check"), body, 0o755);
              }
              const result = yield* Effect.result(into ? p.mergeInto(place, target) : p.merge(place));
              if (check === "fail") {
                expect(result._tag).toBe("Failure");
                const e = (result as { failure: MergeFailure }).failure;
                expect(e.message).toMatch(/check-stdout/);
                expect(e.message).toMatch(/check-stderr/);
                expect(gitSync(path, "rev-parse", target)).toBe(before);
                expect(existsSync(place.cwd)).toBe(true);
              } else {
                expect(result._tag).toBe("Success");
                expect(gitSync(path, "show", `${target}:work.txt`)).toBe("work");
              }
            }),
          );
        }
      }
    }),
  );

  it.effect(
    "a check that runs too long is stopped with its children, and its last lines said",
    () => {
      const root = projectsDir();
      return projects(
        root,
        Effect.gen(function* () {
          const p = yield* Projects;
          const place = yield* p.workplace("timeout", 1, true, "");
          mkdirSync(join(place.cwd, ".vibevalley"));
          write(
            join(place.cwd, ".vibevalley/check"),
            "#!/bin/sh\necho discarded-first-line\ni=0\nwhile [ $i -lt 60 ]; do echo line-$i; i=$((i+1)); done\nsleep 30\n",
            0o755,
          );
          const started = Date.now();
          const e = yield* Effect.flip(p.merge(place));
          expect(e.message).toMatch(/超时/);
          expect(e.message).toMatch(/line-59/);
          expect(e.message).not.toMatch(/discarded-first-line/);
          expect(Date.now() - started).toBeLessThan(10_000);
          expect(existsSync(place.cwd)).toBe(true);
        }),
        { project: { maxSessions: 3, checkTimeoutSeconds: 2 } },
      );
    },
    20_000,
  );

  it.effect("a check that cannot run refuses", () => {
    const root = projectsDir();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        const place = yield* p.workplace("permissions", 1, true, "");
        mkdirSync(join(place.cwd, ".vibevalley"));
        write(join(place.cwd, ".vibevalley/check"), "#!/bin/sh\nexit 0\n", 0o644);
        const e = yield* Effect.flip(p.merge(place));
        expect(e.kind).toBe("check");
        expect(existsSync(place.cwd)).toBe(true);
      }),
    );
  });

  it.effect("a failed git inspection does not claim an issue's branch was released", () => {
    const root = projectsDir();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        yield* p.openBranch("demo", "vibevalley/issue-9");
        const path = join(root, "demo");
        renameSync(join(path, ".git"), join(path, ".git-held"));
        try {
          expect(yield* p.clear("demo", 9)).toMatchObject({ kept: true });
        } finally {
          renameSync(join(path, ".git-held"), join(path, ".git"));
        }
      }),
    );
  });

  it.effect("an issue's worktree: reset to main, cleared with an empty branch, a branch with commits kept", () => {
    const root = projectsDir();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        const path = join(root, "demo");
        const place = yield* p.workplace("demo", 7, true, "");
        const main = gitSync(path, "rev-parse", "main");
        writeFileSync(join(place.cwd, "refined.txt"), "x");
        gitSync(place.cwd, "add", ".");
        gitSync(place.cwd, "commit", "-qm", "not the draft's to keep");
        writeFileSync(join(place.cwd, "scratch.txt"), "y");
        yield* p.reset(place);
        expect([gitSync(place.cwd, "rev-parse", "HEAD"), gitSync(place.cwd, "status", "--porcelain"), gitSync(place.cwd, "branch", "--show-current")]).toEqual([
          main,
          "",
          place.branch,
        ]);
        yield* Effect.flip(p.reset({ project: "demo", cwd: path }));
        writeFileSync(join(place.cwd, "scratch.txt"), "y");
        expect(yield* p.clear("demo", 7, "preserve")).toMatchObject({ kept: true });
        expect(existsSync(join(place.cwd, "scratch.txt"))).toBe(true);
        expect(yield* p.clear("demo", 7)).toEqual({ kept: false });
        expect(existsSync(place.cwd)).toBe(false);
        expect(() => gitSync(path, "show-ref", "--verify", "refs/heads/" + place.branch)).toThrow();
        const kept = yield* p.workplace("demo", 8, true, "");
        writeFileSync(join(kept.cwd, "work.txt"), "z");
        gitSync(kept.cwd, "add", ".");
        gitSync(kept.cwd, "commit", "-qm", "work");
        expect(yield* p.clear("demo", 8)).toMatchObject({
          kept: true,
          reason: expect.stringMatching(/分支留着/),
        });
        expect(yield* p.clear("missing", 9)).toEqual({ kept: false });
      }),
    );
  });

  it.effect("an issue comes back to the same worktree, whatever happened to the last session", () =>
    Effect.gen(function* () {
      for (const mode of ["existing", "cancelled", "merged", "dirty", "base"]) {
        const root = projectsDir();
        yield* projects(
          root,
          Effect.gen(function* () {
            const p = yield* Projects;
            const path = join(root, "demo");
            let base = "";
            let baseHead = "";
            if (mode === "base") {
              base = "vibevalley/task-42";
              yield* p.openBranch("demo", base);
              const tree = gitSync(path, "rev-parse", "HEAD^{tree}");
              baseHead = gitSync(path, "commit-tree", tree, "-p", "HEAD", "-m", "task only");
              gitSync(path, "update-ref", "refs/heads/" + base, baseHead);
            }
            const first = yield* p.workplace("demo", 42, true, base);
            if (baseHead) expect(gitSync(first.cwd, "rev-parse", "HEAD")).toBe(baseHead);
            expect(first.branch).toBe("vibevalley/issue-42");
            expect(first.cwd).toBe(join(dirname(root), "worktrees", "demo.42"));
            writeFileSync(join(first.cwd, "previous.txt"), "previous");
            if (mode !== "dirty") {
              gitSync(first.cwd, "add", ".");
              gitSync(first.cwd, "commit", "-qm", "previous");
            }
            let before = gitSync(first.cwd, "rev-parse", "HEAD");
            if (mode === "cancelled" || mode === "dirty") yield* p.release(first);
            if (mode === "merged") {
              yield* p.merge(first);
              gitSync(path, "commit", "--allow-empty", "-m", "later");
              before = gitSync(path, "rev-parse", "HEAD");
            }
            const second = yield* p.workplace("demo", 42, true, base);
            expect(second).toEqual(first);
            expect(gitSync(second.cwd, "rev-parse", "HEAD")).toBe(before);
            expect(readFileSync(join(second.cwd, "previous.txt"), "utf8")).toBe("previous");
          }),
        );
      }
    }),
  );

  it.live(
    "the check runs outside the project's turn; a branch changed meanwhile is refused",
    () =>
      Effect.gen(function* () {
        for (const into of [false, true]) {
          for (const changed of [false, true]) {
            const root = projectsDir();
            yield* projects(
              root,
              Effect.gen(function* () {
                const p = yield* Projects;
                const target = into ? "vibevalley/task-42" : "main";
                if (into) yield* p.openBranch("demo", target);
                const place = yield* p.workplace("demo", 1, true, into ? target : "");
                const before = gitSync(join(root, "demo"), "rev-parse", target);
                const signal = projectsDir();
                const started = join(signal, "started");
                const release = join(signal, "release");
                mkdirSync(join(place.cwd, ".vibevalley"));
                write(join(place.cwd, ".vibevalley/check"), `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`, 0o755);
                const merging = yield* Effect.forkChild(Effect.result(into ? p.mergeInto(place, target) : p.merge(place)));
                while (!existsSync(started)) yield* Effect.sleep(20);
                yield* p.workplace("demo", 2, true, "").pipe(Effect.timeout(2000));
                if (changed) gitSync(place.cwd, "commit", "--allow-empty", "-m", "changed during check");
                writeFileSync(release, "");
                const result = yield* Fiber.join(merging);
                if (changed) {
                  expect(result._tag).toBe("Failure");
                  expect((result as { failure: Error }).failure.message).toMatch(/检查以后/);
                  expect(gitSync(join(root, "demo"), "rev-parse", target)).toBe(before);
                  expect(existsSync(place.cwd)).toBe(true);
                } else expect(result._tag).toBe("Success");
              }),
            );
          }
        }
      }),
    30_000,
  );

  it.effect("a local merge checks the tree with main's changes in it", () => {
    const root = projectsDir();
    return projects(
      root,
      Effect.gen(function* () {
        const p = yield* Projects;
        const place = yield* p.workplace("combined", 1, true, "");
        const path = join(root, "combined");
        writeFileSync(join(path, "main-only"), "main");
        gitSync(path, "add", ".");
        gitSync(path, "commit", "-qm", "main advanced");
        mkdirSync(join(place.cwd, ".vibevalley"));
        write(join(place.cwd, ".vibevalley/check"), "#!/bin/sh\ntest -f main-only\n", 0o755);
        yield* p.merge(place);
      }),
    );
  });

  it.effect("a project symlinked outside the work root is refused", () => {
    const root = projectsDir();
    const outside = projectsDir();
    repo(join(outside, "elsewhere"), 1, 0);
    symlinkSync(join(outside, "elsewhere"), join(root, "linked"));
    return projects(
      root,
      Effect.gen(function* () {
        expect((yield* Effect.flip((yield* Projects).workplace("linked", 1, true, ""))).message).toMatch(/工作目录里面/);
      }),
    );
  });
});

function execFileSyncEnv(cwd: string, env: Record<string, string>, ...args: string[]) {
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
}
