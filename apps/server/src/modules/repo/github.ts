import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { Clock } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { jsonOrNone } from "#/base/json.ts";

import { GitError, gitQuiet, reason, run } from "./git.ts";
import { hostedOrigin } from "./hosting.ts";
import { repository } from "./repository.ts";
import { lexists } from "./stats.ts";
import { type Merged, RepoError, type RepoFolder, pullRequestFile, pullRequestText, type Workplace } from "./workplace.ts";

export const cloneTimeoutMs = 3 * 60_000;

// What the gh commands below print with --json; anything else is not taken as their answer.
const repoView = jsonOrNone(z.object({ viewerPermission: z.string().nullable().optional() }));
const pullRequestView = jsonOrNone(z.object({ state: z.string(), mergedAt: z.string().nullable().optional() }));

const ghVersion = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)/mu;
const ghAccount = /Logged in to github\.com account ([A-Za-z0-9-]+)(?:\s|$)/u;
export function githubOrigin(origin: string): string {
  const repo = hostedOrigin(origin.trim());
  return repo?.platform === "github" ? repo.name : "";
}

/** gh's combined output; failed when it exits non-zero or is not there. */
export type GitHubRun = (...args: string[]) => Promise<{ readonly out: string; readonly ok: boolean; readonly missing: boolean }>;

export const runGitHub: GitHubRun = async (...args) => {
  // Auth status writes to stderr; raw output must never escape the probe.
  const r = await run("gh", args, {
    env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
    timeoutMs: args[0] === "repo" && args[1] === "clone" ? cloneTimeoutMs : 15_000,
  });
  return { out: r.stdout + r.stderr, ok: r.code === 0, missing: r.missing };
};

export async function probeGitHub(gh: GitHubRun, clock: Pick<Clock, "now">): Promise<T.GitHubStatus> {
  const s: T.GitHubStatus = { checkedAt: clock.now(), installed: false, loggedIn: false, reason: "" };
  const version = await gh("--version");
  if (!version.ok) return { ...s, reason: version.missing ? t("server.repo.gh.missing") : t("server.repo.gh.failed") };
  const v = ghVersion.exec(version.out)?.[1];
  const installed: T.GitHubStatus = { ...s, installed: true, ...(v ? { version: v } : {}) };
  const auth = await gh("auth", "status", "--hostname", "github.com", "--active");
  if (!auth.ok) return { ...installed, reason: t("server.repo.gh.signedOut") };
  const account = ghAccount.exec(auth.out)?.[1];
  if (!account) return { ...installed, reason: t("server.repo.gh.noAccount") };
  return { ...installed, loggedIn: true, account };
}

const fail = (message: string) => new RepoError(message);

/** A GitError as the RepoError the caller is told. */
const asRepoError = async <A>(work: Promise<A>): Promise<A> => {
  try {
    return await work;
  } catch (e) {
    if (e instanceof GitError) throw new RepoError(reason(e), { cause: e });
    throw e;
  }
};

interface RepoGitHubEnv {
  readonly root: string;
  readonly clock: Pick<Clock, "now">;
  readonly gh: GitHubRun;
  readonly submitBranch: (req: T.SubmitBranch, signal?: AbortSignal) => Promise<T.BranchPublication>;
  readonly prRepos: ReadonlySet<string>;
  readonly list: () => Promise<RepoFolder[]>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly serially: <A>(repo: string, work: () => Promise<A>, signal?: AbortSignal) => Promise<A>;
  readonly issueBranch: (n: number) => string;
  readonly issueWorkplace: (name: string, n: number) => Workplace & { readonly branch: string };
  readonly syncMain: (name: string) => Promise<string>;
}

export const makeRepoGitHub = (env: RepoGitHubEnv) => {
  const { root, clock, gh, submitBranch, prRepos, list, exists, serially, issueBranch, issueWorkplace, syncMain } = env;
  let status: T.GitHubStatus | undefined;
  let capabilities = new Map<string, T.RepoSummary["pullRequest"]>();

  const capability = (name: string): T.RepoSummary["pullRequest"] =>
    capabilities.get(name) ?? (status?.reason ? { available: false, reason: status.reason } : { available: false, reason: t("server.repo.notChecked") });

  const usesPullRequests = (name: string) => prRepos.has(name) && capability(name).available;

  const githubRemote = async (name: string) => {
    const repo = githubOrigin(await repository(join(root, name)).origin());
    if (repo === "") throw fail(t("server.repo.github.notGithub"));
    return repo;
  };

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
    refreshGitHub: async (): Promise<T.GitHubStatus> => {
      const probed = await probeGitHub(gh, clock);
      const next = new Map<string, T.RepoSummary["pullRequest"]>();
      for (const p of await list()) {
        let c: T.RepoSummary["pullRequest"] = { available: false, reason: probed.reason };
        if (probed.loggedIn) {
          const repo = githubOrigin(await repository(p.path).origin());
          if (!p.git || repo === "") c = { available: false, reason: t("server.repo.github.notGithub") };
          else {
            const view = await gh("repo", "view", repo, "--json", "viewerPermission");
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
      }
      status = probed;
      capabilities = next;
      return probed;
    },
    submitPullRequest: async (place: Workplace, issue: T.Issue, conclusion: string, signal?: AbortSignal): Promise<T.PullRequest> => {
      const branch = place.branch;
      if (!branch || branch !== issueBranch(issue.number)) throw fail(t("server.repo.github.wrongBranch"));
      const path = join(root, place.repo);
      const sha = await asRepoError(repository(place.cwd, signal).head());
      const base = await asRepoError(repository(path, signal).main());
      const written = await gitQuiet(place.cwd, "rev-parse", "--path-format=absolute", "--git-path", pullRequestFile);
      let given: ReturnType<typeof pullRequestText>;
      if (written !== "") {
        let raw = "";
        try {
          raw = await readFile(written, "utf8");
        } catch {
          // No file left by the helper: the issue's own title and body open the pull request.
          raw = "";
        }
        given = pullRequestText(raw);
      }
      const check = (await lexists(join(place.cwd, ".vibevalley/check"))) ? t("server.repo.github.checked") : t("server.repo.github.noCheck");
      const result = await submitBranch(
        {
          cwd: place.cwd,
          branch,
          sha,
          base,
          title: given?.title ?? issue.title,
          body: given?.body || t("server.repo.github.body", { n: issue.number, conclusion, check }),
        },
        signal,
      );
      if (!result.url || result.number === undefined) throw fail(t("server.repo.github.urlUnread"));
      return { url: result.url, number: result.number, state: "open" };
    },
    pullRequestState: async (name: string, n: number): Promise<T.PullRequestState> => {
      const repo = await githubRemote(name);
      const viewed = await gh("pr", "view", String(n), "--repo", repo, "--json", "state,mergedAt");
      if (!viewed.ok) throw fail(t("server.repo.github.viewFailed", { n }));
      const result = pullRequestView(viewed.out);
      if (!result) throw fail(t("server.repo.github.stateUnread", { n }));
      if (result.mergedAt || result.state === "MERGED") return "merged";
      if (result.state === "OPEN") return "open";
      if (result.state === "CLOSED") return "closed";
      throw fail(t("server.repo.github.stateUnknown", { n }));
    },
    githubRequest: ((...args) => gh(...args)) satisfies GitHubRun,
    githubRemote,
    resolveReviewThread: async (name: string, thread: string): Promise<void> => {
      await githubRemote(name);
      const resolved = await gh(
        "api",
        "graphql",
        "-f",
        "query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}",
        "-F",
        `thread=${thread}`,
      );
      if (!resolved.ok) throw fail(t("server.repo.github.resolveFailed"));
    },
    finishPullRequest: (name: string, n: number): Promise<Merged> =>
      serially(name, async () => {
        if (usesPullRequests(name)) await syncMain(name);
        const place = issueWorkplace(name, n);
        const path = join(root, name);
        if (await exists(place.cwd)) {
          const removed = await repository(path).removeWorktree(place.cwd, true);
          if (removed) throw fail(t("server.repo.github.worktreeLeft", { why: removed }));
        }
        let has = false;
        try {
          has = await repository(path).hasBranch(place.branch);
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          // A branch git cannot see is not one to delete.
          has = false;
        }
        if (has) {
          const deleted = await repository(path).deleteBranch(place.branch, true);
          if (deleted) throw fail(t("server.repo.github.branchLeft", { why: deleted }));
        }
        return { text: "", commits: 0 };
      }),
  };
};
