// The projects under the work root and their git: making and listing them, a session's
// worktree on its own branch, what a branch changed, merging it into the main branch, a graph's branch, the project's
// own check (.vibevalley/check), GitHub pull requests through gh, and what the code is written in.
//
// A merge that would conflict is not attempted: the session is asked to merge the main branch in and resolve it.
// Merging into a graph's branch never checks it out: merge-tree writes the tree, commit-tree and update-ref put it on
// the branch. Two sessions sent to a new project at once must not both run git init, and two merges must not merge
// into the same branch together: each project's git work runs one at a time.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type Changes,
  type ChangedFile,
  type Conflict,
  type DayCount,
  type Author,
  type GitHubStatus,
  type Issue,
  type LanguageCount,
  maxRunning,
  type NewProject,
  type ProjectActivity,
  type ProjectCheck,
  type ProjectLanguages,
  type ProjectStack,
  type ProjectSummary,
  type PullRequest,
  type PullRequestCapability,
  type PullRequestState,
  type Repo,
  type UncommittedItem,
} from "@vibevalley/protocol";
import { slice } from "../base/text.ts";
import { Context, Effect, Layer, Semaphore } from "effect";
import { Settings } from "../base/config.ts";
import { git, gitOk, gitQuiet, gitRun, reason, run } from "./git.ts";
import { stackOf } from "./stack.ts";

export interface Workplace {
  readonly project: string;
  readonly cwd: string;
  /** Empty when it works in the project folder itself. */
  readonly branch?: string;
}

/** A retained branch or worktree still belongs to its issue, even after a failed dispatch. */
export type WorkplaceRelease = { readonly kept: false } | { readonly kept: true; readonly reason: string };
export type WorkplaceCleanup = "discard" | "preserve";

export interface Project {
  readonly name: string;
  readonly path: string;
  readonly git: boolean;
}

export interface Merged {
  readonly pullRequest?: PullRequest;
  readonly text: string;
  readonly commits: number;
  readonly hashes?: readonly string[];
  /** Publication succeeded; these resources could not be removed. */
  readonly warning?: string;
}

/** Why a merge did not go in: a conflict (and with what), the check, or git. */
export class MergeFailure extends Error {
  readonly _tag = "MergeFailure";
  constructor(
    readonly kind: "conflict" | "check" | "error",
    readonly reasonText: string,
    readonly base = "",
    readonly files: readonly string[] = [],
  ) {
    super(kind === "conflict" ? `合进 ${base} 有冲突` : reasonText);
  }
}

export class ProjectError extends Error {
  readonly _tag = "ProjectError";
}

const fail = (message: string) => Effect.fail(new ProjectError(message));

// The end of a check's output is kept: a test run's verdict is there.
const runTimeoutMs = 10 * 60_000;
const runOutput = 3000;
const patchLines = 400;
const patchesMax = 400_000;
const cloneTimeoutMs = 3 * 60_000;

const projectName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const githubURL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/;

/** Only repository home URLs: never credentials, other git transports or command-line options. */
export function githubRepository(input: string): { name: string; url: string } | undefined {
  const m = githubURL.exec(input.trim());
  if (!m) return undefined;
  const name = m[2]!.replace(/\.git$/, "");
  if (name === "" || name === "." || name === "..") return undefined;
  return { name, url: `https://github.com/${m[1]}/${name}.git` };
}

export function projectProblem(req: NewProject): string {
  if (!projectName.test(req.name)) return "项目名用字母或数字开头，只含字母、数字、-、_、.，最多 64 个字符";
  if (req.github !== undefined && !githubRepository(req.github)) return "请填 GitHub 仓库地址，例如 https://github.com/botiverse/raft-source";
  return "";
}

/** What a fresh repository ignores, so a first commit of an existing folder does not take its dependencies. */
const gitignore = "node_modules/\ndist/\nbuild/\n.env\n.env.*\n!.env.example\n.DS_Store\n__pycache__/\n*.pyc\n.pytest_cache/\n.venv/\n";

/** What a session's left-over changes are committed without, whatever the project ignores (pathspecs for git add). */
const neverCommitted = [
  ":(exclude,glob)**/__pycache__/**",
  ":(exclude,glob)**/*.pyc",
  ":(exclude,glob)**/.pytest_cache/**",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/.DS_Store",
];

const asFarm = ["-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost"];

/** As vibevalley when the machine has no git user. */
const commit = (cwd: string, message: string) =>
  git(cwd, "commit", "-q", "-m", message).pipe(Effect.catch(() => git(cwd, ...asFarm, "commit", "-q", "-m", message)));

const mergeCommit = (path: string, ours: string, theirs: string, message: string) =>
  Effect.gen(function* () {
    const tree = (yield* git(path, "merge-tree", "--write-tree", "--no-messages", ours, theirs)).split("\n")[0]!;
    const args = ["commit-tree", tree, "-p", ours, "-p", theirs, "-m", message];
    return yield* git(path, ...args).pipe(Effect.catch(() => git(path, ...asFarm, ...args)));
  });

/** The files merging branch into base would conflict on; none when it merges cleanly. */
const conflictsOf = (path: string, base: string, branch: string) =>
  Effect.gen(function* () {
    const r = yield* gitRun(path, "merge-tree", "--write-tree", "--name-only", "--no-messages", base, branch);
    if (r.code === 0) return [] as string[];
    if (r.code !== 1) return yield* fail(r.code < 0 ? r.stderr : `git merge-tree 出错（${r.code}）`);
    // First line: the tree it would write; then each conflicted file.
    return [
      ...new Set(
        r.stdout
          .trim()
          .split("\n")
          .slice(1)
          .filter((l) => l !== ""),
      ),
    ];
  });

const commitLeft = (cwd: string, message: string) =>
  Effect.gen(function* () {
    if ((yield* git(cwd, "status", "--porcelain")) === "") return;
    yield* git(cwd, "add", "-A", "--", ".", ...neverCommitted);
    if ((yield* git(cwd, "diff", "--cached", "--name-only")) === "") return;
    yield* commit(cwd, message);
  });

const failed = (e: unknown) => (e instanceof MergeFailure ? e : new MergeFailure("error", reason(e)));

const unchangedBranch = (path: string, branch: string, checked: string) =>
  Effect.gen(function* () {
    if ((yield* git(path, "rev-parse", "refs/heads/" + branch)) !== checked)
      return yield* Effect.fail(new MergeFailure("check", "分支在检查以后又变了，请重新检查再合"));
  });

/** Cleanup cannot undo publication: its warning travels with the receipt, it does not replace it with a failure. */
const cleanupMerged = (place: Workplace, path: string) =>
  Effect.gen(function* () {
    const removed = yield* gitRun(path, "worktree", "remove", "--force", place.cwd);
    if (removed.code !== 0) return `改动已合并，worktree ${place.cwd} 和分支 ${place.branch} 尚未清理：${reason(removed.stderr)}`;
    const deleted = yield* gitRun(path, "branch", "-D", place.branch!);
    if (deleted.code !== 0) return `改动已合并，分支 ${place.branch} 尚未清理：${reason(deleted.stderr)}`;
    return "";
  });

export const issueBranch = (n: number) => `vibevalley/issue-${n}`;

// ── what the code is ──

/** Not what a project is written in: gitignore patterns, as tokei's --exclude takes them. */
const leftOut = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "target/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".next/",
  "coverage/",
];

export const tokeiArgs = (path: string) => ["--output", "json", ...leftOut.flatMap((p) => ["--exclude", p]), path];

const noTokei = "统计代码要用 tokei，这台机器上没找到：装一个（brew install tokei，或 cargo install tokei）再点统计";

/** 53 weeks, so a whole year of weeks shows whatever day it is. */
const yearDays = 53 * 7;

/** Close to JavaScript's localeCompare for names, as the Go has it: case ignored first, then by bytes. */
const localeCompare = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Its total, and languages with nothing but blank lines, left out; undefined when it is not tokei's output. */
export function countsOf(output: string): LanguageCount[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: LanguageCount[] = [];
  for (const [name, body] of Object.entries(raw as Record<string, unknown>)) {
    const l = body as { code?: unknown; comments?: unknown; blanks?: unknown; reports?: unknown };
    if (typeof l?.code !== "number" || typeof l.comments !== "number" || typeof l.blanks !== "number" || !Array.isArray(l.reports)) return undefined;
    if (name === "Total" || l.code + l.comments <= 0) continue;
    out.push({ name, files: l.reports.length, code: Math.trunc(l.code), comments: Math.trunc(l.comments), blanks: Math.trunc(l.blanks) });
  }
  return out.sort((a, b) => b.code + b.comments - (a.code + a.comments) || localeCompare(a.name, b.name));
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function activityOf(log: string, dayOf: (ms: number) => string = localDay): { days: DayCount[]; authors: Author[] } {
  const byDay = new Map<string, number>();
  const byAuthor = new Map<string, number>();
  for (const line of log.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const seconds = Number(line.slice(0, tab).trim());
    if (!Number.isFinite(seconds) || seconds <= 0 || line.slice(0, tab).trim() === "") continue;
    const day = dayOf(Math.trunc(seconds * 1000));
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    const name = line.slice(tab + 1).trim() || "无名";
    byAuthor.set(name, (byAuthor.get(name) ?? 0) + 1);
  }
  const days = [...byDay].map(([day, commits]) => ({ day, commits })).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const authors = [...byAuthor].map(([name, commits]) => ({ name, commits })).sort((a, b) => b.commits - a.commits || localeCompare(a.name, b.name));
  return { days, authors };
}

const secondsOf = (text: string) => {
  const n = Number(text.trim());
  return text.trim() === "" || !Number.isFinite(n) || n <= 0 ? 0 : Math.trunc(n * 1000);
};

// ── GitHub ──

const ghVersion = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)/m;
const ghAccount = /Logged in to github\.com account ([A-Za-z0-9-]+)(?:\s|$)/;
const ghOrigin = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/;

export function githubOrigin(origin: string): string {
  const m = ghOrigin.exec(origin.trim());
  if (!m) return "";
  const repo = m[2]!.replace(/\.git$/, "");
  return repo === "" || repo === "." || repo === ".." ? "" : `${m[1]}/${repo}`;
}

/** gh's combined output; failed when it exits non-zero or is not there. */
export type GitHubRun = (...args: string[]) => Effect.Effect<{ readonly out: string; readonly ok: boolean; readonly missing: boolean }>;

const runGitHub: GitHubRun = (...args) =>
  Effect.map(
    // Auth status writes to stderr; raw output must never escape the probe.
    run("gh", args, {
      env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
      timeoutMs: args[0] === "repo" && args[1] === "clone" ? cloneTimeoutMs : 15_000,
    }),
    (r) => ({ out: r.stdout + r.stderr, ok: r.code === 0, missing: r.missing }),
  );

export const probeGitHub = (gh: GitHubRun) =>
  Effect.gen(function* () {
    const s: GitHubStatus = { checkedAt: Date.now(), installed: false, loggedIn: false } as GitHubStatus;
    const version = yield* gh("--version");
    if (!version.ok) return { ...s, reason: version.missing ? "没装 gh" : "gh 检测失败" };
    const v = ghVersion.exec(version.out)?.[1];
    const installed: GitHubStatus = { ...s, installed: true, ...(v ? { version: v } : {}) };
    const auth = yield* gh("auth", "status", "--hostname", "github.com", "--active");
    if (!auth.ok) return { ...installed, reason: "没登录 GitHub" };
    const account = ghAccount.exec(auth.out)?.[1];
    if (!account) return { ...installed, reason: "无法确认 GitHub 登录账号" };
    return { ...installed, loggedIn: true, account };
  });

export interface ProjectShape {
  readonly root: string;
  readonly limit: number;
  readonly maxSessions: () => number;
  readonly check: (req: NewProject) => ProjectCheck;
  readonly create: (req: NewProject) => Effect.Effect<Project, ProjectError>;
  readonly list: () => Effect.Effect<Project[]>;
  readonly summary: (p: Project) => Effect.Effect<ProjectSummary>;
  readonly summaries: () => Effect.Effect<ProjectSummary[]>;
  readonly stack: (name: string) => Effect.Effect<ProjectStack | undefined>;
  readonly languages: (name: string) => Effect.Effect<ProjectLanguages | undefined, ProjectError>;
  readonly activity: (name: string) => Effect.Effect<ProjectActivity | undefined>;
  readonly contributions: (extra: readonly string[]) => Effect.Effect<Repo[]>;
  readonly workplace: (project: string, issueNumber: number, worktree: boolean, baseBranch: string) => Effect.Effect<Workplace, ProjectError>;
  readonly changes: (place: Workplace) => Effect.Effect<Changes, ProjectError>;
  readonly branchChanges: (project: string, branch: string) => Effect.Effect<Changes, ProjectError>;
  readonly changedFiles: (cwd: string, baseBranch: string) => Effect.Effect<string[], ProjectError>;
  readonly conflict: (place: Workplace, baseBranch?: string) => Effect.Effect<Conflict | undefined>;
  readonly merge: (place: Workplace) => Effect.Effect<Merged, MergeFailure>;
  readonly mergeInto: (place: Workplace, target: string) => Effect.Effect<Merged, MergeFailure>;
  readonly mergeBranch: (project: string, branch: string) => Effect.Effect<string, MergeFailure>;
  readonly release: (place: Workplace) => Effect.Effect<WorkplaceRelease>;
  readonly reset: (place: Workplace) => Effect.Effect<void, ProjectError>;
  readonly clear: (project: string, issueNumber: number, work?: WorkplaceCleanup) => Effect.Effect<WorkplaceRelease>;
  readonly openBranch: (project: string, branch: string, from?: string) => Effect.Effect<void, ProjectError>;
  readonly run: (cwd: string, command: string) => Effect.Effect<{ readonly ok: boolean; readonly output: string }>;
  readonly houseRules: () => string;
  readonly githubStatus: () => GitHubStatus;
  readonly refreshGitHub: () => Effect.Effect<GitHubStatus>;
  readonly usesPullRequests: (name: string) => boolean;
  readonly submitPullRequest: (place: Workplace, issue: Issue, conclusion: string) => Effect.Effect<PullRequest, MergeFailure | ProjectError>;
  readonly pullRequestState: (name: string, n: number) => Effect.Effect<PullRequestState, ProjectError>;
  readonly finishPullRequest: (name: string, n: number) => Effect.Effect<Merged, ProjectError>;
}

export class Projects extends Context.Service<Projects, ProjectShape>()("vibevalley/Project") {}

/** What tests change: gh, and git's network. */
export interface ProjectHooks {
  readonly gh?: GitHubRun;
  readonly push?: (cwd: string, branch: string) => Effect.Effect<boolean>;
  readonly fetch?: (path: string, branch: string) => Effect.Effect<boolean>;
}

export const make = (hooks: ProjectHooks = {}) =>
  Effect.gen(function* () {
    const config = yield* Settings;
    const work = resolve(config.workRoot);
    const root = join(work, "projects");
    mkdirSync(root, { recursive: true });
    const trees = join(work, "worktrees");
    const perProject = config.project.maxSessions;
    const checkTimeoutMs = config.project.checkTimeoutSeconds * 1000;
    const tokei = config.tokei || "tokei";
    const prProjects = [...config.github.prProjects];
    const gh = hooks.gh ?? runGitHub;

    const queues = new Map<string, Semaphore.Semaphore>();
    const serially = <A, E, R>(project: string, effect: Effect.Effect<A, E, R>) => {
      let q = queues.get(project);
      if (!q) {
        q = Semaphore.makeUnsafe(1);
        queues.set(project, q);
      }
      return q.withPermits(1)(effect);
    };
    const pending = new Set<string>();
    let status: GitHubStatus | undefined;
    let capabilities = new Map<string, PullRequestCapability>();

    const ensure = (name: string) =>
      Effect.gen(function* () {
        if (!projectName.test(name)) return yield* fail(`「${name}」不能当项目名：用一个简单的英文文件夹名，比如 clock-in`);
        mkdirSync(join(root, name), { recursive: true });
        // git answers with real paths (on macOS /tmp is /private/tmp): compare like with like.
        const path = realpathSync(join(root, name));
        if (dirname(path) !== realpathSync(root)) return yield* fail("项目必须在工作目录里面，不能链接到外面");
        const top = yield* gitQuiet(path, "rev-parse", "--show-toplevel");
        if (top !== path) {
          yield* git(path, "init", "-q", "-b", "main");
          if (!existsSync(join(path, ".gitignore"))) writeFileSync(join(path, ".gitignore"), gitignore);
          if (readdirSync(path).filter((e) => e !== ".git").length <= 1) writeFileSync(join(path, "README.md"), `# ${name}\n`);
          yield* git(path, "add", "-A");
          yield* commit(path, "初始提交（VibeValley 建的项目）");
        } else if (!(yield* gitOk(path, "rev-parse", "--verify", "HEAD"))) {
          yield* git(path, "commit", "-q", "--allow-empty", "-m", "初始提交").pipe(Effect.catch(() => commit(path, "初始提交")));
        }
        return path;
      }).pipe(Effect.mapError((e) => (e instanceof ProjectError ? e : new ProjectError(reason(e)))));

    const list = () =>
      Effect.gen(function* () {
        if (!existsSync(root)) return [];
        const out: Project[] = [];
        for (const e of readdirSync(root, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith(".") || pending.has(e.name)) continue;
          let path: string;
          try {
            path = realpathSync(join(root, e.name));
          } catch {
            continue;
          }
          out.push({ name: e.name, path, git: (yield* gitQuiet(path, "rev-parse", "--show-toplevel")) === path });
        }
        return out;
      });

    const find = (name: string) => Effect.map(list(), (all) => all.find((p) => p.name === name));

    const capability = (name: string): PullRequestCapability =>
      capabilities.get(name) ??
      (status?.reason ? { available: false, reason: status.reason } : { available: false, reason: "尚未检测项目，请刷新 GitHub 状态" });

    const maxSessions = () => (perProject <= 0 || perProject > maxRunning ? maxRunning : perProject);

    const summary = (p: Project) =>
      Effect.gen(function* () {
        const s: ProjectSummary = { name: p.name, path: p.path, git: p.git, maxSessions: maxSessions(), pullRequest: capability(p.name) };
        if (p.git) {
          const last = secondsOf(yield* gitQuiet(p.path, "log", "--all", "-1", "--format=%at"));
          if (last > 0) s.last = last;
        }
        return s;
      });

    const issueWorkplace = (name: string, n: number): Workplace => ({ project: name, cwd: join(trees, `${name}.${n}`), branch: issueBranch(n) });

    /** Called under the project's turn. Failing keeps the local main branch as the next issue's base. */
    const syncMain = (name: string) =>
      Effect.gen(function* () {
        const path = join(root, name);
        const remoteHead = yield* gitRun(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
        const main = remoteHead.code === 0 ? remoteHead.stdout.trim().replace(/^origin\//, "") : yield* gitQuiet(path, "symbolic-ref", "--short", "HEAD");
        const kept = Effect.as(Effect.logWarning(`project ${name}: 无法从 origin 快进主分支，保留本地主分支`), main);
        if (main === "") return yield* kept;
        const fetched = hooks.fetch
          ? yield* hooks.fetch(path, main)
          : (yield* run("git", ["fetch", "origin", main], { cwd: path, timeoutMs: cloneTimeoutMs })).code === 0;
        if (!fetched) return yield* kept;
        const status = yield* gitRun(path, "status", "--porcelain");
        if (status.code !== 0 || status.stdout.trim() !== "") return yield* kept;
        const local = yield* gitRun(path, "rev-parse", "refs/heads/" + main);
        const remote = yield* gitRun(path, "rev-parse", "FETCH_HEAD");
        if (local.code !== 0 || remote.code !== 0 || !(yield* gitOk(path, "merge-base", "--is-ancestor", local.stdout.trim(), remote.stdout.trim())))
          return yield* kept;
        const current = yield* gitQuiet(path, "symbolic-ref", "--short", "HEAD");
        const moved =
          current === main
            ? yield* gitRun(path, "merge", "--ff-only", remote.stdout.trim())
            : yield* gitRun(path, "update-ref", "refs/heads/" + main, remote.stdout.trim(), local.stdout.trim());
        return moved.code === 0 ? main : yield* kept;
      });

    const usesPullRequests = (name: string) => prProjects.includes(name) && capability(name).available;

    const describe = (project: string, cwd: string, branch: string | undefined) =>
      Effect.gen(function* () {
        const path = join(root, project);
        const base = yield* git(path, "symbolic-ref", "--short", "HEAD");
        const uncommitted: UncommittedItem[] = [];
        if (cwd !== "") {
          const status = yield* gitRun(cwd, "status", "--porcelain=v1", "-uall");
          for (const line of status.stdout.replace(/\n+$/, "").split("\n")) {
            if (line.length < 4) continue;
            const code = line.slice(0, 2).trim();
            uncommitted.push({ path: line.slice(3), status: code === "??" ? "A" : code === "" ? "" : code[0]! });
          }
        }
        const changes: Changes = { project, base, commits: [], files: [], uncommitted, conflicts: [], behind: 0 } as unknown as Changes;
        if (!branch) return changes;
        changes.branch = branch;
        const range = `${base}...${branch}`;
        const log = yield* git(path, "log", "--format=%h%x09%ct%x09%s", `${base}..${branch}`);
        const names = yield* git(path, "diff", "--no-renames", "--name-status", range);
        const numbers = yield* gitQuiet(path, "diff", "--no-renames", "--numstat", range);
        const patch = (yield* gitRun(path, "diff", "--no-renames", "--no-color", range)).stdout.trim();
        const conflicts = yield* conflictsOf(path, base, branch);
        const behind = yield* gitQuiet(path, "rev-list", "--count", `${branch}..${base}`);
        const counts = new Map<string, { added: number; removed: number }>();
        for (const line of numbers.split("\n")) {
          const parts = line.split("\t");
          if (line === "" || parts.length < 3) continue;
          counts.set(parts.slice(2).join("\t"), { added: parts[0] === "-" ? -1 : Number(parts[0]), removed: parts[1] === "-" ? -1 : Number(parts[1]) });
        }
        const chunks = patch === "" ? [] : patch.split("\ndiff --git ").map((c, i) => (i > 0 ? "diff --git " + c : c));
        let budget = patchesMax;
        for (const line of names.split("\n")) {
          if (line === "") continue;
          const tab = line.indexOf("\t");
          const letter = tab < 0 ? line : line.slice(0, tab);
          const file = tab < 0 ? "" : line.slice(tab + 1);
          const n = counts.get(file) ?? { added: 0, removed: 0 };
          const changed: ChangedFile = { path: file, status: letter.slice(0, 1), added: n.added, removed: n.removed };
          if (n.added >= 0) {
            const head = `diff --git a/${file} b/${file}\n`;
            const i = chunks.findIndex((c) => c.startsWith(head));
            if (i >= 0) {
              // A chunk cut out of the middle of the diff lost its trailing newline to the split.
              let chunk = i < chunks.length - 1 ? chunks[i]! + "\n" : chunks[i]!;
              const lines = chunk.split("\n");
              if (lines.length > patchLines) chunk = lines.slice(0, patchLines).join("\n") + `\n… 还有 ${lines.length - patchLines} 行没显示`;
              if (chunk.length <= budget) {
                budget -= chunk.length;
                changed.patch = chunk;
              }
            }
          }
          changes.files.push(changed);
        }
        for (const line of log.split("\n")) {
          if (line === "") continue;
          const parts = line.split("\t");
          changes.commits.push({ hash: parts[0]!, at: (Number(parts[1]) || 0) * 1000, subject: parts.slice(2).join("\t") });
        }
        changes.conflicts.push(...conflicts);
        changes.behind = Number(behind) || 0;
        return changes;
      }).pipe(Effect.mapError((e) => (e instanceof ProjectError ? e : new ProjectError(reason(e)))));

    /** The project's own check: .vibevalley/check, run in the worktree, killed with everything it started when it runs too long. */
    const projectCheck = (cwd: string) =>
      Effect.gen(function* () {
        const file = join(cwd, ".vibevalley", "check");
        if (!lexists(file)) return;
        const r = yield* run(file, [], { cwd, timeoutMs: checkTimeoutMs });
        if (r.code === 0) return;
        const why = r.timedOut
          ? `项目检查 .vibevalley/check 超时（${checkTimeoutMs / 1000}s）`
          : r.code < 0
            ? `项目检查 .vibevalley/check 没通过：${reason(r.stderr)}`
            : `项目检查 .vibevalley/check 没通过：exit status ${r.code}`;
        const lines = (r.stdout + r.stderr)
          .slice(-64 * 1024)
          .trim()
          .split("\n")
          .slice(-40);
        return yield* Effect.fail(new MergeFailure("check", why + "\n" + lines.join("\n")));
      });

    /** Commit and check outside the project's turn; publication rechecks the head and conflicts in it. */
    const checkMerge = (place: Workplace, target: string) =>
      Effect.gen(function* () {
        yield* commitLeft(place.cwd, "合并前把没提交的改动一并提交");
        const path = join(root, place.project);
        const into = target || (yield* git(path, "symbolic-ref", "--short", "HEAD"));
        const checked = yield* git(path, "rev-parse", "refs/heads/" + place.branch);
        const conflicts = yield* conflictsOf(path, into, checked);
        if (conflicts.length > 0) return yield* Effect.fail(new MergeFailure("conflict", "", into, conflicts));
        yield* projectCheck(place.cwd);
        return checked;
      });

    const checkLocalMerge = (place: Workplace) =>
      Effect.gen(function* () {
        yield* commitLeft(place.cwd, "合并前把没提交的改动一并提交");
        const path = join(root, place.project);
        const main = yield* serially(
          place.project,
          Effect.gen(function* () {
            const main = yield* git(path, "symbolic-ref", "--short", "HEAD");
            const files = yield* conflictsOf(path, main, place.branch!);
            if (files.length > 0) return yield* Effect.fail(new MergeFailure("conflict", "", main, files));
            yield* git(place.cwd, ...asFarm, "merge", "--no-edit", main);
            return main;
          }),
        );
        return yield* checkMerge(place, main);
      });

    const mergeMain = (path: string, branch: string, kept: string) =>
      Effect.gen(function* () {
        const main = yield* git(path, "symbolic-ref", "--short", "HEAD");
        // A merge that would conflict is not tried: the session resolves it on its branch first.
        const conflicts = yield* conflictsOf(path, main, branch);
        if (conflicts.length > 0) return yield* Effect.fail(new MergeFailure("conflict", "", main, conflicts));
        const ahead = Number(yield* git(path, "rev-list", "--count", `${main}..${branch}`)) || 0;
        if (ahead > 0) {
          const merged = yield* gitRun(path, "merge", "--no-edit", branch);
          if (merged.code !== 0) {
            const aborted = yield* gitRun(path, "merge", "--abort");
            if (aborted.code !== 0)
              return yield* fail(
                `合并进 ${main} 没成功，${kept}：${reason(merged.stderr)}；退出合并也没成功（${reason(aborted.stderr)}），${main} 停在合并到一半，要手动收拾`,
              );
            return yield* fail(`合并进 ${main} 没成功，${kept}：${reason(merged.stderr)}`);
          }
        }
        return { main, ahead };
      });

    const toMergeFailure = <A, R>(e: Effect.Effect<A, unknown, R>) => Effect.mapError(e, failed);

    const shape: ProjectShape = {
      root,
      limit: perProject,
      maxSessions,
      check: (req) => {
        const problem = projectProblem(req);
        return problem ? { problem } : {};
      },
      create: (req) =>
        serially(
          req.name,
          Effect.gen(function* () {
            const problem = projectProblem(req);
            if (problem) return yield* fail(problem);
            const path = join(root, req.name);
            // Exclusive creation also refuses existing empty folders and symlinks.
            try {
              mkdirSync(path);
            } catch (e) {
              return yield* fail((e as NodeJS.ErrnoException).code === "EEXIST" ? `「${req.name}」已经存在，请换个项目名` : reason(e));
            }
            pending.add(req.name);
            const made = Effect.gen(function* () {
              if (req.github !== undefined) {
                const { url } = githubRepository(req.github)!;
                const known = status?.checkedAt ? status : yield* probeGitHub(gh);
                if (known.loggedIn) {
                  if (!(yield* gh("repo", "clone", githubOrigin(url), path)).ok) return yield* fail("下载失败：请确认 GitHub 登录、仓库权限和网络后重试");
                } else {
                  const cloned = yield* run("git", ["-c", "credential.helper=", "-c", "core.askPass=", "clone", "--", url, path], {
                    cwd: root,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
                    timeoutMs: cloneTimeoutMs,
                  });
                  if (cloned.code !== 0) return yield* fail("下载失败：请确认仓库公开、地址正确且网络可用；超过 3 分钟会停止，可重试");
                }
              } else yield* ensure(req.name);
              return { name: req.name, path, git: true };
            });
            return yield* made.pipe(
              Effect.tapError(() => Effect.sync(() => rmSync(path, { recursive: true, force: true }))),
              Effect.ensuring(Effect.sync(() => pending.delete(req.name))),
            );
          }),
        ),
      list,
      summary,
      summaries: () => Effect.flatMap(list(), (all) => Effect.forEach(all, summary)),
      stack: (name) => Effect.map(find(name), (p) => (p ? stackOf(p.path) : undefined)),
      languages: (name) =>
        Effect.gen(function* () {
          const p = yield* find(name);
          if (!p) return undefined;
          const r = yield* run(tokei, tokeiArgs(p.path), { timeoutMs: 60_000 });
          if (r.missing) return yield* fail(noTokei);
          if (r.code !== 0) return yield* fail("tokei 没数完：" + reason(r.stderr));
          const languages = countsOf(r.stdout);
          if (!languages) return yield* fail("tokei 的输出读不懂：换个新一点的 tokei 试试");
          return { project: name, at: Date.now(), languages };
        }),
      activity: (name) =>
        Effect.gen(function* () {
          const p = yield* find(name);
          if (!p) return undefined;
          const now = Date.now();
          const out: ProjectActivity = { project: name, at: now, days: [], authors: [], total: 0 } as unknown as ProjectActivity;
          if (!p.git) return out;
          const since = new Date(now - yearDays * 86_400_000).toISOString();
          const log = yield* gitQuiet(p.path, "log", "--all", "--no-merges", "--since=" + since, "--format=%at%x09%aN");
          const total = yield* gitQuiet(p.path, "rev-list", "--all", "--no-merges", "--count");
          const roots = yield* gitQuiet(p.path, "log", "--all", "--max-parents=0", "--format=%at");
          const last = secondsOf(yield* gitQuiet(p.path, "log", "--all", "-1", "--format=%at"));
          Object.assign(out, activityOf(log), { total: Number(total) || 0 });
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
      contributions: (extra) =>
        Effect.gen(function* () {
          const global = (yield* gitQuiet("", "config", "--global", "user.email")).toLowerCase();
          const seen = new Set<string>();
          const out: Repo[] = [];
          for (const dir of repoDirs(root, 3)) {
            // Worktrees share their repository's history: one count per repository.
            const common = yield* gitQuiet("", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
            if (common === "" || seen.has(common)) continue;
            seen.add(common);
            const mine = new Set([global, (yield* gitQuiet("", "-C", dir, "config", "user.email")).toLowerCase(), ...extra].filter((e) => e !== ""));
            const emails = (yield* gitQuiet("", "-C", dir, "log", "--all", "--format=%ae")).split("\n");
            const commits = emails.filter((e) => e !== "" && mine.has(e.toLowerCase())).length;
            out.push({ path: (yield* gitQuiet("", "-C", dir, "rev-parse", "--show-toplevel")) || dir, commits });
          }
          return out;
        }),
      workplace: (project, issueNumber, worktree, baseBranch) =>
        serially(
          project,
          Effect.gen(function* () {
            const path = yield* ensure(project);
            if (!worktree) return { project, cwd: path };
            const place = issueWorkplace(project, issueNumber);
            const branch = place.branch!;
            const cwd = place.cwd;
            if (existsSync(cwd)) return place;
            mkdirSync(trees, { recursive: true });
            const branchThere = yield* gitOk(path, "show-ref", "--verify", "refs/heads/" + branch);
            let from = baseBranch;
            if (!branchThere && usesPullRequests(project)) {
              const main = yield* syncMain(project);
              from ||= main;
            }
            const args = branchThere ? ["worktree", "add", "-q", cwd, branch] : ["worktree", "add", "-q", "-b", branch, cwd, from || "HEAD"];
            yield* git(path, ...args).pipe(Effect.mapError((e) => new ProjectError(reason(e))));
            return { project, cwd, branch };
          }),
        ),
      changes: (place) => describe(place.project, place.cwd, place.branch),
      branchChanges: (project, branch) => describe(project, "", branch),
      changedFiles: (cwd, baseBranch) =>
        Effect.gen(function* () {
          const fork = yield* git(cwd, "merge-base", baseBranch, "HEAD");
          const changed = yield* git(cwd, "diff", "--name-only", "--no-renames", fork);
          const added = yield* git(cwd, "ls-files", "--others", "--exclude-standard");
          return [...new Set(`${changed}\n${added}`.split("\n").filter((f) => f !== ""))].sort();
        }).pipe(Effect.mapError((e) => new ProjectError(reason(e)))),
      conflict: (place, baseBranch = "") =>
        Effect.gen(function* () {
          if (!place.branch) return undefined;
          const path = join(root, place.project);
          const base = baseBranch || (yield* gitQuiet(path, "symbolic-ref", "--short", "HEAD"));
          if (!base) return undefined;
          const files = yield* conflictsOf(path, base, place.branch).pipe(Effect.orElseSucceed(() => [] as string[]));
          return files.length > 0 ? { base, files } : undefined;
        }),
      merge: (place) =>
        toMergeFailure(
          Effect.gen(function* () {
            if (!place.branch) return { text: "它直接在项目里干活，没有要合并的分支", commits: 0 };
            const path = join(root, place.project);
            const checked = yield* checkLocalMerge(place);
            return yield* serially(
              place.project,
              Effect.gen(function* () {
                yield* unchangedBranch(path, place.branch!, checked);
                const head = yield* git(path, "symbolic-ref", "--short", "HEAD");
                if (!(yield* gitOk(path, "merge-base", "--is-ancestor", head, checked)))
                  return yield* Effect.fail(new MergeFailure("check", "主分支在检查期间又变了，请重新检查再合"));
                const { main, ahead } = yield* mergeMain(path, place.branch!, `${place.branch} 分支和 worktree 都留着`);
                const warning = yield* cleanupMerged(place, path);
                return {
                  text: ahead > 0 ? `${ahead} 个提交合进了 ${place.project} 的 ${main}` : "这一单没有新的提交",
                  commits: ahead,
                  ...(warning ? { warning } : {}),
                };
              }),
            );
          }),
        ),
      mergeInto: (place, target) =>
        toMergeFailure(
          Effect.gen(function* () {
            const path = join(root, place.project);
            if (!place.branch) return yield* Effect.fail(new MergeFailure("error", "它直接在项目里干活，没有分支可合"));
            const checked = yield* checkMerge(place, target);
            return yield* serially(
              place.project,
              Effect.gen(function* () {
                yield* unchangedBranch(path, place.branch!, checked);
                const conflicts = yield* conflictsOf(path, target, place.branch!);
                if (conflicts.length > 0) return yield* Effect.fail(new MergeFailure("conflict", "", target, conflicts));
                const brought = (yield* git(path, "log", "--reverse", "--format=%h", `${target}..${place.branch}`)).split("\n").filter((s) => s !== "");
                if (brought.length > 0) {
                  const ours = yield* git(path, "rev-parse", "refs/heads/" + target);
                  const theirs = yield* git(path, "rev-parse", place.branch!);
                  const next = (yield* gitOk(path, "merge-base", "--is-ancestor", ours, theirs))
                    ? theirs
                    : yield* mergeCommit(path, ours, theirs, "合并 " + place.branch);
                  // Only from where it was: a target moved meanwhile is not written over.
                  yield* git(path, "update-ref", "refs/heads/" + target, next, ours);
                }
                const warning = yield* cleanupMerged(place, path);
                return { text: "", commits: brought.length, hashes: brought, ...(warning ? { warning } : {}) };
              }),
            );
          }),
        ),
      mergeBranch: (project, branch) =>
        toMergeFailure(
          serially(
            project,
            Effect.gen(function* () {
              const path = join(root, project);
              const { main, ahead } = yield* mergeMain(path, branch, `${branch} 分支留着`);
              let said = ahead > 0 ? `${ahead} 个提交合进了 ${project} 的 ${main}` : "计划分支上没有新的提交";
              const deleted = yield* gitRun(path, "branch", "-D", branch);
              if (deleted.code !== 0) said += `；改动已合并，分支 ${branch} 尚未清理：${reason(deleted.stderr)}`;
              return said;
            }),
          ),
        ),
      release: (place) =>
        serially(
          place.project,
          Effect.gen(function* () {
            if (!place.branch) return { kept: false };
            const path = join(root, place.project);
            // A worktree with changes stays where it is: removing it would lose them.
            if (!(yield* gitOk(path, "worktree", "remove", place.cwd)))
              return { kept: true, reason: `${place.branch} 还有没提交的改动，worktree 留在 ${place.cwd}` };
            // A branch with nothing new on it is clutter; one with commits is kept, so nothing is lost.
            const main = (yield* gitQuiet(path, "symbolic-ref", "--short", "HEAD")) || "main";
            const count = yield* gitRun(path, "rev-list", "--count", `${main}..${place.branch}`);
            const ahead = count.code === 0 ? Number(count.stdout.trim()) || 0 : 1;
            if (ahead === 0) {
              const removed = yield* gitRun(path, "branch", "-D", place.branch);
              return removed.code === 0 ? { kept: false } : { kept: true, reason: `${place.branch} 没清掉：${reason(removed.stderr)}` };
            }
            return { kept: true, reason: `${place.branch} 上有 ${ahead} 个没合的提交，分支留着，worktree 清掉了` };
          }),
        ),
      reset: (place) =>
        Effect.gen(function* () {
          if (!place.branch) return yield* fail("不是 worktree，不能重置：" + place.cwd);
          yield* serially(
            place.project,
            Effect.gen(function* () {
              const main = yield* git(join(root, place.project), "symbolic-ref", "--short", "HEAD");
              yield* git(place.cwd, "checkout", "-q", "-f", "-B", place.branch!, main);
              yield* git(place.cwd, "clean", "-q", "-f", "-d");
            }).pipe(Effect.mapError((e) => new ProjectError(reason(e)))),
          );
        }),
      clear: (project, issueNumber, work = "discard") =>
        serially(
          project,
          Effect.gen(function* () {
            const path = join(root, project);
            const place = issueWorkplace(project, issueNumber);
            if (existsSync(place.cwd)) {
              const removed = yield* gitRun(path, "worktree", "remove", ...(work === "discard" ? ["--force"] : []), place.cwd);
              if (removed.code !== 0) return { kept: true, reason: `worktree ${place.cwd} 没清掉：${reason(removed.stderr)}` };
            }
            const branch = yield* gitRun(path, "show-ref", "--verify", "--quiet", "refs/heads/" + place.branch);
            if (branch.code !== 0) {
              if (branch.code === 1 || !existsSync(path)) return { kept: false };
              return { kept: true, reason: `没能确认 ${place.branch} 已清掉：${reason(branch.stderr)}` };
            }
            const main = (yield* gitQuiet(path, "symbolic-ref", "--short", "HEAD")) || "main";
            const count = yield* gitRun(path, "rev-list", "--count", `${main}..${place.branch}`);
            if (count.code !== 0 || count.stdout.trim() !== "0") return { kept: true, reason: `${place.branch} 上有没合的提交，分支留着` };
            const removed = yield* gitRun(path, "branch", "-D", place.branch!);
            return removed.code === 0 ? { kept: false } : { kept: true, reason: `${place.branch} 没清掉：${reason(removed.stderr)}` };
          }),
        ),
      openBranch: (project, branch, from = "") =>
        serially(
          project,
          Effect.gen(function* () {
            const path = yield* ensure(project);
            yield* git(path, "branch", branch, from || "HEAD").pipe(Effect.mapError((e) => new ProjectError(reason(e))));
          }),
        ),
      run: (cwd, command) =>
        Effect.map(run("sh", ["-c", command], { cwd, timeoutMs: runTimeoutMs }), (r) => {
          let output = (r.stdout + r.stderr).trimEnd();
          if (output.length > runOutput) output = "…" + slice(output, -runOutput);
          return { ok: r.code === 0, output };
        }),
      houseRules: () => {
        try {
          return readFileSync(join(work, "AGENTS.md"), "utf8");
        } catch {
          return "";
        }
      },
      githubStatus: () => (status?.checkedAt ? status : ({ checkedAt: 0, installed: false, loggedIn: false, reason: "尚未检测 GitHub" } as GitHubStatus)),
      refreshGitHub: () =>
        Effect.gen(function* () {
          const probed = yield* probeGitHub(gh);
          const next = new Map<string, PullRequestCapability>();
          for (const p of yield* list()) {
            let c: PullRequestCapability = { available: false, reason: probed.reason ?? "" };
            if (probed.loggedIn) {
              const origin = yield* gitRun(p.path, "remote", "get-url", "origin");
              const repo = githubOrigin(origin.stdout);
              if (!p.git || origin.code !== 0 || repo === "") c = { available: false, reason: "不是 GitHub 仓库" };
              else {
                const view = yield* gh("repo", "view", repo, "--json", "viewerPermission");
                let permission: string | undefined;
                try {
                  permission = view.ok ? (JSON.parse(view.out) as { viewerPermission?: string }).viewerPermission : undefined;
                } catch {
                  permission = undefined;
                }
                c =
                  permission === undefined
                    ? { available: false, reason: "无法检测 GitHub 仓库权限" }
                    : ["ADMIN", "MAINTAIN", "WRITE"].includes(permission)
                      ? { available: true, reason: "" }
                      : { available: false, reason: "没有写权限" };
              }
            }
            next.set(p.name, c);
          }
          status = probed;
          capabilities = next;
          return probed;
        }),
      usesPullRequests,
      submitPullRequest: (place, issue, conclusion) =>
        Effect.gen(function* () {
          if (place.branch !== issueBranch(issue.number)) return yield* fail("工单分支不匹配");
          const checked = yield* toMergeFailure(checkMerge(place, ""));
          return yield* serially(
            place.project,
            Effect.gen(function* () {
              const path = join(root, place.project);
              yield* toMergeFailure(unchangedBranch(path, place.branch!, checked));
              const repo = githubOrigin((yield* gitRun(path, "remote", "get-url", "origin")).stdout);
              if (repo === "") return yield* fail("不是 GitHub 仓库");
              const main = yield* git(path, "symbolic-ref", "--short", "HEAD").pipe(Effect.mapError((e) => new ProjectError(reason(e))));
              const files = yield* conflictsOf(path, main, checked);
              if (files.length > 0) return yield* Effect.fail(new MergeFailure("conflict", "", main, files));
              const pushed = hooks.push
                ? yield* hooks.push(place.cwd, place.branch!)
                : (yield* run("git", ["push", "-u", "origin", place.branch!], { cwd: place.cwd, timeoutMs: cloneTimeoutMs })).code === 0;
              if (!pushed) return yield* fail("推送工单分支失败，请检查 origin 和登录后重试");
              if (issue.pullRequest?.state === "open") return issue.pullRequest;
              // Recover a creation whose receipt was lost before it was saved.
              const listed = yield* gh("pr", "list", "--repo", repo, "--head", place.branch!, "--base", main, "--state", "open", "--json", "url,number");
              if (!listed.ok) return yield* fail("查询已有 PR 失败；分支已推送，可重试");
              let existing: PullRequest[];
              try {
                existing = JSON.parse(listed.out) as PullRequest[];
              } catch {
                return yield* fail("无法读取已有 PR");
              }
              if (existing.length > 0) return { ...existing[0]!, state: "open" as const };
              const check = lexists(join(place.cwd, ".vibevalley/check")) ? ".vibevalley/check 通过。" : "这个项目没有 .vibevalley/check，没跑检查。";
              const created = yield* gh(
                "pr",
                "create",
                "--repo",
                repo,
                "--head",
                place.branch!,
                "--base",
                main,
                "--title",
                issue.title,
                "--body",
                `工单 #${issue.number}\n\n${conclusion}\n\n${check}`,
              );
              if (!created.ok) return yield* fail("创建 PR 失败；分支已推送，可重试");
              const url = created.out.trim();
              const prefix = `https://github.com/${repo}/pull/`;
              const number = Number(url.slice(prefix.length));
              if (!url.startsWith(prefix) || !Number.isSafeInteger(number) || number <= 0) return yield* fail("无法读取新建 PR 的地址；可重试查询");
              return { url, number, state: "open" as const };
            }),
          );
        }),
      pullRequestState: (name, n) =>
        Effect.gen(function* () {
          const repo = githubOrigin((yield* gitRun(join(root, name), "remote", "get-url", "origin")).stdout);
          if (repo === "") return yield* fail("不是 GitHub 仓库");
          const viewed = yield* gh("pr", "view", String(n), "--repo", repo, "--json", "state,mergedAt");
          if (!viewed.ok) return yield* fail(`查询 PR #${n} 失败`);
          let result: { state?: string; mergedAt?: string | null };
          try {
            result = JSON.parse(viewed.out) as typeof result;
          } catch {
            return yield* fail(`无法读取 PR #${n} 状态`);
          }
          if (result.mergedAt || result.state === "MERGED") return "merged" as const;
          if (result.state === "OPEN") return "open" as const;
          if (result.state === "CLOSED") return "closed" as const;
          return yield* fail(`无法识别 PR #${n} 状态`);
        }),
      finishPullRequest: (name, n) =>
        serially(
          name,
          Effect.gen(function* () {
            if (usesPullRequests(name)) yield* syncMain(name);
            const place = issueWorkplace(name, n);
            const path = join(root, name);
            if (existsSync(place.cwd)) {
              const removed = yield* gitRun(path, "worktree", "remove", "--force", place.cwd);
              if (removed.code !== 0) return yield* fail(`PR 已结束，清理 worktree 失败：${reason(removed.stderr)}`);
            }
            if (yield* gitOk(path, "show-ref", "--verify", "refs/heads/" + place.branch)) {
              const deleted = yield* gitRun(path, "branch", "-D", place.branch!);
              if (deleted.code !== 0) return yield* fail(`PR 已结束，清理本地分支失败：${reason(deleted.stderr)}`);
            }
            return { text: "", commits: 0 };
          }),
        ),
    };
    return shape;
  });

const lexists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const skipDirs = new Set(["node_modules", ".git", ".venv", "vendor", "dist", "build", "target", ".next"]);

function repoDirs(dir: string, depth: number): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((e) => e.name === ".git")) return [dir];
  if (depth === 0) return [];
  return entries.filter((e) => e.isDirectory() && !skipDirs.has(e.name)).flatMap((e) => repoDirs(join(dir, e.name), depth - 1));
}

export const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

export const layer = (hooks: ProjectHooks = {}) => Layer.effect(Projects, make(hooks));

/** As the server starts: a first look at GitHub; the page asks again with github.refresh. */
export const start = Layer.effectDiscard(Effect.flatMap(Projects, (p) => Effect.forkScoped(p.refreshGitHub())));
