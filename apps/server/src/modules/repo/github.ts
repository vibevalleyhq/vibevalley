import { join } from "node:path";

import { z } from "zod";

import type { Clock } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { jsonOrNone } from "#/base/json.ts";

import { GitError, run } from "./git.ts";
import { repository } from "./repository.ts";
import { type Merged, RepoError, type RepoFolder, type Workplace } from "./workplace.ts";

export const cloneTimeoutMs = 3 * 60_000;

// What the gh commands below print with --json; anything else is not taken as their answer.
const repoView = jsonOrNone(z.object({ viewerPermission: z.string().nullable().optional() }));

const ghVersion = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)/mu;
const ghAccount = /Logged in to github\.com account ([A-Za-z0-9-]+)(?:\s|$)/u;

export function githubOrigin(origin: string): string {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/u.exec(origin.trim());
  const name = match?.[1]?.replace(/\.git$/u, "");
  if (!name) return "";
  const parts = name.split("/");
  return parts.length === 2 && parts.every((p) => p !== "" && p !== "." && p !== "..") ? name : "";
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

interface RepoGitHubEnv {
  readonly root: string;
  readonly clock: Pick<Clock, "now">;
  readonly gh: GitHubRun;
  readonly prRepos: ReadonlySet<string>;
  readonly list: () => Promise<RepoFolder[]>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly serially: <A>(repo: string, work: () => Promise<A>, signal?: AbortSignal) => Promise<A>;
  readonly issueWorkplace: (name: string, n: number) => Workplace & { readonly branch: string };
  readonly syncMain: (name: string) => Promise<string>;
}

export const makeRepoGitHub = (env: RepoGitHubEnv) => {
  const { root, clock, gh, prRepos, list, exists, serially, issueWorkplace, syncMain } = env;
  let status: T.GitHubStatus | undefined;
  let capabilities = new Map<string, T.RepoSummary["pullRequest"]>();

  const capability = (name: string): T.RepoSummary["pullRequest"] =>
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
