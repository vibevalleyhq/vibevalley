import { basename, dirname, isAbsolute } from "node:path";

import { Effect, type FileSystem } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { checkRepository } from "./check.ts";
import { GitError, type run } from "./git.ts";
import type { GitHubRun } from "./github.ts";
import { hostedOrigin, hosting } from "./hosting.ts";
import { repository } from "./repository.ts";
import { MergeFailure, RepoError } from "./workplace.ts";

export interface PublishNetwork {
  readonly tip: (cwd: string, url: string, branch: string) => Effect.Effect<string, GitError>;
  readonly fetch: (cwd: string, url: string, branch: string) => Effect.Effect<unknown, GitError>;
  readonly push: (cwd: string, url: string, branch: string, sha: string) => Effect.Effect<unknown, GitError>;
}

const network: PublishNetwork = {
  tip: Effect.fnUntraced(function* (cwd, url, branch) {
    const line = yield* repository(cwd).remoteTip(url, branch);
    const [sha, ref] = line.split("\t");
    if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha) || ref !== "refs/heads/" + branch) return yield* GitError.of(1, "Invalid remote ref");
    return sha;
  }),
  fetch: (cwd, url, branch) => repository(cwd).fetch(url, branch),
  push: (cwd, url, branch, sha) => repository(cwd).push(url, branch, sha),
};

const refused = (detail: string) => new RepoError({ message: t("server.repo.publish.refused", { detail }) });

export const publisher = (env: {
  readonly fs: FileSystem.FileSystem;
  readonly gh: GitHubRun;
  readonly glab: GitHubRun;
  readonly timeoutMs: number;
  readonly command: typeof run;
  readonly network?: PublishNetwork | undefined;
  readonly serially: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}) => {
  const transport = env.network ?? network;
  const submit = Effect.fn("Repo.submitBranch")(
    function* (req: T.SubmitBranch): Effect.fn.Return<T.BranchPublication, RepoError | MergeFailure | GitError> {
      if (!isAbsolute(req.cwd) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(req.sha) || !req.title.trim()) return yield* refused("cwd / sha / title");
      const cwd = yield* env.fs.realPath(req.cwd).pipe(Effect.mapError(() => refused("cwd")));
      const repo = repository(cwd);
      const { top, common } = yield* repo.location;
      if (top !== cwd || common === "") return yield* refused("checkout root");
      const key = basename(common) === ".git" ? dirname(common) : common;
      return yield* env.serially(
        key,
        Effect.gen(function* () {
          if (!(yield* repo.validBranch(req.branch)) || !(yield* repo.validBranch(req.base)) || req.branch.startsWith("-") || req.base.startsWith("-"))
            return yield* refused("branch / base");
          const unchanged = Effect.fnUntraced(function* () {
            const snapshot = yield* repo.checkout;
            if (snapshot.branch !== req.branch || snapshot.sha !== req.sha || !snapshot.clean) return yield* refused("checkout changed or dirty");
          });
          const destination = Effect.fnUntraced(function* () {
            const config = yield* repo.configuration;
            if (config.some(({ key }) => /^url\..*\.(insteadof|pushinsteadof)$/u.test(key))) return yield* refused("URL rewrite configuration");
            const names = new Set(
              config.flatMap(({ key }) => {
                const name = /^remote\.(.+)\.[^.]+$/u.exec(key)?.[1];
                return name ? [name] : [];
              }),
            );
            const [name] = names;
            if (names.size !== 1 || !name || name.startsWith("-")) return yield* refused("ambiguous remote");
            const reads = config.filter(({ key }) => key === "remote." + name + ".url");
            const writes = config.filter(({ key }) => key === "remote." + name + ".pushurl");
            const read = reads[0]?.value ?? "";
            const write = writes[0]?.value ?? read;
            const target = hostedOrigin(read);
            const pushed = hostedOrigin(write);
            if (reads.length !== 1 || writes.length > 1 || !target || !pushed || target.host !== pushed.host || target.name !== pushed.name)
              return yield* refused("remote read / push destination");
            return { name, read, write, target };
          });
          yield* unchanged();
          const remote = yield* destination();
          const host = hosting(remote.target, remote.target.platform === "github" ? env.gh : env.glab);
          const defaultBranch = yield* host.inspect();
          if (req.branch === req.base || req.branch === defaultBranch) return yield* refused("default / base branch");
          const result = { platform: remote.target.platform, repository: remote.target.name, branch: req.branch, sha: req.sha, base: req.base };
          if (req.dryRun === true) return { ...result, check: "preview" as const, pushed: false };
          const baseSha = yield* transport.tip(cwd, remote.read, req.base);
          yield* transport.fetch(cwd, remote.read, req.base);
          const conflicts = yield* repo.conflicts(baseSha, req.sha);
          if (conflicts.length > 0) return yield* MergeFailure.conflict(req.base, conflicts);
          const check = yield* checkRepository(cwd, env.timeoutMs, env.command);
          const after = yield* destination();
          if (
            after.name !== remote.name ||
            after.read !== remote.read ||
            after.write !== remote.write ||
            (yield* transport.tip(cwd, remote.read, req.base)) !== baseSha
          )
            return yield* refused("remote changed during check");
          yield* unchanged();
          yield* transport
            .push(cwd, remote.write, req.branch, req.sha)
            .pipe(Effect.mapError((cause) => new RepoError({ message: t("server.repo.publish.pushUnconfirmed", { sha: req.sha }), cause })));
          const published = yield* Effect.gen(function* () {
            const existing = yield* host.find(req.branch, req.base);
            const receipt = existing ?? (yield* host.create(req));
            return { ...receipt, reused: existing !== undefined };
          }).pipe(Effect.mapError((e) => new RepoError({ message: t("server.repo.publish.pushedWithoutLink", { sha: req.sha, why: e.message }), cause: e })));
          return { ...result, check, pushed: true, ...published };
        }),
      );
    },
    Effect.catchTag("GitError", () => Effect.fail(refused("git failed; checkout retained"))),
  );
  return submit;
};
