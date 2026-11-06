import { join } from "node:path";

import { Clock, Effect, type FileSystem, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { jsonOrNone } from "#/base/json.ts";

import { git, type GitError, gitQuiet, reason, run } from "./git.ts";
import { repository } from "./repository.ts";
import { lexists } from "./stats.ts";
import { type Merged, MergeFailure, ProjectError, type ProjectFolder, pullRequestFile, pullRequestText, type Workplace } from "./workplace.ts";

export const cloneTimeoutMs = 3 * 60_000;

// What the gh commands below print with --json; anything else is not taken as their answer.
const repoView = jsonOrNone(Schema.Struct({ viewerPermission: Schema.optional(Schema.NullOr(Schema.String)) }));
const openPullRequests = jsonOrNone(Schema.Array(Schema.Struct({ url: Schema.String, number: Schema.Int })));
const pullRequestView = jsonOrNone(Schema.Struct({ state: Schema.String, mergedAt: Schema.optional(Schema.NullOr(Schema.String)) }));

const ghVersion = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)/mu;
const ghAccount = /Logged in to github\.com account ([A-Za-z0-9-]+)(?:\s|$)/u;
const ghOrigin = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/u;

export function githubOrigin(origin: string): string {
  const m = ghOrigin.exec(origin.trim());
  if (!m?.[1] || !m[2]) return "";
  const repo = m[2].replace(/\.git$/u, "");
  return repo === "" || repo === "." || repo === ".." ? "" : `${m[1]}/${repo}`;
}

/** gh's combined output; failed when it exits non-zero or is not there. */
export type GitHubRun = (...args: string[]) => Effect.Effect<{ readonly out: string; readonly ok: boolean; readonly missing: boolean }>;

export const runGitHub: GitHubRun = (...args) =>
  Effect.map(
    // Auth status writes to stderr; raw output must never escape the probe.
    run("gh", args, {
      env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
      timeoutMs: args[0] === "repo" && args[1] === "clone" ? cloneTimeoutMs : 15_000,
    }),
    (r) => ({ out: r.stdout + r.stderr, ok: r.code === 0, missing: r.missing }),
  );

export const probeGitHub = Effect.fn("Project.probeGitHub")(function* (gh: GitHubRun) {
  const s: T.GitHubStatus = { checkedAt: yield* Clock.currentTimeMillis, installed: false, loggedIn: false, reason: "" };
  const version = yield* gh("--version");
  if (!version.ok) return { ...s, reason: version.missing ? t("server.project.gh.missing") : t("server.project.gh.failed") };
  const v = ghVersion.exec(version.out)?.[1];
  const installed: T.GitHubStatus = { ...s, installed: true, ...(v ? { version: v } : {}) };
  const auth = yield* gh("auth", "status", "--hostname", "github.com", "--active");
  if (!auth.ok) return { ...installed, reason: t("server.project.gh.signedOut") };
  const account = ghAccount.exec(auth.out)?.[1];
  if (!account) return { ...installed, reason: t("server.project.gh.noAccount") };
  return { ...installed, loggedIn: true, account };
});

const fail = (message: string) => Effect.fail(new ProjectError({ message }));

export interface ProjectGitHubEnv {
  readonly root: string;
  readonly fs: FileSystem.FileSystem;
  readonly gh: GitHubRun;
  readonly push?: ((cwd: string, branch: string) => Effect.Effect<boolean>) | undefined;
  readonly prProjects: ReadonlySet<string>;
  readonly list: () => Effect.Effect<ProjectFolder[]>;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly serially: <A, E, R>(project: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly issueBranch: (n: number) => string;
  readonly issueWorkplace: (name: string, n: number) => Workplace & { readonly branch: string };
  readonly syncMain: (name: string) => Effect.Effect<string>;
  readonly checkMerge: (place: Workplace, branch: string, target: string) => Effect.Effect<string, MergeFailure | GitError | ProjectError>;
  readonly unchangedBranch: (path: string, branch: string, checked: string) => Effect.Effect<void, MergeFailure | GitError>;
  readonly toMergeFailure: <A, R>(e: Effect.Effect<A, MergeFailure | GitError | ProjectError, R>) => Effect.Effect<A, MergeFailure, R>;
}

export const makeProjectGitHub = (env: ProjectGitHubEnv) => {
  const { root, fs, gh, push, prProjects, list, exists, serially, issueBranch, issueWorkplace, syncMain, checkMerge, unchangedBranch, toMergeFailure } = env;
  let status: T.GitHubStatus | undefined;
  let capabilities = new Map<string, T.PullRequestCapability>();

  const capability = (name: string): T.PullRequestCapability =>
    capabilities.get(name) ?? (status?.reason ? { available: false, reason: status.reason } : { available: false, reason: t("server.project.notChecked") });

  const usesPullRequests = (name: string) => prProjects.has(name) && capability(name).available;

  return {
    capability,
    usesPullRequests,
    githubStatus: (): T.GitHubStatus =>
      status?.checkedAt != null && status?.checkedAt !== 0
        ? status
        : {
            checkedAt: 0,
            installed: false,
            loggedIn: false,
            reason: t("server.project.github.unchecked"),
          },
    refreshGitHub: Effect.fn("Project.refreshGitHub")(function* () {
      const probed = yield* probeGitHub(gh);
      const next = new Map<string, T.PullRequestCapability>();
      yield* Effect.forEach(
        yield* list(),
        (p) =>
          Effect.gen(function* () {
            let c: T.PullRequestCapability = { available: false, reason: probed.reason };
            if (probed.loggedIn) {
              const repo = githubOrigin(yield* repository(p.path).origin);
              if (!p.git || repo === "") c = { available: false, reason: t("server.project.github.notGithub") };
              else {
                const view = yield* gh("repo", "view", repo, "--json", "viewerPermission");
                const permission = view.ok ? repoView(view.out)?.viewerPermission : undefined;
                c =
                  permission === undefined
                    ? { available: false, reason: t("server.project.github.noPermission") }
                    : ["ADMIN", "MAINTAIN", "WRITE"].includes(permission ?? "")
                      ? { available: true, reason: "" }
                      : { available: false, reason: t("server.project.github.readOnly") };
              }
            }
            next.set(p.name, c);
          }),
        { discard: true },
      );
      status = probed;
      capabilities = next;
      return probed;
    }),
    submitPullRequest: Effect.fn("Project.submitPullRequest")(function* (place: Workplace, issue: T.Issue, conclusion: string) {
      const branch = place.branch;
      if (!branch || branch !== issueBranch(issue.number)) return yield* fail(t("server.project.github.wrongBranch"));
      const checked = yield* toMergeFailure(checkMerge(place, branch, ""));
      return yield* serially(
        place.project,
        Effect.gen(function* () {
          const path = join(root, place.project);
          yield* toMergeFailure(unchangedBranch(path, branch, checked));
          if ((yield* toMergeFailure(git(place.cwd, "status", "--porcelain"))) !== "") return yield* fail(t("server.project.github.changedDuringCheck"));
          const repo = githubOrigin(yield* repository(path).origin);
          if (repo === "") return yield* fail(t("server.project.github.notGithub"));
          const main = yield* repository(path).main.pipe(Effect.mapError((e) => new ProjectError({ message: reason(e), cause: e })));
          const files = yield* repository(path)
            .conflicts(main, checked)
            .pipe(Effect.mapError((e) => new ProjectError({ message: reason(e), cause: e })));
          if (files.length > 0) return yield* MergeFailure.conflict(main, files);
          const pushed = push
            ? yield* push(place.cwd, branch)
            : (yield* run("git", ["push", "-u", "origin", branch], {
                cwd: place.cwd,
                timeoutMs: cloneTimeoutMs,
              })).code === 0;
          if (!pushed) return yield* fail(t("server.project.github.pushFailed"));
          if (issue.pullRequest?.state === "open") return issue.pullRequest;
          // Recover a creation whose receipt was lost before it was saved.
          const listed = yield* gh("pr", "list", "--repo", repo, "--head", branch, "--base", main, "--state", "open", "--json", "url,number");
          if (!listed.ok) return yield* fail(t("server.project.github.listFailed"));
          const existing = openPullRequests(listed.out);
          if (!existing) return yield* fail(t("server.project.github.listUnread"));
          const [firstPr] = existing;
          if (firstPr) return { ...firstPr, state: "open" as const };
          const check = (yield* lexists(join(place.cwd, ".vibevalley/check"))) ? t("server.project.github.checked") : t("server.project.github.noCheck");
          // The helper's own title and body when it wrote them (session/prompts.ts tells it where), else the issue's.
          const written = yield* gitQuiet(place.cwd, "rev-parse", "--path-format=absolute", "--git-path", pullRequestFile);
          const given = written === "" ? undefined : pullRequestText(yield* fs.readFileString(written).pipe(Effect.orElseSucceed(() => "")));
          const created = yield* gh(
            "pr",
            "create",
            "--repo",
            repo,
            "--head",
            branch,
            "--base",
            main,
            "--title",
            given?.title ?? issue.title,
            "--body",
            given?.body || t("server.project.github.body", { n: issue.number, conclusion, check }),
          );
          if (!created.ok) return yield* fail(t("server.project.github.createFailed"));
          const url = created.out.trim();
          const prefix = `https://github.com/${repo}/pull/`;
          const number = Number(url.slice(prefix.length));
          if (!url.startsWith(prefix) || !Number.isSafeInteger(number) || number <= 0) return yield* fail(t("server.project.github.urlUnread"));
          return { url, number, state: "open" as const };
        }),
      );
    }),
    pullRequestState: Effect.fn("Project.pullRequestState")(function* (name: string, n: number) {
      const repo = githubOrigin(yield* repository(join(root, name)).origin);
      if (repo === "") return yield* fail(t("server.project.github.notGithub"));
      const viewed = yield* gh("pr", "view", String(n), "--repo", repo, "--json", "state,mergedAt");
      if (!viewed.ok) return yield* fail(t("server.project.github.viewFailed", { n }));
      const result = pullRequestView(viewed.out);
      if (!result) return yield* fail(t("server.project.github.stateUnread", { n }));
      if (result.mergedAt || result.state === "MERGED") return "merged" as const;
      if (result.state === "OPEN") return "open" as const;
      if (result.state === "CLOSED") return "closed" as const;
      return yield* fail(t("server.project.github.stateUnknown", { n }));
    }),
    githubRequest: Effect.fn("Project.githubRequest")(function* (...args: string[]) {
      return yield* gh(...args);
    }),
    githubRemote: Effect.fn("Project.githubRemote")(function* (name: string) {
      const repo = githubOrigin(yield* repository(join(root, name)).origin);
      if (repo === "") return yield* fail(t("server.project.github.notGithub"));
      return repo;
    }),
    resolveReviewThread: Effect.fn("Project.resolveReviewThread")(function* (name: string, thread: string) {
      const repo = githubOrigin(yield* repository(join(root, name)).origin);
      if (repo === "") return yield* fail(t("server.project.github.notGithub"));
      const resolved = yield* gh(
        "api",
        "graphql",
        "-f",
        "query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}",
        "-F",
        `thread=${thread}`,
      );
      if (!resolved.ok) return yield* fail(t("server.project.github.resolveFailed"));
    }),
    finishPullRequest: Effect.fn("Project.finishPullRequest")(function* (name: string, n: number): Effect.fn.Return<Merged, ProjectError> {
      return yield* serially(
        name,
        Effect.gen(function* () {
          if (usesPullRequests(name)) yield* syncMain(name);
          const place = issueWorkplace(name, n);
          const path = join(root, name);
          if (yield* exists(place.cwd)) {
            const removed = yield* repository(path).removeWorktree(place.cwd, true);
            if (removed) return yield* fail(t("server.project.github.worktreeLeft", { why: removed }));
          }
          if (
            yield* repository(path)
              .hasBranch(place.branch)
              .pipe(Effect.orElseSucceed(() => false))
          ) {
            const deleted = yield* repository(path).deleteBranch(place.branch);
            if (deleted) return yield* fail(t("server.project.github.branchLeft", { why: deleted }));
          }
          return { text: "", commits: 0 };
        }),
      );
    }),
  };
};
