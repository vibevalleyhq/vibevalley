import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isAbort, Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { maxRunning } from "@vibevalley/protocol";
import { githubRepository, slice } from "@vibevalley/protocol/rules";

import { errnoOf } from "#/base/errors.ts";
import { numberIn } from "#/base/order.ts";
import { reposDir, type ServerConfig, worktreesDir } from "#/infra/config.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";

import { checkRepository } from "./check.ts";
import { GitError, gitWith, reason, run } from "./git.ts";
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

const fail = (message: string) => new RepoError(message);

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

/** A merge's failure as the user reads it: git's own, or the one the merge already said. Anything else (an abort, a
 * defect) goes on as it is. */
const failed = (e: unknown): unknown => (e instanceof MergeFailure ? e : e instanceof GitError || e instanceof RepoError ? MergeFailure.error(reason(e)) : e);

const toMergeFailure = async <A>(work: () => Promise<A>): Promise<A> => {
  try {
    return await work();
  } catch (e) {
    throw failed(e);
  }
};

/** Git's or the file system's failure as a RepoError; a RepoError and an abort go on as they are. */
const asRepoError = (e: unknown, signal?: AbortSignal): unknown => (e instanceof RepoError || isAbort(e, signal) ? e : new RepoError(reason(e), { cause: e }));

const repoErrors = async <A>(work: () => Promise<A>, signal?: AbortSignal): Promise<A> => {
  try {
    return await work();
  } catch (e) {
    throw asRepoError(e, signal);
  }
};

/** What a git call answers, or fallback when git cannot say (a GitError); anything else goes on. */
const orWhenGitFails = async <A>(work: Promise<A>, fallback: A): Promise<A> => {
  try {
    return await work;
  } catch (e) {
    if (e instanceof GitError) return fallback;
    throw e;
  }
};

const unchangedBranch = async (path: string, branch: string, checked: string, signal?: AbortSignal) => {
  if ((await repository(path, signal).tip(branch)) !== checked) throw MergeFailure.failedCheck(t("server.repo.branchMoved"));
};

/** Cleanup cannot undo publication: its warning travels with the receipt, it does not replace it with a failure. */
const cleanupMerged = async (place: Workplace, path: string, branch: string, signal?: AbortSignal) => {
  const removed = await repository(path, signal).removeWorktree(place.cwd, true);
  if (removed) return t("server.repo.mergedWorktreeLeft", { cwd: place.cwd, branch, why: removed });
  const deleted = await repository(path, signal).deleteBranch(branch, true);
  if (deleted) return t("server.repo.mergedBranchLeft", { branch, why: deleted });
  return "";
};

export const issueBranch = (n: number) => `vibevalley/issue-${n}`;

const noTokei = () => t("server.repo.noTokei");

/** Whether path is there; a failure other than its absence is not one to answer for. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (e) {
    const code = errnoOf(e);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
};

/** Where an issue's checkout is: a worktree on the issue's branch forked from base ("" for main), or the repo's own
 * folder. */
export interface CheckoutAt {
  readonly repo: string;
  readonly issue: number;
  readonly worktree: boolean;
  readonly base: string;
  readonly signal?: AbortSignal;
}

/** The repositories under the work root, their worktrees, checks, merges and pull requests. Long operations take a
 * signal: aborting stops the git commands and the check they run. */
export interface Repo {
  readonly root: string;
  readonly limit: number;
  readonly maxSessions: () => number;
  readonly validate: (req: T.NewRepo) => T.Validation;
  readonly create: (req: T.NewRepo, signal?: AbortSignal) => Promise<RepoFolder>;
  readonly list: () => Promise<RepoFolder[]>;
  readonly summary: (p: RepoFolder) => Promise<T.RepoSummary>;
  readonly summaries: () => Promise<T.RepoSummary[]>;
  readonly stack: (name: string) => Promise<T.RepoStack | undefined>;
  readonly languages: (name: string, signal?: AbortSignal) => Promise<T.RepoLanguages | undefined>;
  readonly activity: (name: string) => Promise<T.RepoActivity | undefined>;
  readonly contributions: (extra: readonly string[]) => Promise<T.Repo[]>;
  /** An issue's checkout, made when it is not there yet; only the session module makes and lets go of them. */
  readonly checkout: (at: CheckoutAt) => Promise<Workplace>;
  /** A checkout let go: kept when it holds work, and said why. */
  readonly releaseCheckout: (place: Workplace) => Promise<WorkplaceRelease>;
  /** A checkout's branch reset to main while it stays. */
  readonly resetCheckout: (place: Workplace) => Promise<void>;
  /** An issue's checkout cleared once no helper is on its issue (work "discard" by default). */
  readonly clearCheckout: (repo: string, issue: number, work?: WorkplaceCleanup) => Promise<WorkplaceRelease>;
  readonly changes: (place: Workplace) => Promise<T.Changes>;
  readonly branchChanges: (repo: string, branch: string) => Promise<T.Changes | undefined>;
  readonly changedFiles: (cwd: string, baseBranch: string) => Promise<string[]>;
  readonly conflict: (place: Workplace, baseBranch?: string) => Promise<T.Conflict | undefined>;
  readonly merge: (place: Workplace, signal?: AbortSignal) => Promise<Merged>;
  readonly mergeInto: (place: Workplace, target: string, targetCwd?: string, signal?: AbortSignal) => Promise<Merged>;
  readonly mergeBranch: (repo: string, branch: string, signal?: AbortSignal) => Promise<string>;
  readonly openBranch: (repo: string, branch: string, from?: string) => Promise<void>;
  readonly run: (cwd: string, command: string, signal?: AbortSignal) => Promise<{ readonly ok: boolean; readonly output: string }>;
  readonly houseRules: () => Promise<string>;
  readonly githubStatus: () => T.GitHubStatus;
  readonly refreshGitHub: () => Promise<T.GitHubStatus>;
  readonly usesPullRequests: (name: string) => boolean;
  readonly submitBranch: (req: T.SubmitBranch, signal?: AbortSignal) => Promise<T.BranchPublication>;
  readonly submitPullRequest: (place: Workplace, issue: T.Issue, conclusion: string, signal?: AbortSignal) => Promise<T.PullRequest>;
  readonly pullRequestState: (name: string, n: number) => Promise<T.PullRequestState>;
  readonly githubSnapshot: (name: string, n: number) => Promise<GitHubPullSnapshot>;
  readonly githubRequest: GitHubRun;
  readonly githubRemote: (name: string) => Promise<string>;
  readonly resolveReviewThread: (name: string, thread: string) => Promise<void>;
  readonly finishPullRequest: (name: string, n: number) => Promise<Merged>;
  /** As the server starts: a first look at GitHub, in the background; the page asks again with github.refresh. */
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** What tests change: gh, and git's network. */
export interface RepoHooks {
  readonly gh?: GitHubRun;
  readonly publication?: PublishNetwork;
  readonly glab?: GitHubRun;
  readonly command?: typeof run;
  readonly fetch?: (path: string, branch: string) => Promise<boolean>;
}

export interface RepoDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
}

export async function makeRepo(deps: RepoDeps, hooks: RepoHooks = {}): Promise<Repo> {
  const { config, clock } = deps;
  const log = deps.log.child("repo");
  const tasks = new TaskGroup({ name: "repo", onError: (task, e) => log.warn(`${task} failed`, e) });
  const root = reposDir(config);
  await mkdir(root, { recursive: true });
  const trees = worktreesDir(config);
  const perRepo = config.repo.maxSessions;
  const checkTimeoutMs = config.repo.checkTimeoutSeconds * 1000;
  const tokei = config.tokei || "tokei";
  const prRepos = new Set([...config.github.prRepos]);
  const gh = hooks.gh ?? runGitHub;

  // A repo's lock lives while someone holds it or waits for it, so a removed repo leaves none behind.
  const queues = new Map<string, { readonly lock: Semaphore; users: number }>();
  const serially = async <A>(name: string, work: () => Promise<A>, signal?: AbortSignal): Promise<A> => {
    let key: string;
    try {
      key = await realpath(resolve(root, name));
    } catch {
      // Not there yet (a repo being created): its lock is under the path it will have.
      key = resolve(root, name);
    }
    let q = queues.get(key);
    if (!q) {
      q = { lock: new Semaphore(1), users: 0 };
      queues.set(key, q);
    }
    const held = q;
    held.users++;
    try {
      return await held.lock.with(work, 1, signal);
    } finally {
      if (--held.users === 0) queues.delete(key);
    }
  };
  const pending = new Set<string>();

  const ensure = (name: string, signal?: AbortSignal): Promise<string> =>
    repoErrors(async () => {
      const { git, gitOk } = gitWith(signal);
      if (!repoName.test(name)) throw fail(t("server.repo.notRepoName", { name }));
      await mkdir(join(root, name), { recursive: true });
      // git answers with real paths (on macOS /tmp is /private/tmp): compare like with like.
      const path = await realpath(join(root, name));
      if (dirname(path) !== (await realpath(root))) throw fail(t("server.repo.outside"));
      // A folder is a repository's top when it holds .git (a folder, or a file in a worktree).
      if (!(await exists(join(path, ".git")))) {
        await git(path, "init", "-q", "-b", "main");
        if (!(await exists(join(path, ".gitignore")))) await writeFile(join(path, ".gitignore"), gitignore);
        if ((await readdir(path)).filter((e) => e !== ".git").length <= 1) await writeFile(join(path, "README.md"), `# ${name}\n`);
        await git(path, "add", "-A");
        await repository(path, signal).commit(t("server.repo.commit.initial"));
      } else if (!(await gitOk(path, "rev-parse", "--verify", "HEAD"))) {
        try {
          await git(path, "commit", "-q", "--allow-empty", "-m", t("server.repo.commit.initialShort"));
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          await repository(path, signal).commit(t("server.repo.commit.initialShort"));
        }
      }
      return path;
    }, signal);

  const list = async (): Promise<RepoFolder[]> => {
    if (!(await exists(root))) return [];
    const out: RepoFolder[] = [];
    // The entries' own kinds, links not followed: a link to a folder is not a repo.
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (e) {
      log.warn("the repos folder could not be read", e);
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || pending.has(e.name)) continue;
      let path: string;
      try {
        path = await realpath(join(root, e.name));
      } catch {
        // Gone since the listing: not a repo any more.
        continue;
      }
      out.push({
        name: e.name,
        path,
        // As ensure reads it: .git here, not a process per repo on every listing (the orchestrator lists them on
        // every input).
        git: await exists(join(path, ".git")),
      });
    }
    return out;
  };

  const find = async (name: string) => (await list()).find((p) => p.name === name);

  const maxSessions = () => (perRepo <= 0 || perRepo > maxRunning ? maxRunning : perRepo);

  const summary = async (p: RepoFolder): Promise<T.RepoSummary> => {
    const s: T.RepoSummary = {
      name: p.name,
      path: p.path,
      git: p.git,
      maxSessions: maxSessions(),
      pullRequest: github.capability(p.name),
    };
    if (p.git) {
      const last = secondsOf(await gitWith().gitQuiet(p.path, "log", "--all", "-1", "--format=%at"));
      if (last > 0) s.last = last;
    }
    return s;
  };

  const issueWorkplace = (name: string, n: number): Workplace & { readonly branch: string } => ({
    repo: name,
    cwd: join(trees, `${name}.${n}`),
    branch: issueBranch(n),
  });

  /** Called under the repo's turn. Failing keeps the local main branch as the next issue's base. */
  const syncMain = async (name: string): Promise<string> => {
    const { gitRun } = gitWith();
    const path = join(root, name);
    const remoteHead = await gitRun(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    const main = remoteHead.code === 0 ? remoteHead.stdout.trim().replace(/^origin\//u, "") : await repository(path).mainOrNone();
    const kept = () => {
      log.warn(`repo ${name}: could not fast-forward main from origin, keeping the local main`);
      return main;
    };
    if (main === "") return kept();
    const fetched = hooks.fetch
      ? await hooks.fetch(path, main)
      : (await run("git", ["fetch", "origin", main], { cwd: path, timeoutMs: cloneTimeoutMs })).code === 0;
    if (!fetched) return kept();
    const status = await gitRun(path, "status", "--porcelain");
    if (status.code !== 0 || status.stdout.trim() !== "") return kept();
    const local = await gitRun(path, "rev-parse", "refs/heads/" + main);
    const remote = await gitRun(path, "rev-parse", "FETCH_HEAD");
    if (local.code !== 0 || remote.code !== 0 || !(await repository(path).isAncestor(local.stdout.trim(), remote.stdout.trim()))) return kept();
    const current = await repository(path).mainOrNone();
    const moved =
      current === main
        ? await gitRun(path, "merge", "--ff-only", remote.stdout.trim())
        : await gitRun(path, "update-ref", "refs/heads/" + main, remote.stdout.trim(), local.stdout.trim());
    return moved.code === 0 ? main : kept();
  };

  const describe = (repo: string, cwd: string, branch: string | undefined) => repoErrors(() => repository(join(root, repo)).describe(repo, cwd, branch));

  /** Run outside the repo's turn, with the check's time limit. */
  const repoSetup = async (cwd: string, signal?: AbortSignal) => {
    const file = join(cwd, ".vibevalley", "setup");
    if (!(await lexists(file))) return;
    const r = await run(file, [], { cwd, timeoutMs: checkTimeoutMs, ...(signal === undefined ? {} : { signal }) });
    if (r.code !== 0) log.warn(`${file} exited ${r.code}${r.timedOut ? " (timed out)" : ""}: ${(r.stdout + r.stderr).slice(-2000)}`);
  };

  const repoCheck = (cwd: string, signal?: AbortSignal) => checkRepository(cwd, checkTimeoutMs, hooks.command ?? run, signal);

  /** The helper commits its own work: a merge or a PR starts only from a clean worktree, under the repository's own commit rules. */
  const requireCommitted = async (cwd: string, signal?: AbortSignal) => {
    if ((await repository(cwd, signal).status()) !== "") throw MergeFailure.error(t("server.repo.commit.uncommitted"));
  };

  /** Checks run outside the repo lock; publication rechecks the head and conflicts under it. */
  const checkMerge = async (place: Workplace, branch: string, target: string, signal?: AbortSignal) => {
    await requireCommitted(place.cwd, signal);
    const at = repository(join(root, place.repo), signal);
    const into = target || (await at.main());
    const checked = await at.tip(branch);
    const conflicts = await at.conflicts(into, checked);
    if (conflicts.length > 0) throw MergeFailure.conflict(into, conflicts);
    await repoCheck(place.cwd, signal);
    return checked;
  };

  const checkLocalMerge = async (place: Workplace, branch: string, signal?: AbortSignal) => {
    await requireCommitted(place.cwd, signal);
    const at = repository(join(root, place.repo), signal);
    const main = await serially(
      place.repo,
      async () => {
        const main = await at.main();
        const files = await at.conflicts(main, branch);
        if (files.length > 0) throw MergeFailure.conflict(main, files);
        await gitWith(signal).git(place.cwd, ...asFarm, "merge", "--no-edit", main);
        return main;
      },
      signal,
    );
    return checkMerge(place, branch, main, signal);
  };

  /** main: the branch checked out in the repo, when the caller has just read it under the same turn. */
  const mergeMain = async (path: string, branch: string, kept: string, checkedOut?: string, signal?: AbortSignal) => {
    const at = repository(path, signal);
    const { gitRun } = gitWith(signal);
    const main = checkedOut ?? (await at.main());
    // A merge that would conflict is not tried: the session resolves it on its branch first.
    const conflicts = await at.conflicts(main, branch);
    if (conflicts.length > 0) throw MergeFailure.conflict(main, conflicts);
    const ahead = await at.ahead(main, branch);
    if (ahead > 0) {
      const merged = await gitRun(path, "merge", "--no-edit", branch);
      if (merged.code !== 0) {
        const aborted = await gitRun(path, "merge", "--abort");
        if (aborted.code !== 0) throw fail(t("server.repo.mergeStuck", { main, kept, why: reason(merged.stderr), abort: reason(aborted.stderr) }));
        throw fail(t("server.repo.mergeFailed", { main, kept, why: reason(merged.stderr) }));
      }
    }
    return { main, ahead };
  };

  const submitBranch = publisher({
    gh,
    glab: hooks.glab ?? runGitLab,
    timeoutMs: checkTimeoutMs,
    command: hooks.command ?? run,
    network: hooks.publication,
    serially,
  });
  const github = makeRepoGitHub({
    root,
    clock,
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

  const create = (req: T.NewRepo, signal?: AbortSignal): Promise<RepoFolder> =>
    serially(
      req.name,
      async () => {
        const problem = repoProblem(req);
        if (problem) throw fail(problem);
        const path = join(root, req.name);
        // Exclusive creation also refuses existing empty folders and symlinks.
        try {
          await mkdir(path);
        } catch (e) {
          throw fail(errnoOf(e) === "EEXIST" ? t("server.repo.exists", { name: req.name }) : reason(e));
        }
        pending.add(req.name);
        try {
          const repoSpec = req.github !== undefined ? githubRepository(req.github) : undefined;
          if (repoSpec) {
            const { url } = repoSpec;
            const checked = github.githubStatus();
            const known = checked.checkedAt !== 0 ? checked : await github.refreshGitHub();
            if (known.loggedIn) {
              if (!(await gh("repo", "clone", githubOrigin(url), path)).ok) throw fail(t("server.repo.cloneFailedGh"));
            } else {
              const cloned = await run("git", ["-c", "credential.helper=", "-c", "core.askPass=", "clone", "--", url, path], {
                cwd: root,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
                timeoutMs: cloneTimeoutMs,
                ...(signal === undefined ? {} : { signal }),
              });
              if (cloned.code !== 0) throw fail(t("server.repo.cloneFailed"));
            }
          } else await ensure(req.name, signal);
          return { name: req.name, path, git: true };
        } catch (e) {
          await bestEffort(log, `the half-made repo ${path} could not be removed`, () => rm(path, { recursive: true, force: true }));
          throw e;
        } finally {
          pending.delete(req.name);
        }
      },
      signal,
    );

  const workplace = async (repo: string, issueNumber: number, worktree: boolean, baseBranch: string, signal?: AbortSignal): Promise<Workplace> => {
    let made = false;
    const place = await repoErrors(
      () =>
        serially(
          repo,
          async (): Promise<Workplace> => {
            const path = await ensure(repo, signal);
            if (!worktree) return { repo, cwd: path };
            const place = issueWorkplace(repo, issueNumber);
            const { branch, cwd } = place;
            const at = repository(path, signal);
            if (await exists(cwd)) {
              if (
                !(await at.worktrees()).includes("branch refs/heads/" + branch + "\0") ||
                (await repository(cwd, signal).commonDirectory()) !== (await at.commonDirectory()) ||
                (await repository(cwd, signal).main()) !== branch
              )
                throw fail(t("server.repo.github.wrongBranch"));
              return place;
            }
            await mkdir(trees, { recursive: true });
            const branchThere = await orWhenGitFails(at.hasBranch(branch), false);
            let from = baseBranch;
            if (!branchThere && github.usesPullRequests(repo)) {
              const main = await syncMain(repo);
              from ||= main;
            }
            await at.addWorktree(cwd, branch, branchThere ? undefined : from || "HEAD");
            made = true;
            return { repo, cwd, branch };
          },
          signal,
        ),
      signal,
    );
    if (made) await repoErrors(() => repoSetup(place.cwd, signal), signal);
    return place;
  };

  const merge = (place: Workplace, signal?: AbortSignal): Promise<Merged> =>
    toMergeFailure(async () => {
      const branch = place.branch;
      if (!branch) return { text: t("server.repo.inRepoNoBranch"), commits: 0 };
      const path = join(root, place.repo);
      const checked = await checkLocalMerge(place, branch, signal);
      return serially(
        place.repo,
        async () => {
          await unchangedBranch(path, branch, checked, signal);
          const at = repository(path, signal);
          const head = await at.main();
          if (!(await at.isAncestor(head, checked))) throw MergeFailure.failedCheck(t("server.repo.mainMoved"));
          const { main, ahead } = await mergeMain(path, branch, t("server.repo.keptBoth", { branch }), head, signal);
          const warning = await cleanupMerged(place, path, branch, signal);
          return {
            text: ahead > 0 ? t("server.repo.merged", { ahead, repo: place.repo, main }) : t("server.repo.nothingNew"),
            commits: ahead,
            ...(warning ? { warning } : {}),
          };
        },
        signal,
      );
    });

  const mergeInto = (place: Workplace, target: string, targetCwd?: string, signal?: AbortSignal): Promise<Merged> =>
    toMergeFailure(async () => {
      const path = join(root, place.repo);
      const branch = place.branch;
      if (!branch) throw MergeFailure.error(t("server.repo.inRepoNothing"));
      const checked = await checkMerge(place, branch, target, signal);
      return serially(
        place.repo,
        async () => {
          const { git } = gitWith(signal);
          const at = repository(path, signal);
          await unchangedBranch(path, branch, checked, signal);
          if (targetCwd) {
            if ((await repository(targetCwd, signal).main()) !== target) throw MergeFailure.error(t("server.repo.parentBranchChanged"));
            if ((await git(targetCwd, "status", "--porcelain")) !== "") throw MergeFailure.failedCheck(t("server.repo.parentHasChanges"));
          }
          const conflicts = await at.conflicts(target, branch);
          if (conflicts.length > 0) throw MergeFailure.conflict(target, conflicts);
          const brought = (await git(path, "log", "--reverse", "--format=%h", `${target}..${branch}`)).split("\n").filter((s) => s !== "");
          if (brought.length > 0) {
            const ours = await at.tip(target);
            const theirs = await git(path, "rev-parse", branch);
            const next = (await at.isAncestor(ours, theirs)) ? theirs : await at.mergeCommit(ours, theirs, t("server.repo.commit.merge", { branch }));
            // Only from where it was: a target moved meanwhile is not written over.
            if (targetCwd) await git(targetCwd, "merge", "--ff-only", "--no-edit", next);
            else await git(path, "update-ref", "refs/heads/" + target, next, ours);
          }
          const warning = await cleanupMerged(place, path, branch, signal);
          return {
            text: "",
            commits: brought.length,
            hashes: brought,
            ...(warning ? { warning } : {}),
          };
        },
        signal,
      );
    });

  const mergeBranch = (repo: string, branch: string, signal?: AbortSignal): Promise<string> =>
    toMergeFailure(() =>
      serially(
        repo,
        async () => {
          const path = join(root, repo);
          const { main, ahead } = await mergeMain(path, branch, t("server.repo.keptBranch", { branch }), undefined, signal);
          let said = ahead > 0 ? t("server.repo.merged", { ahead, repo, main }) : t("server.repo.nothingNewInPlan");
          const deleted = await repository(path, signal).deleteBranch(branch);
          if (deleted) said += t("server.repo.branchLeft", { branch, why: deleted });
          return said;
        },
        signal,
      ),
    );

  const release = (place: Workplace): Promise<WorkplaceRelease> =>
    serially(place.repo, async (): Promise<WorkplaceRelease> => {
      if (!place.branch) return { kept: false };
      const at = repository(join(root, place.repo));
      // A worktree with changes stays where it is: removing it would lose them.
      if (await at.removeWorktree(place.cwd, false))
        return {
          kept: true,
          reason: t("server.repo.clear.uncommitted", { branch: place.branch, cwd: place.cwd }),
        };
      // A branch with nothing new on it is clutter; one with commits is kept, so nothing is lost.
      const main = (await at.mainOrNone()) || "main";
      // A count git cannot give is taken as commits on it: kept rather than lost.
      const ahead = await orWhenGitFails(at.ahead(main, place.branch), 1);
      if (ahead === 0) {
        const removed = await at.deleteBranch(place.branch);
        return removed ? { kept: true, reason: t("server.repo.clear.branchLeft", { branch: place.branch, why: removed }) } : { kept: false };
      }
      return {
        kept: true,
        reason: t("server.repo.clear.unmerged", { branch: place.branch, ahead }),
      };
    });

  const clear = (repo: string, issueNumber: number, work: WorkplaceCleanup = "discard"): Promise<WorkplaceRelease> =>
    serially(repo, async (): Promise<WorkplaceRelease> => {
      const path = join(root, repo);
      const place = issueWorkplace(repo, issueNumber);
      const at = repository(path);
      if (await exists(place.cwd)) {
        const removed = await at.removeWorktree(place.cwd, work === "discard");
        if (removed)
          return {
            kept: true,
            reason: t("server.repo.clear.worktreeLeft", { cwd: place.cwd, why: removed }),
          };
      }
      if (!(await exists(path))) return { kept: false };
      let has: boolean;
      try {
        has = await at.hasBranch(place.branch);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        return { kept: true, reason: t("server.repo.clear.unconfirmed", { branch: place.branch, why: reason(e) }) };
      }
      if (!has) return { kept: false };
      const main = (await at.mainOrNone()) || "main";
      const ahead = await orWhenGitFails(at.ahead(main, place.branch), 1);
      if (ahead !== 0) return { kept: true, reason: t("server.repo.clear.unmergedKept", { branch: place.branch }) };
      const removed = await at.deleteBranch(place.branch);
      return removed ? { kept: true, reason: t("server.repo.clear.branchLeft", { branch: place.branch, why: removed }) } : { kept: false };
    });

  const reset = async (place: Workplace): Promise<void> => {
    const branch = place.branch;
    if (!branch) throw fail(t("server.repo.clear.notWorktree", { cwd: place.cwd }));
    await serially(place.repo, () =>
      repoErrors(async () => {
        const { git } = gitWith();
        const main = await repository(join(root, place.repo)).main();
        await git(place.cwd, "checkout", "-q", "-f", "-B", branch, main);
        await git(place.cwd, "clean", "-q", "-f", "-d");
      }),
    );
  };

  return {
    githubSnapshot,
    root,
    submitBranch,
    limit: perRepo,
    maxSessions,
    validate: (req) => ({ problem: repoProblem(req) }),
    create,
    list,
    summary,
    summaries: async () => {
      const found = await list();
      const out: T.RepoSummary[] = [];
      for (const p of found) out.push(await summary(p));
      return out;
    },
    stack: async (name) => {
      const p = await find(name);
      if (!p) return undefined;
      const read: (readonly [string, string])[] = [];
      for (const f of stackFiles) {
        try {
          read.push([f, await readFile(join(p.path, f), "utf8")] as const);
        } catch {
          // A marker that is not there (or cannot be read) says nothing of the stack.
        }
      }
      return stackOf(new Map(read));
    },
    languages: async (name, signal) => {
      const p = await find(name);
      if (!p) return undefined;
      const r = await run(tokei, tokeiArgs(p.path), { timeoutMs: 60_000, ...(signal === undefined ? {} : { signal }) });
      if (r.missing) throw fail(noTokei());
      if (r.code !== 0) throw fail(t("server.repo.tokeiFailed", { why: reason(r.stderr) }));
      const languages = countsOf(r.stdout);
      if (!languages) throw fail(t("server.repo.tokeiUnread"));
      return { repo: name, at: clock.now(), languages };
    },
    activity: async (name) => {
      const p = await find(name);
      if (!p) return undefined;
      const now = clock.now();
      const out: T.RepoActivity = {
        repo: name,
        at: now,
        days: [],
        authors: [],
        total: 0,
      };
      if (!p.git) return out;
      const { gitQuiet } = gitWith();
      const since = new Date(now - yearDays * 24 * 60 * 60 * 1000).toISOString();
      const log = await gitQuiet(p.path, "log", "--all", "--no-merges", "--since=" + since, "--format=%at%x09%aN");
      const total = await gitQuiet(p.path, "rev-list", "--all", "--no-merges", "--count");
      const roots = await gitQuiet(p.path, "log", "--all", "--max-parents=0", "--format=%at");
      const last = secondsOf(await gitQuiet(p.path, "log", "--all", "-1", "--format=%at"));
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
    },
    contributions: (extra) => contributionsOf(root, extra),
    checkout: (at) => workplace(at.repo, at.issue, at.worktree, at.base, at.signal),
    releaseCheckout: release,
    resetCheckout: reset,
    clearCheckout: clear,
    changes: (place) => describe(place.repo, place.cwd, place.branch),
    branchChanges: async (repo, branch) => {
      // An issue worked in a profile's own folder has no repo, and so no issue branch: none to read.
      if (!repo) return undefined;
      const path = join(root, repo);
      let present: boolean;
      try {
        present = await repository(path).hasBranch(branch);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        throw fail(t("server.repo.noBranchRead", { branch, why: reason(e) }));
      }
      if (!present) return undefined;
      return describe(repo, "", branch);
    },
    changedFiles: (cwd, baseBranch) =>
      repoErrors(async () => {
        const { git } = gitWith();
        const fork = await git(cwd, "merge-base", baseBranch, "HEAD");
        const changed = await git(cwd, "diff", "--name-only", "--no-renames", fork);
        const added = await git(cwd, "ls-files", "--others", "--exclude-standard");
        return [...new Set(`${changed}\n${added}`.split("\n").filter((f) => f !== ""))].toSorted();
      }),
    conflict: async (place, baseBranch = "") => {
      if (!place.branch) return undefined;
      const at = repository(join(root, place.repo));
      const base = baseBranch || (await at.mainOrNone());
      if (!base) return undefined;
      const files = await orWhenGitFails(at.conflicts(base, place.branch), []);
      return files.length > 0 ? { base, files } : undefined;
    },
    merge,
    mergeInto,
    mergeBranch,
    openBranch: (repo, branch, from = "") =>
      serially(repo, async () => {
        const path = await ensure(repo);
        await repoErrors(() => gitWith().git(path, "branch", branch, from || "HEAD"));
      }),
    run: async (cwd, command, signal) => {
      const r = await run("sh", ["-c", command], { cwd, timeoutMs: runTimeoutMs, ...(signal === undefined ? {} : { signal }) });
      let output = (r.stdout + r.stderr).trimEnd();
      if (output.length > runOutput) output = "…" + slice(output, -runOutput);
      return { ok: r.code === 0, output };
    },
    houseRules: async () => {
      try {
        return await readFile(join(resolve(config.workRoot), "AGENTS.md"), "utf8");
      } catch {
        // No house rules written: the helpers go by their own.
        return "";
      }
    },
    ...githubMethods,
    boot: () => {
      tasks.run("refreshGitHub", () => github.refreshGitHub());
      return Promise.resolve();
    },
    close: () => tasks.close(),
  };
}
