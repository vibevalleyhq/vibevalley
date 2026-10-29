import { t } from "@vibevalley/i18n";
// A git repository as the projects use it: what it can say (its main branch, whether a branch is there and where it
// points, how far one is ahead) and what it does (commit what a session left, merge without checking out, describe a
// branch, clear a worktree away). The git spelling is here; what is done with the answers (the merge rules, pull
// requests, the project's check, what a release keeps) stays in project.ts.

import type { Changes, ChangedFile, UncommittedItem } from "@vibevalley/protocol";
import { Effect } from "effect";
import { git, GitError, gitOk, gitQuiet, gitRun, type Ran, reason } from "./git.ts";

const patchLines = 400;
const patchesMax = 400_000;

/** As vibevalley when the machine has no git user. */
export const asFarm = ["-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost"];

/** What a session's left-over changes are committed without, whatever the project ignores (pathspecs for git add). */
const neverCommitted = [
  ":(exclude,glob)**/__pycache__/**",
  ":(exclude,glob)**/*.pyc",
  ":(exclude,glob)**/.pytest_cache/**",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/.DS_Store",
];

/** "" when it went through, else the first line git said. */
const why = (ran: Effect.Effect<Ran>) => Effect.map(ran, (r) => (r.code === 0 ? "" : reason(r.stderr)));

/** The repository (or a worktree of it) at path. */
export const repository = (path: string) => {
  /** The branch checked out: in a project's own folder, its main. */
  const main = git(path, "symbolic-ref", "--short", "HEAD");

  /** As the machine's git user, else as vibevalley. */
  const commit = (message: string) => git(path, "commit", "-q", "-m", message).pipe(Effect.catch(() => git(path, ...asFarm, "commit", "-q", "-m", message)));

  /** The files merging branch into base would conflict on; none when it merges cleanly. */
  const conflicts = Effect.fnUntraced(function* (base: string, branch: string) {
    const r = yield* gitRun(path, "merge-tree", "--write-tree", "--name-only", "--no-messages", base, branch);
    if (r.code === 0) return [] as string[];
    if (r.code !== 1) return yield* GitError.of(r.code, r.code < 0 ? r.stderr : t("server.project.mergeTree", { code: r.code }));
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

  return {
    main,
    /** The same, or "" when git cannot say. */
    mainOrNone: gitQuiet(path, "symbolic-ref", "--short", "HEAD"),
    /** Whether refs/heads/<branch> is there; a git that cannot tell fails. */
    hasBranch: (branch: string) =>
      Effect.flatMap(gitRun(path, "show-ref", "--verify", "--quiet", "refs/heads/" + branch), (r) =>
        r.code === 0 ? Effect.succeed(true) : r.code === 1 ? Effect.succeed(false) : Effect.fail(GitError.of(r.code, r.stderr)),
      ),
    /** Where a branch points. */
    tip: (branch: string) => git(path, "rev-parse", "refs/heads/" + branch),
    /** Whether newer has older in it; false when git cannot say. */
    isAncestor: (older: string, newer: string) => gitOk(path, "merge-base", "--is-ancestor", older, newer),
    /** How many commits branch has that base has not. */
    ahead: (base: string, branch: string) => Effect.map(git(path, "rev-list", "--count", `${base}..${branch}`), (n) => Number(n) || 0),
    /** origin's URL, or "" when it has none. */
    origin: gitQuiet(path, "remote", "get-url", "origin"),
    /** "" when the worktree at cwd is gone; without force, one with changes stays. */
    removeWorktree: (cwd: string, force: boolean) => why(gitRun(path, "worktree", "remove", ...(force ? ["--force"] : []), cwd)),
    /** "" when the branch is gone. */
    deleteBranch: (branch: string) => why(gitRun(path, "branch", "-D", branch)),
    commit,
    /** Commits what is left in the worktree, without what is never committed; nothing when nothing is left. */
    commitLeft: Effect.fnUntraced(function* (message: string) {
      if ((yield* git(path, "status", "--porcelain")) === "") return;
      yield* git(path, "add", "-A", "--", ".", ...neverCommitted);
      if ((yield* git(path, "diff", "--cached", "--name-only")) === "") return;
      yield* commit(message);
    }),
    conflicts,
    /** A merge commit of theirs into ours, made without checking either out: merge-tree writes the tree. */
    mergeCommit: Effect.fnUntraced(function* (ours: string, theirs: string, message: string) {
      const tree = (yield* git(path, "merge-tree", "--write-tree", "--no-messages", ours, theirs)).split("\n")[0]!;
      const args = ["commit-tree", tree, "-p", ours, "-p", theirs, "-m", message];
      return yield* git(path, ...args).pipe(Effect.catch(() => git(path, ...asFarm, ...args)));
    }),
    /** What branch changes against main, with what is uncommitted in cwd (none for ""): its commits, each file with its
     * lines and patch (the patches cut to a budget), its conflicts with main and how far main is ahead of it. */
    describe: Effect.fnUntraced(function* (project: string, cwd: string, branch: string | undefined) {
      const base = yield* main;
      const uncommitted: UncommittedItem[] = [];
      if (cwd !== "") {
        const status = yield* gitRun(cwd, "status", "--porcelain=v1", "-uall");
        for (const line of status.stdout.replace(/\n+$/, "").split("\n")) {
          if (line.length < 4) continue;
          const code = line.slice(0, 2).trim();
          uncommitted.push({
            path: line.slice(3),
            status: code === "??" ? "A" : code === "" ? "" : code[0]!,
          });
        }
      }
      const changes: Changes = {
        project,
        base,
        commits: [],
        files: [],
        uncommitted,
        conflicts: [],
        behind: 0,
      };
      if (!branch) return changes;
      changes.branch = branch;
      const range = `${base}...${branch}`;
      const log = yield* git(path, "log", "--format=%h%x09%ct%x09%s", `${base}..${branch}`);
      // One diff for all three: the raw lines (":<modes> <ids> <letter>\t<path>") and the numstat lines come first, then
      // the patch from its first "diff --git".
      const diff = yield* git(path, "diff", "--no-renames", "--no-color", "--raw", "--numstat", "-p", range);
      const first = diff.startsWith("diff --git ") ? 0 : diff.indexOf("\ndiff --git ");
      const at = first < 0 ? diff.length : first === 0 ? 0 : first + 1;
      const head = diff.slice(0, at).split("\n");
      const names = head.flatMap((l) => (l.startsWith(":") ? [l.slice(l.lastIndexOf(" ", l.indexOf("\t")) + 1)] : [])).join("\n");
      const numbers = head.filter((l) => !l.startsWith(":")).join("\n");
      const patch = diff.slice(at).trim();
      const clashes = yield* conflicts(base, branch);
      const behind = yield* gitQuiet(path, "rev-list", "--count", `${branch}..${base}`);
      const counts = new Map<string, { added: number; removed: number }>();
      for (const line of numbers.split("\n")) {
        const parts = line.split("\t");
        if (line === "" || parts.length < 3) continue;
        counts.set(parts.slice(2).join("\t"), {
          added: parts[0] === "-" ? -1 : Number(parts[0]),
          removed: parts[1] === "-" ? -1 : Number(parts[1]),
        });
      }
      const chunks = patch === "" ? [] : patch.split("\ndiff --git ").map((c, i) => (i > 0 ? "diff --git " + c : c));
      let budget = patchesMax;
      for (const line of names.split("\n")) {
        if (line === "") continue;
        const tab = line.indexOf("\t");
        const letter = tab < 0 ? line : line.slice(0, tab);
        const file = tab < 0 ? "" : line.slice(tab + 1);
        const n = counts.get(file) ?? { added: 0, removed: 0 };
        const changed: ChangedFile = {
          path: file,
          status: letter.slice(0, 1),
          added: n.added,
          removed: n.removed,
        };
        if (n.added >= 0) {
          const head = `diff --git a/${file} b/${file}\n`;
          const i = chunks.findIndex((c) => c.startsWith(head));
          if (i >= 0) {
            // A chunk cut out of the middle of the diff lost its trailing newline to the split.
            let chunk = i < chunks.length - 1 ? chunks[i]! + "\n" : chunks[i]!;
            const lines = chunk.split("\n");
            if (lines.length > patchLines)
              chunk = lines.slice(0, patchLines).join("\n") + "\n" + t("server.project.moreLines", { n: lines.length - patchLines });
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
        changes.commits.push({
          hash: parts[0]!,
          at: (Number(parts[1]) || 0) * 1000,
          subject: parts.slice(2).join("\t"),
        });
      }
      changes.conflicts.push(...clashes);
      changes.behind = Number(behind) || 0;
      return changes;
    }),
  };
};
