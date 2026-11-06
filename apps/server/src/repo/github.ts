import { join } from "node:path";

import { Clock, Effect, type FileSystem, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { jsonOrNone } from "#/base/json.ts";

import { gitQuiet, reason, run } from "./git.ts";
import { hostedOrigin } from "./hosting.ts";
import { repository } from "./repository.ts";
import { lexists } from "./stats.ts";
import { type Merged, type MergeFailure, RepoError, type RepoFolder, pullRequestFile, pullRequestText, type Workplace } from "./workplace.ts";

export const cloneTimeoutMs = 3 * 60_000;

// What the gh commands below print with --json; anything else is not taken as their answer.
const repoView = jsonOrNone(Schema.Struct({ viewerPermission: Schema.optional(Schema.NullOr(Schema.String)) }));
const pullRequestView = jsonOrNone(Schema.Struct({ state: Schema.String, mergedAt: Schema.optional(Schema.NullOr(Schema.String)) }));

const ghVersion = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)/mu;
const ghAccount = /Logged in to github\.com account ([A-Za-z0-9-]+)(?:\s|$)/u;
export function githubOrigin(origin: string): string {
  const repo = hostedOrigin(origin.trim());
  return repo?.platform === "github" ? repo.name : "";
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

export const probeGitHub = Effect.fn("Repo.probeGitHub")(function* (gh: GitHubRun) {
  const s: T.GitHubStatus = { checkedAt: yield* Clock.currentTimeMillis, installed: false, loggedIn: false, reason: "" };
  const version = yield* gh("--version");
  if (!version.ok) return { ...s, reason: version.missing ? t("server.repo.gh.missing") : t("server.repo.gh.failed") };
  const v = ghVersion.exec(version.out)?.[1];
  const installed: T.GitHubStatus = { ...s, installed: true, ...(v ? { version: v } : {}) };
  const auth = yield* gh("auth", "status", "--hostname", "github.com", "--active");
  if (!auth.ok) return { ...installed, reason: t("server.repo.gh.signedOut") };
  const account = ghAccount.exec(auth.out)?.[1];
  if (!account) return { ...installed, reason: t("server.repo.gh.noAccount") };
  return { ...installed, loggedIn: true, account };
});

const fail = (message: string) => Effect.fail(new RepoError({ message }));

export interface RepoGitHubEnv {
  readonly root: string;
  readonly fs: FileSystem.FileSystem;
  readonly gh: GitHubRun;
  readonly submitBranch: (req: T.SubmitBranch) => Effect.Effect<T.BranchPublication, MergeFailure | RepoError>;
  readonly prRepos: ReadonlySet<string>;
  readonly list: () => Effect.Effect<RepoFolder[]>;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly serially: <A, E, R>(repo: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly issueBranch: (n: number) => string;
  readonly issueWorkplace: (name: string, n: number) => Workplace & { readonly branch: string };
  readonly syncMain: (name: string) => Effect.Effect<string>;
}

export const makeRepoGitHub = (env: RepoGitHubEnv) => {
  const { root, fs, gh, submitBranch, prRepos, list, exists, serially, issueBranch, issueWorkplace, syncMain } = env;
  let status: T.GitHubStatus | undefined;
  let capabilities = new Map<string, T.PullRequestCapability>();

  const capability = (name: string): T.PullRequestCapability =>
    capabilities.get(name) ?? (status?.reason ? { available: false, reason: status.reason } : { available: false, reason: t("server.repo.notChecked") });

  const usesPullRequests = (name: string) => prRepos.has(name) && capability(name).available;

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
            reason: t("server.repo.github.unchecked"),
          },
    refreshGitHub: Effect.fn("Repo.refreshGitHub")(function* () {
      const probed = yield* probeGitHub(gh);
      const next = new Map<string, T.PullRequestCapability>();
      yield* Effect.forEach(
        yield* list(),
        (p) =>
          Effect.gen(function* () {
            let c: T.PullRequestCapability = { available: false, reason: probed.reason };
            if (probed.loggedIn) {
              const repo = githubOrigin(yield* repository(p.path).origin);
              if (!p.git || repo === "") c = { available: false, reason: t("server.repo.github.notGithub") };
              else {
                const view = yield* gh("repo", "view", repo, "--json", "viewerPermission");
                const permission = view.ok ? repoView(view.out)?.viewerPermission : undefined;
                c =
                  permission === undefined
                    ? { available: false, reason: t("server.repo.github.noPermission") }
                    : ["ADMIN", "MAINTAIN", "WRITE"].includes(permission ?? "")
                      ? { available: true, reason: "" }
                      : { available: false, reason: t("server.repo.github.readOnly") };
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
    submitPullRequest: Effect.fn("Repo.submitPullRequest")(function* (place: Workplace, issue: T.Issue, conclusion: string) {
      const branch = place.branch;
      if (!branch || branch !== issueBranch(issue.number)) return yield* fail(t("server.repo.github.wrongBranch"));
      const path = join(root, place.repo);
      const sha = yield* repository(place.cwd).head.pipe(Effect.mapError((e) => new RepoError({ message: reason(e), cause: e })));
      const base = yield* repository(path).main.pipe(Effect.mapError((e) => new RepoError({ message: reason(e), cause: e })));
      const written = yield* gitQuiet(place.cwd, "rev-parse", "--path-format=absolute", "--git-path", pullRequestFile);
      const given = written === "" ? undefined : pullRequestText(yield* fs.readFileString(written).pipe(Effect.orElseSucceed(() => "")));
      const check = (yield* lexists(join(place.cwd, ".vibevalley/check"))) ? t("server.repo.github.checked") : t("server.repo.github.noCheck");
      const result = yield* submitBranch({
        cwd: place.cwd,
        branch,
        sha,
        base,
        title: given?.title ?? issue.title,
        body: given?.body || t("server.repo.github.body", { n: issue.number, conclusion, check }),
      });
      if (!result.url || result.number === undefined) return yield* fail(t("server.repo.github.urlUnread"));
      return { url: result.url, number: result.number, state: "open" as const };
    }),
    pullRequestState: Effect.fn("Repo.pullRequestState")(function* (name: string, n: number) {
      const repo = githubOrigin(yield* repository(join(root, name)).origin);
      if (repo === "") return yield* fail(t("server.repo.github.notGithub"));
      const viewed = yield* gh("pr", "view", String(n), "--repo", repo, "--json", "state,mergedAt");
      if (!viewed.ok) return yield* fail(t("server.repo.github.viewFailed", { n }));
      const result = pullRequestView(viewed.out);
      if (!result) return yield* fail(t("server.repo.github.stateUnread", { n }));
      if (result.mergedAt || result.state === "MERGED") return "merged" as const;
      if (result.state === "OPEN") return "open" as const;
      if (result.state === "CLOSED") return "closed" as const;
      return yield* fail(t("server.repo.github.stateUnknown", { n }));
    }),
    githubRequest: Effect.fn("Repo.githubRequest")(function* (...args: string[]) {
      return yield* gh(...args);
    }),
    githubRemote: Effect.fn("Repo.githubRemote")(function* (name: string) {
      const repo = githubOrigin(yield* repository(join(root, name)).origin);
      if (repo === "") return yield* fail(t("server.repo.github.notGithub"));
      return repo;
    }),
    resolveReviewThread: Effect.fn("Repo.resolveReviewThread")(function* (name: string, thread: string) {
      const repo = githubOrigin(yield* repository(join(root, name)).origin);
      if (repo === "") return yield* fail(t("server.repo.github.notGithub"));
      const resolved = yield* gh(
        "api",
        "graphql",
        "-f",
        "query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}",
        "-F",
        `thread=${thread}`,
      );
      if (!resolved.ok) return yield* fail(t("server.repo.github.resolveFailed"));
    }),
    finishPullRequest: Effect.fn("Repo.finishPullRequest")(function* (name: string, n: number): Effect.fn.Return<Merged, RepoError> {
      return yield* serially(
        name,
        Effect.gen(function* () {
          if (usesPullRequests(name)) yield* syncMain(name);
          const place = issueWorkplace(name, n);
          const path = join(root, name);
          if (yield* exists(place.cwd)) {
            const removed = yield* repository(path).removeWorktree(place.cwd, true);
            if (removed) return yield* fail(t("server.repo.github.worktreeLeft", { why: removed }));
          }
          if (
            yield* repository(path)
              .hasBranch(place.branch)
              .pipe(Effect.orElseSucceed(() => false))
          ) {
            const deleted = yield* repository(path).deleteBranch(place.branch, true);
            if (deleted) return yield* fail(t("server.repo.github.branchLeft", { why: deleted }));
          }
          return { text: "", commits: 0 };
        }),
      );
    }),
  };
};
