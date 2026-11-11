import { Clock, Context, DateTime, Effect, FileSystem, Layer, Option, Path, Predicate, Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { maxRunning } from "@vibevalley/protocol";
import { githubRepository, slice } from "@vibevalley/protocol/rules";

import { numberIn } from "#/base/order.ts";
import { reposDir, ServerConfig, worktreesDir } from "#/infra/config.ts";

import { checkRepository } from "./check.ts";
import { git, type GitError, gitOk, gitQuiet, gitRun, reason, run } from "./git.ts";
import { cloneTimeoutMs, githubOrigin, type GitHubRun, makeRepoGitHub, probeGitHub, runGitHub } from "./github.ts";
import { runGitLab } from "./hosting.ts";
import { publisher, type PublishNetwork } from "./publish.ts";
import { type GitHubPullSnapshot, makeGithubSnapshot } from "./pullSnapshot.ts";
import { asFarm, repository } from "./repository.ts";
import { activityOf, contributionsOf, countsOf, lexists, secondsOf, tokeiArgs, yearDays } from "./stats.ts";
import {
  type Merged,
  MergeFailure,
  type RepoFolder,
  RepoError,
  stackFiles,
  stackOf,
  type Workplace,
  type WorkplaceCleanup,
  type WorkplaceRelease,
} from "./workplace.ts";

export { activityOf, countsOf, githubOrigin, type GitHubRun, probeGitHub, tokeiArgs };

const fail = (message: string) => Effect.fail(RepoError.make({ message }));

// The end of a check's output is kept: a test run's verdict is there.
const runTimeoutMs = 10 * 60_000;
const runOutput = 3000;

const repoName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

export function repoProblem(req: T.NewRepo): string {
  if (!repoName.test(req.name)) return t("server.repo.badName");
  if (req.github !== undefined && !githubRepository(req.github)) return t("server.repo.badGithub");
  return "";
}

/** What a fresh repository ignores, so a first commit of an existing folder does not take its dependencies. */
const gitignore = "node_modules/\ndist/\nbuild/\n.env\n.env.*\n!.env.example\n.DS_Store\n__pycache__/\n*.pyc\n.pytest_cache/\n.venv/\n";

/** A merge's failure as the user reads it: git's own, or the one the merge already said. */
const failed = (e: MergeFailure | GitError | RepoError) => (Predicate.isTagged(e, "MergeFailure") ? e : MergeFailure.error(reason(e)));

const unchangedBranch = Effect.fnUntraced(function* (path: string, branch: string, checked: string) {
  if ((yield* repository(path).tip(branch)) !== checked) return yield* MergeFailure.failedCheck(t("server.repo.branchMoved"));
});

/** Cleanup cannot undo publication: its warning travels with the receipt, it does not replace it with a failure. */
const cleanupMerged = Effect.fnUntraced(function* (place: Workplace, path: string, branch: string) {
  const removed = yield* repository(path).removeWorktree(place.cwd, true);
  if (removed) return t("server.repo.mergedWorktreeLeft", { cwd: place.cwd, branch, why: removed });
  const deleted = yield* repository(path).deleteBranch(branch, true);
  if (deleted) return t("server.repo.mergedBranchLeft", { branch, why: deleted });
  return "";
});

export const issueBranch = (n: number) => `vibevalley/issue-${n}`;

const noTokei = () => t("server.repo.noTokei");

export class Repo extends Context.Service<
  Repo,
  {
    readonly root: string;
    readonly limit: number;
    readonly maxSessions: () => number;
    readonly validate: (req: T.NewRepo) => T.Validation;
    readonly create: (req: T.NewRepo) => Effect.Effect<RepoFolder, RepoError>;
    readonly list: () => Effect.Effect<RepoFolder[]>;
    readonly summary: (p: RepoFolder) => Effect.Effect<T.RepoSummary>;
    readonly summaries: () => Effect.Effect<T.RepoSummary[]>;
    readonly stack: (name: string) => Effect.Effect<T.RepoStack | undefined>;
    readonly languages: (name: string) => Effect.Effect<T.RepoLanguages | undefined, RepoError>;
    readonly activity: (name: string) => Effect.Effect<T.RepoActivity | undefined>;
    readonly contributions: (extra: readonly string[]) => Effect.Effect<T.Repo[]>;
    readonly workplace: (repo: string, issueNumber: number, worktree: boolean, baseBranch: string) => Effect.Effect<Workplace, RepoError>;
    readonly changes: (place: Workplace) => Effect.Effect<T.Changes, RepoError>;
    readonly branchChanges: (repo: string, branch: string) => Effect.Effect<T.Changes | undefined, RepoError>;
    readonly changedFiles: (cwd: string, baseBranch: string) => Effect.Effect<string[], RepoError>;
    readonly conflict: (place: Workplace, baseBranch?: string) => Effect.Effect<T.Conflict | undefined>;
    readonly merge: (place: Workplace) => Effect.Effect<Merged, MergeFailure>;
    readonly mergeInto: (place: Workplace, target: string, targetCwd?: string) => Effect.Effect<Merged, MergeFailure>;
    readonly mergeBranch: (repo: string, branch: string) => Effect.Effect<string, MergeFailure>;
    readonly release: (place: Workplace) => Effect.Effect<WorkplaceRelease>;
    readonly reset: (place: Workplace) => Effect.Effect<void, RepoError>;
    readonly clear: (repo: string, issueNumber: number, work?: WorkplaceCleanup) => Effect.Effect<WorkplaceRelease>;
    readonly openBranch: (repo: string, branch: string, from?: string) => Effect.Effect<void, RepoError>;
    readonly run: (cwd: string, command: string) => Effect.Effect<{ readonly ok: boolean; readonly output: string }>;
    readonly houseRules: () => Effect.Effect<string>;
    readonly githubStatus: () => T.GitHubStatus;
    readonly refreshGitHub: () => Effect.Effect<T.GitHubStatus>;
    readonly usesPullRequests: (name: string) => boolean;
    readonly submitBranch: (req: T.SubmitBranch) => Effect.Effect<T.BranchPublication, MergeFailure | RepoError>;
    readonly submitPullRequest: (place: Workplace, issue: T.Issue, conclusion: string) => Effect.Effect<T.PullRequest, MergeFailure | RepoError>;
    readonly pullRequestState: (name: string, n: number) => Effect.Effect<T.PullRequestState, RepoError>;
    readonly githubSnapshot: (name: string, n: number) => Effect.Effect<GitHubPullSnapshot, RepoError>;
    readonly githubRequest: GitHubRun;
    readonly githubRemote: (name: string) => Effect.Effect<string, RepoError>;
    readonly resolveReviewThread: (name: string, thread: string) => Effect.Effect<void, RepoError>;
    readonly finishPullRequest: (name: string, n: number) => Effect.Effect<Merged, RepoError>;
  }
>()("@vibevalley/server/modules/repo/repo") {
  static readonly layer = (hooks: RepoHooks = {}) => Layer.effect(Repo, make(hooks));
}

/** What tests change: gh, and git's network. */
export interface RepoHooks {
  readonly gh?: GitHubRun;
  readonly publication?: PublishNetwork;
  readonly glab?: GitHubRun;
  readonly command?: typeof run;
  readonly fetch?: (path: string, branch: string) => Effect.Effect<boolean>;
}

const make = (hooks: RepoHooks = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const root = reposDir(config);
    // A file call that fails where the sync one would have thrown: a defect, as before.
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dirname, join, resolve } = path;
    const exists = (path: string) => Effect.orDie(fs.exists(path));
    yield* Effect.orDie(fs.makeDirectory(root, { recursive: true }));
    const trees = worktreesDir(config);
    const perRepo = config.repo.maxSessions;
    const checkTimeoutMs = config.repo.checkTimeoutSeconds * 1000;
    const tokei = config.tokei || "tokei";
    const prRepos = new Set([...config.github.prRepos]);
    const gh = hooks.gh ?? runGitHub;

    // A repo's lock lives while someone holds it or waits for it, so a removed repo leaves none behind.
    const queues = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
    const serially = <A, E, R>(repo: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        repo = yield* fs.realPath(resolve(root, repo)).pipe(Effect.orElseSucceed(() => resolve(root, repo)));
        let q = queues.get(repo);
        if (!q) {
          q = { lock: Semaphore.makeUnsafe(1), users: 0 };
          queues.set(repo, q);
        }
        const held = q;
        held.users++;
        return yield* held.lock
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (--held.users === 0) queues.delete(repo);
              }),
            ),
          );
      });
    const pending = new Set<string>();

    const ensure = Effect.fn("Repo.ensure")(
      function* (name: string) {
        if (!repoName.test(name)) return yield* fail(t("server.repo.notRepoName", { name }));
        yield* fs.makeDirectory(join(root, name), { recursive: true });
        // git answers with real paths (on macOS /tmp is /private/tmp): compare like with like.
        const path = yield* fs.realPath(join(root, name));
        if (dirname(path) !== (yield* fs.realPath(root))) return yield* fail(t("server.repo.outside"));
        // A folder is a repository's top when it holds .git (a folder, or a file in a worktree).
        if (!(yield* exists(join(path, ".git")))) {
          yield* git(path, "init", "-q", "-b", "main");
          if (!(yield* exists(join(path, ".gitignore")))) yield* fs.writeFileString(join(path, ".gitignore"), gitignore);
          if ((yield* fs.readDirectory(path)).filter((e) => e !== ".git").length <= 1) yield* fs.writeFileString(join(path, "README.md"), `# ${name}\n`);
          yield* git(path, "add", "-A");
          yield* repository(path).commit(t("server.repo.commit.initial"));
        } else if (!(yield* gitOk(path, "rev-parse", "--verify", "HEAD"))) {
          yield* git(path, "commit", "-q", "--allow-empty", "-m", t("server.repo.commit.initialShort")).pipe(
            Effect.catch(() => repository(path).commit(t("server.repo.commit.initialShort"))),
          );
        }
        return path;
      },
      Effect.mapError((e) => (Predicate.isTagged(e, "RepoError") ? e : RepoError.make({ message: reason(e), cause: e }))),
    );

    const list = Effect.fn("Repo.list")(function* () {
      if (!(yield* exists(root))) return [];
      const out: RepoFolder[] = [];
      // The entries' own kinds, links not followed: a link to a folder is not a repo.
      const entries = yield* fs.readDirectoryEntries(root).pipe(Effect.orElseSucceed(() => []));
      for (const e of entries) {
        if (e.type !== "Directory" || e.name.startsWith(".") || pending.has(e.name)) continue;
        const real = yield* Effect.option(fs.realPath(join(root, e.name)));
        if (Option.isNone(real)) continue;
        const path = real.value;
        out.push({
          name: e.name,
          path,
          // As ensure reads it: .git here, not a process per repo on every listing (the orchestrator lists them on
          // every input).
          git: yield* exists(join(path, ".git")),
        });
      }
      return out;
    });

    const find = (name: string) => Effect.map(list(), (all) => all.find((p) => p.name === name));

    const maxSessions = () => (perRepo <= 0 || perRepo > maxRunning ? maxRunning : perRepo);

    const summary = Effect.fn("Repo.summary")(function* (p: RepoFolder) {
      const s: T.RepoSummary = {
        name: p.name,
        path: p.path,
        git: p.git,
        maxSessions: maxSessions(),
        pullRequest: github.capability(p.name),
      };
      if (p.git) {
        const gitQuiet2 = yield* gitQuiet(p.path, "log", "--all", "-1", "--format=%at");
        const last = secondsOf(gitQuiet2);
        if (last > 0) s.last = last;
      }
      return s;
    });

    const issueWorkplace = (name: string, n: number): Workplace & { readonly branch: string } => ({
      repo: name,
      cwd: join(trees, `${name}.${n}`),
      branch: issueBranch(n),
    });

    /** Called under the repo's turn. Failing keeps the local main branch as the next issue's base. */
    const syncMain = Effect.fn("Repo.syncMain")(function* (name: string) {
      const path = join(root, name);
      const remoteHead = yield* gitRun(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
      const main = remoteHead.code === 0 ? remoteHead.stdout.trim().replace(/^origin\//u, "") : yield* repository(path).mainOrNone;
      const kept = Effect.as(Effect.logWarning(`repo ${name}: could not fast-forward main from origin, keeping the local main`), main);
      if (main === "") return yield* kept;
      const fetched = hooks.fetch
        ? yield* hooks.fetch(path, main)
        : (yield* run("git", ["fetch", "origin", main], { cwd: path, timeoutMs: cloneTimeoutMs })).code === 0;
      if (!fetched) return yield* kept;
      const status = yield* gitRun(path, "status", "--porcelain");
      if (status.code !== 0 || status.stdout.trim() !== "") return yield* kept;
      const local = yield* gitRun(path, "rev-parse", "refs/heads/" + main);
      const remote = yield* gitRun(path, "rev-parse", "FETCH_HEAD");
      if (local.code !== 0 || remote.code !== 0 || !(yield* repository(path).isAncestor(local.stdout.trim(), remote.stdout.trim()))) return yield* kept;
      const current = yield* repository(path).mainOrNone;
      const moved =
        current === main
          ? yield* gitRun(path, "merge", "--ff-only", remote.stdout.trim())
          : yield* gitRun(path, "update-ref", "refs/heads/" + main, remote.stdout.trim(), local.stdout.trim());
      return moved.code === 0 ? main : yield* kept;
    });

    const describe = (repo: string, cwd: string, branch: string | undefined) =>
      repository(join(root, repo))
        .describe(repo, cwd, branch)
        .pipe(Effect.mapError((e) => RepoError.make({ message: reason(e), cause: e })));

    /** Run outside the repo's turn, with the check's time limit. */
    const repoSetup = Effect.fn("Repo.repoSetup")(function* (cwd: string) {
      const file = join(cwd, ".vibevalley", "setup");
      if (!(yield* lexists(fs, file))) return;
      const r = yield* run(file, [], { cwd, timeoutMs: checkTimeoutMs });
      if (r.code !== 0) yield* Effect.logWarning(`${file} exited ${r.code}${r.timedOut ? " (timed out)" : ""}: ${(r.stdout + r.stderr).slice(-2000)}`);
    });

    const repoCheck = (cwd: string) => checkRepository(fs, cwd, checkTimeoutMs, hooks.command ?? run);

    /** The helper commits its own work: a merge or a PR starts only from a clean worktree, under the repository's own commit rules. */
    const requireCommitted = Effect.fnUntraced(function* (cwd: string) {
      if ((yield* repository(cwd).status) !== "") return yield* MergeFailure.error(t("server.repo.commit.uncommitted"));
    });

    /** Checks run outside the repo lock; publication rechecks the head and conflicts under it. */
    const checkMerge = Effect.fn("Repo.checkMerge")(function* (place: Workplace, branch: string, target: string) {
      yield* requireCommitted(place.cwd);
      const path = join(root, place.repo);
      const into = target || (yield* repository(path).main);
      const checked = yield* repository(path).tip(branch);
      const conflicts = yield* repository(path).conflicts(into, checked);
      if (conflicts.length > 0) return yield* MergeFailure.conflict(into, conflicts);
      yield* repoCheck(place.cwd);
      return checked;
    });

    const checkLocalMerge = Effect.fn("Repo.checkLocalMerge")(function* (place: Workplace, branch: string) {
      yield* requireCommitted(place.cwd);
      const path = join(root, place.repo);
      const main = yield* serially(
        place.repo,
        Effect.gen(function* () {
          const main = yield* repository(path).main;
          const files = yield* repository(path).conflicts(main, branch);
          if (files.length > 0) return yield* MergeFailure.conflict(main, files);
          yield* git(place.cwd, ...asFarm, "merge", "--no-edit", main);
          return main;
        }),
      );
      return yield* checkMerge(place, branch, main);
    });

    /** main: the branch checked out in the repo, when the caller has just read it under the same turn. */
    const mergeMain = Effect.fn("Repo.mergeMain")(function* (path: string, branch: string, kept: string, checkedOut?: string) {
      const main = checkedOut ?? (yield* repository(path).main);
      // A merge that would conflict is not tried: the session resolves it on its branch first.
      const conflicts = yield* repository(path).conflicts(main, branch);
      if (conflicts.length > 0) return yield* MergeFailure.conflict(main, conflicts);
      const ahead = yield* repository(path).ahead(main, branch);
      if (ahead > 0) {
        const merged = yield* gitRun(path, "merge", "--no-edit", branch);
        if (merged.code !== 0) {
          const aborted = yield* gitRun(path, "merge", "--abort");
          if (aborted.code !== 0) return yield* fail(t("server.repo.mergeStuck", { main, kept, why: reason(merged.stderr), abort: reason(aborted.stderr) }));
          return yield* fail(t("server.repo.mergeFailed", { main, kept, why: reason(merged.stderr) }));
        }
      }
      return { main, ahead };
    });

    const toMergeFailure = <A, R>(e: Effect.Effect<A, MergeFailure | GitError | RepoError, R>) => Effect.mapError(e, failed);
    const submitBranch = publisher({
      fs,
      path,
      gh,
      glab: hooks.glab ?? runGitLab,
      timeoutMs: checkTimeoutMs,
      command: hooks.command ?? run,
      network: hooks.publication,
      serially,
    });
    const github = makeRepoGitHub({
      root,
      fs,
      path,
      gh,
      submitBranch,
      prRepos,
      list,
      exists,
      serially,
      issueBranch,
      issueWorkplace,
      syncMain,
    });
    const { capability: _capability, ...githubMethods } = github;
    const githubSnapshot = makeGithubSnapshot(gh, github.githubRemote);

    const shape = Repo.of({
      githubSnapshot,
      root,
      submitBranch,
      limit: perRepo,
      maxSessions,
      validate: (req) => ({ problem: repoProblem(req) }),
      create: Effect.fn("Repo.create")(function* (req) {
        return yield* serially(
          req.name,
          Effect.gen(function* () {
            const problem = repoProblem(req);
            if (problem) return yield* fail(problem);
            const path = join(root, req.name);
            // Exclusive creation also refuses existing empty folders and symlinks.
            yield* fs
              .makeDirectory(path)
              .pipe(Effect.catch((e) => fail(e.reason._tag === "AlreadyExists" ? t("server.repo.exists", { name: req.name }) : reason(e))));
            pending.add(req.name);
            const made = Effect.gen(function* () {
              const repoSpec = req.github !== undefined ? githubRepository(req.github) : undefined;
              if (repoSpec) {
                const { url } = repoSpec;
                const checked = github.githubStatus();
                const known = checked.checkedAt !== 0 ? checked : yield* github.refreshGitHub();
                if (known.loggedIn) {
                  if (!(yield* gh("repo", "clone", githubOrigin(url), path)).ok) return yield* fail(t("server.repo.cloneFailedGh"));
                } else {
                  const cloned = yield* run("git", ["-c", "credential.helper=", "-c", "core.askPass=", "clone", "--", url, path], {
                    cwd: root,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
                    timeoutMs: cloneTimeoutMs,
                  });
                  if (cloned.code !== 0) return yield* fail(t("server.repo.cloneFailed"));
                }
              } else yield* ensure(req.name);
              return { name: req.name, path, git: true };
            });
            return yield* made.pipe(
              Effect.tapError(() => Effect.ignore(fs.remove(path, { recursive: true }), { log: "Warn" })),
              Effect.ensuring(Effect.sync(() => pending.delete(req.name))),
            );
          }),
        );
      }),
      list,
      summary,
      summaries: Effect.fn("Repo.summaries")(function* () {
        const found = yield* list();
        return yield* Effect.forEach(found, summary);
      }),
      stack: Effect.fn("Repo.stack")(function* (name) {
        const p = yield* find(name);
        if (!p) return undefined;
        const read = yield* Effect.forEach(stackFiles, (f) => Effect.map(Effect.option(fs.readFileString(join(p.path, f))), (body) => [f, body] as const));
        return stackOf(new Map(read.flatMap(([f, body]) => (Option.isSome(body) ? [[f, body.value] as const] : []))));
      }),
      languages: Effect.fn("Repo.languages")(function* (name) {
        const p = yield* find(name);
        if (!p) return undefined;
        const r = yield* run(tokei, tokeiArgs(p.path), { timeoutMs: 60_000 });
        if (r.missing) return yield* fail(noTokei());
        if (r.code !== 0) return yield* fail(t("server.repo.tokeiFailed", { why: reason(r.stderr) }));
        const languages = countsOf(r.stdout);
        if (!languages) return yield* fail(t("server.repo.tokeiUnread"));
        return { repo: name, at: yield* Clock.currentTimeMillis, languages };
      }),
      activity: Effect.fn("Repo.activity")(function* (name) {
        const p = yield* find(name);
        if (!p) return undefined;
        const now = yield* Clock.currentTimeMillis;
        const out: T.RepoActivity = {
          repo: name,
          at: now,
          days: [],
          authors: [],
          total: 0,
        };
        if (!p.git) return out;
        const since = DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(now), { days: yearDays }));
        const log = yield* gitQuiet(p.path, "log", "--all", "--no-merges", "--since=" + since, "--format=%at%x09%aN");
        const total = yield* gitQuiet(p.path, "rev-list", "--all", "--no-merges", "--count");
        const roots = yield* gitQuiet(p.path, "log", "--all", "--max-parents=0", "--format=%at");
        const gitQuiet2 = yield* gitQuiet(p.path, "log", "--all", "-1", "--format=%at");
        const last = secondsOf(gitQuiet2);
        Object.assign(out, activityOf(log), { total: numberIn(total) });
        const first = Math.min(
          ...roots
            .split("\n")
            .map(secondsOf)
            .filter((x) => x > 0),
        );
        if (Number.isFinite(first)) out.first = first;
        if (last > 0) out.last = last;
        return out;
      }),
      contributions: (extra) => contributionsOf(fs, path, root, extra),
      workplace: Effect.fn("Repo.workplace")(
        function* (repo, issueNumber, worktree, baseBranch) {
          let made = false;
          return yield* serially(
            repo,
            Effect.gen(function* () {
              const path = yield* ensure(repo);
              if (!worktree) return { repo, cwd: path };
              const place = issueWorkplace(repo, issueNumber);
              const { branch, cwd } = place;
              if (yield* exists(cwd)) {
                if (
                  !(yield* repository(path).worktrees).includes("branch refs/heads/" + branch + "\0") ||
                  (yield* repository(cwd).commonDirectory) !== (yield* repository(path).commonDirectory) ||
                  (yield* repository(cwd).main) !== branch
                )
                  return yield* fail(t("server.repo.github.wrongBranch"));
                return place;
              }
              yield* fs.makeDirectory(trees, { recursive: true });
              const branchThere = yield* repository(path)
                .hasBranch(branch)
                .pipe(Effect.orElseSucceed(() => false));
              let from = baseBranch;
              if (!branchThere && github.usesPullRequests(repo)) {
                const main = yield* syncMain(repo);
                from ||= main;
              }
              yield* repository(path).addWorktree(cwd, branch, branchThere ? undefined : from || "HEAD");
              made = true;
              return { repo, cwd, branch };
            }),
          ).pipe(Effect.tap((place) => (made ? repoSetup(place.cwd) : Effect.void)));
        },
        Effect.mapError((e) => (Predicate.isTagged(e, "RepoError") ? e : RepoError.make({ message: reason(e), cause: e }))),
      ),
      changes: Effect.fn("Repo.changes")(function* (place) {
        return yield* describe(place.repo, place.cwd, place.branch);
      }),
      branchChanges: Effect.fn("Repo.branchChanges")(function* (repo, branch) {
        // An issue worked in a profile's own folder has no repo, and so no issue branch: none to read.
        if (!repo) return undefined;
        const path = join(root, repo);
        const present = yield* repository(path)
          .hasBranch(branch)
          .pipe(Effect.catch((e) => fail(t("server.repo.noBranchRead", { branch, why: reason(e) }))));
        if (!present) return undefined;
        return yield* describe(repo, "", branch);
      }),
      changedFiles: Effect.fn("Repo.changedFiles")(
        function* (cwd, baseBranch) {
          const fork = yield* git(cwd, "merge-base", baseBranch, "HEAD");
          const changed = yield* git(cwd, "diff", "--name-only", "--no-renames", fork);
          const added = yield* git(cwd, "ls-files", "--others", "--exclude-standard");
          return [...new Set(`${changed}\n${added}`.split("\n").filter((f) => f !== ""))].toSorted();
        },
        Effect.mapError((e) => RepoError.make({ message: reason(e), cause: e })),
      ),
      conflict: Effect.fn("Repo.conflict")(function* (place, baseBranch = "") {
        if (!place.branch) return undefined;
        const path = join(root, place.repo);
        const base = baseBranch || (yield* repository(path).mainOrNone);
        if (!base) return undefined;
        const files = yield* repository(path)
          .conflicts(base, place.branch)
          .pipe(Effect.orElseSucceed((): string[] => []));
        return files.length > 0 ? { base, files } : undefined;
      }),
      merge: Effect.fn("Repo.merge")(function* (place) {
        const branch = place.branch;
        if (!branch) return { text: t("server.repo.inRepoNoBranch"), commits: 0 };
        const path = join(root, place.repo);
        const checked = yield* checkLocalMerge(place, branch);
        return yield* serially(
          place.repo,
          Effect.gen(function* () {
            yield* unchangedBranch(path, branch, checked);
            const head = yield* repository(path).main;
            if (!(yield* repository(path).isAncestor(head, checked))) return yield* MergeFailure.failedCheck(t("server.repo.mainMoved"));
            const { main, ahead } = yield* mergeMain(path, branch, t("server.repo.keptBoth", { branch }), head);
            const warning = yield* cleanupMerged(place, path, branch);
            return {
              text: ahead > 0 ? t("server.repo.merged", { ahead, repo: place.repo, main }) : t("server.repo.nothingNew"),
              commits: ahead,
              ...(warning ? { warning } : {}),
            };
          }),
        );
      }, toMergeFailure),
      mergeInto: Effect.fn("Repo.mergeInto")(function* (place, target, targetCwd) {
        const path = join(root, place.repo);
        const branch = place.branch;
        if (!branch) return yield* MergeFailure.error(t("server.repo.inRepoNothing"));
        const checked = yield* checkMerge(place, branch, target);
        return yield* serially(
          place.repo,
          Effect.gen(function* () {
            yield* unchangedBranch(path, branch, checked);
            if (targetCwd) {
              if ((yield* repository(targetCwd).main) !== target) return yield* MergeFailure.error(t("server.repo.parentBranchChanged"));
              if ((yield* git(targetCwd, "status", "--porcelain")) !== "") return yield* MergeFailure.failedCheck(t("server.repo.parentHasChanges"));
            }
            const conflicts = yield* repository(path).conflicts(target, branch);
            if (conflicts.length > 0) return yield* MergeFailure.conflict(target, conflicts);
            const brought = (yield* git(path, "log", "--reverse", "--format=%h", `${target}..${branch}`)).split("\n").filter((s) => s !== "");
            if (brought.length > 0) {
              const ours = yield* repository(path).tip(target);
              const theirs = yield* git(path, "rev-parse", branch);
              const next = (yield* repository(path).isAncestor(ours, theirs))
                ? theirs
                : yield* repository(path).mergeCommit(ours, theirs, t("server.repo.commit.merge", { branch }));
              // Only from where it was: a target moved meanwhile is not written over.
              if (targetCwd) yield* git(targetCwd, "merge", "--ff-only", "--no-edit", next);
              else yield* git(path, "update-ref", "refs/heads/" + target, next, ours);
            }
            const warning = yield* cleanupMerged(place, path, branch);
            return {
              text: "",
              commits: brought.length,
              hashes: brought,
              ...(warning ? { warning } : {}),
            };
          }),
        );
      }, toMergeFailure),
      mergeBranch: Effect.fn("Repo.mergeBranch")(function* (repo, branch) {
        return yield* serially(
          repo,
          Effect.gen(function* () {
            const path = join(root, repo);
            const { main, ahead } = yield* mergeMain(path, branch, t("server.repo.keptBranch", { branch }));
            let said = ahead > 0 ? t("server.repo.merged", { ahead, repo, main }) : t("server.repo.nothingNewInPlan");
            const deleted = yield* repository(path).deleteBranch(branch);
            if (deleted) said += t("server.repo.branchLeft", { branch, why: deleted });
            return said;
          }),
        );
      }, toMergeFailure),
      release: Effect.fn("Repo.release")(function* (place) {
        return yield* serially<WorkplaceRelease, never, never>(
          place.repo,
          Effect.gen(function* () {
            if (!place.branch) return { kept: false };
            const path = join(root, place.repo);
            // A worktree with changes stays where it is: removing it would lose them.
            if (yield* repository(path).removeWorktree(place.cwd, false))
              return {
                kept: true,
                reason: t("server.repo.clear.uncommitted", { branch: place.branch, cwd: place.cwd }),
              };
            // A branch with nothing new on it is clutter; one with commits is kept, so nothing is lost.
            const main = (yield* repository(path).mainOrNone) || "main";
            // A count git cannot give is taken as commits on it: kept rather than lost.
            const ahead = yield* repository(path)
              .ahead(main, place.branch)
              .pipe(Effect.orElseSucceed(() => 1));
            if (ahead === 0) {
              const removed = yield* repository(path).deleteBranch(place.branch);
              return removed ? { kept: true, reason: t("server.repo.clear.branchLeft", { branch: place.branch, why: removed }) } : { kept: false };
            }
            return {
              kept: true,
              reason: t("server.repo.clear.unmerged", { branch: place.branch, ahead }),
            };
          }),
        );
      }),
      reset: Effect.fn("Repo.reset")(function* (place) {
        const branch = place.branch;
        if (!branch) return yield* fail(t("server.repo.clear.notWorktree", { cwd: place.cwd }));
        yield* serially(
          place.repo,
          Effect.gen(function* () {
            const main = yield* repository(join(root, place.repo)).main;
            yield* git(place.cwd, "checkout", "-q", "-f", "-B", branch, main);
            yield* git(place.cwd, "clean", "-q", "-f", "-d");
          }).pipe(Effect.mapError((e) => RepoError.make({ message: reason(e), cause: e }))),
        );
      }),
      clear: Effect.fn("Repo.clear")(function* (repo, issueNumber, work = "discard") {
        return yield* serially<WorkplaceRelease, never, never>(
          repo,
          Effect.gen(function* (): Effect.fn.Return<WorkplaceRelease> {
            const path = join(root, repo);
            const place = issueWorkplace(repo, issueNumber);
            if (yield* exists(place.cwd)) {
              const removed = yield* repository(path).removeWorktree(place.cwd, work === "discard");
              if (removed)
                return {
                  kept: true as const,
                  reason: t("server.repo.clear.worktreeLeft", { cwd: place.cwd, why: removed }),
                };
            }
            if (!(yield* exists(path))) return { kept: false as const };
            return yield* Effect.matchEffect(repository(path).hasBranch(place.branch), {
              onFailure: (e) => Effect.succeed({ kept: true as const, reason: t("server.repo.clear.unconfirmed", { branch: place.branch, why: reason(e) }) }),
              onSuccess: (has) =>
                Effect.gen(function* () {
                  if (!has) return { kept: false as const };
                  const main = (yield* repository(path).mainOrNone) || "main";
                  const ahead = yield* repository(path)
                    .ahead(main, place.branch)
                    .pipe(Effect.orElseSucceed(() => 1));
                  if (ahead !== 0) return { kept: true as const, reason: t("server.repo.clear.unmergedKept", { branch: place.branch }) };
                  const removed = yield* repository(path).deleteBranch(place.branch);
                  return removed
                    ? { kept: true as const, reason: t("server.repo.clear.branchLeft", { branch: place.branch, why: removed }) }
                    : { kept: false as const };
                }),
            });
          }),
        );
      }),
      openBranch: Effect.fn("Repo.openBranch")(function* (repo, branch, from = "") {
        return yield* serially(
          repo,
          Effect.gen(function* () {
            const path = yield* ensure(repo);
            yield* git(path, "branch", branch, from || "HEAD").pipe(Effect.mapError((e) => RepoError.make({ message: reason(e), cause: e })));
          }),
        );
      }),
      run: Effect.fn("Repo.run")(function* (cwd, command) {
        const r = yield* run("sh", ["-c", command], { cwd, timeoutMs: runTimeoutMs });
        let output = (r.stdout + r.stderr).trimEnd();
        if (output.length > runOutput) output = "…" + slice(output, -runOutput);
        return { ok: r.code === 0, output };
      }),
      houseRules: Effect.fn("Repo.houseRules")(function* () {
        return yield* Effect.orElseSucceed(fs.readFileString(join(resolve(config.workRoot), "AGENTS.md")), () => "");
      }),
      ...githubMethods,
    });
    return shape;
  });

/** As the server starts: a first look at GitHub; the page asks again with github.refresh. */
export const start = Layer.effectDiscard(Effect.flatMap(Repo, (p) => Effect.forkScoped(p.refreshGitHub())));
