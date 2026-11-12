import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

import { isAbort } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { messageOf } from "#/base/errors.ts";

import { checkRepository } from "./check.ts";
import { GitError, type run } from "./git.ts";
import type { GitHubRun } from "./github.ts";
import { hostedOrigin, hosting } from "./hosting.ts";
import { repository } from "./repository.ts";
import { MergeFailure, RepoError } from "./workplace.ts";

export interface PublishNetwork {
  readonly tip: (cwd: string, url: string, branch: string) => Promise<string>;
  readonly fetch: (cwd: string, url: string, branch: string) => Promise<unknown>;
  readonly push: (cwd: string, url: string, branch: string, sha: string) => Promise<unknown>;
}

const network: PublishNetwork = {
  tip: async (cwd, url, branch) => {
    const line = await repository(cwd).remoteTip(url, branch);
    const [sha, ref] = line.split("\t");
    if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha) || ref !== "refs/heads/" + branch) throw GitError.of(1, "Invalid remote ref");
    return sha;
  },
  fetch: (cwd, url, branch) => repository(cwd).fetch(url, branch),
  push: (cwd, url, branch, sha) => repository(cwd).push(url, branch, sha),
};

const refused = (detail: string) => new RepoError(t("server.repo.publish.refused", { detail }));

export const publisher = (env: {
  readonly gh: GitHubRun;
  readonly glab: GitHubRun;
  readonly timeoutMs: number;
  readonly command: typeof run;
  readonly network?: PublishNetwork | undefined;
  readonly serially: <A>(key: string, work: () => Promise<A>, signal?: AbortSignal) => Promise<A>;
}) => {
  const transport = env.network ?? network;
  const publish = async (req: T.SubmitBranch, signal?: AbortSignal): Promise<T.BranchPublication> => {
    if (!isAbsolute(req.cwd) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(req.sha) || !req.title.trim()) throw refused("cwd / sha / title");
    let cwd: string;
    try {
      cwd = await realpath(req.cwd);
    } catch {
      // A checkout that is not there (or cannot be read) is refused the same as any other bad cwd.
      throw refused("cwd");
    }
    const repo = repository(cwd, signal);
    const { top, common } = await repo.location();
    if (top !== cwd || common === "") throw refused("checkout root");
    const key = basename(common) === ".git" ? dirname(common) : common;
    return env.serially(
      key,
      async () => {
        if (!(await repo.validBranch(req.branch)) || !(await repo.validBranch(req.base)) || req.branch.startsWith("-") || req.base.startsWith("-"))
          throw refused("branch / base");
        const unchanged = async () => {
          const snapshot = await repo.checkout();
          if (snapshot.branch !== req.branch || snapshot.sha !== req.sha || !snapshot.clean) throw refused("checkout changed or dirty");
        };
        const destination = async () => {
          const config = await repo.configuration();
          if (config.some(({ key }) => /^url\..*\.(insteadof|pushinsteadof)$/u.test(key))) throw refused("URL rewrite configuration");
          const names = new Set(
            config.flatMap(({ key }) => {
              const name = /^remote\.(.+)\.[^.]+$/u.exec(key)?.[1];
              return name ? [name] : [];
            }),
          );
          const [name] = names;
          if (names.size !== 1 || !name || name.startsWith("-")) throw refused("ambiguous remote");
          const reads = config.filter(({ key }) => key === "remote." + name + ".url");
          const writes = config.filter(({ key }) => key === "remote." + name + ".pushurl");
          const read = reads[0]?.value ?? "";
          const write = writes[0]?.value ?? read;
          const target = hostedOrigin(read);
          const pushed = hostedOrigin(write);
          if (reads.length !== 1 || writes.length > 1 || !target || !pushed || target.host !== pushed.host || target.name !== pushed.name)
            throw refused("remote read / push destination");
          return { name, read, write, target };
        };
        await unchanged();
        const remote = await destination();
        const host = hosting(remote.target, remote.target.platform === "github" ? env.gh : env.glab);
        const defaultBranch = await host.inspect();
        if (req.branch === req.base || req.branch === defaultBranch) throw refused("default / base branch");
        const result = { platform: remote.target.platform, repository: remote.target.name, branch: req.branch, sha: req.sha, base: req.base };
        if (req.dryRun === true) return { ...result, check: "preview" as const, pushed: false };
        const baseSha = await transport.tip(cwd, remote.read, req.base);
        await transport.fetch(cwd, remote.read, req.base);
        const conflicts = await repo.conflicts(baseSha, req.sha);
        if (conflicts.length > 0) throw MergeFailure.conflict(req.base, conflicts);
        const check = await checkRepository(cwd, env.timeoutMs, env.command, signal);
        const after = await destination();
        if (
          after.name !== remote.name ||
          after.read !== remote.read ||
          after.write !== remote.write ||
          (await transport.tip(cwd, remote.read, req.base)) !== baseSha
        )
          throw refused("remote changed during check");
        await unchanged();
        try {
          await transport.push(cwd, remote.write, req.branch, req.sha);
        } catch (cause) {
          if (isAbort(cause, signal)) throw cause;
          throw new RepoError(t("server.repo.publish.pushUnconfirmed", { sha: req.sha }), { cause });
        }
        let published;
        try {
          const existing = await host.find(req.branch, req.base);
          const receipt = existing ?? (await host.create(req));
          published = { ...receipt, reused: existing !== undefined };
        } catch (e) {
          if (isAbort(e, signal)) throw e;
          throw new RepoError(t("server.repo.publish.pushedWithoutLink", { sha: req.sha, why: messageOf(e) }), { cause: e });
        }
        return { ...result, check, pushed: true, ...published };
      },
      signal,
    );
  };
  return async (req: T.SubmitBranch, signal?: AbortSignal): Promise<T.BranchPublication> => {
    try {
      return await publish(req, signal);
    } catch (e) {
      if (e instanceof GitError) throw refused("git failed; checkout retained");
      throw e;
    }
  };
};
