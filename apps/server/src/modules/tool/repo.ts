import { Effect } from "effect";

import { Repo } from "#/modules/repo/repo.ts";

import { answers } from "./prompts.ts";
import { tool } from "./schemas.ts";

export const repoTools = Effect.gen(function* () {
  const repos = yield* Repo;
  return tool(
    "repo.list",
    Effect.fn("Tool.repoList")(function* () {
      const all = yield* repos.list();
      if (all.length === 0) return answers.repos.empty(repos.root);
      return all.map((p) => "- " + p.name + (p.git ? "" : answers.repos.notGitYet)).join("\n");
    }),
  );
});
