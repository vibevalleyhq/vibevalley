import { Effect } from "effect";

import { Project } from "#/project/project.ts";

import { answers } from "./prompts.ts";
import { tool } from "./schemas.ts";

export const projectTools = Effect.gen(function* () {
  const projects = yield* Project;
  return tool(
    "project.list",
    Effect.fn("Tool.projectList")(function* () {
      const all = yield* projects.list();
      if (all.length === 0) return answers.projects.empty(projects.root);
      return all.map((p) => "- " + p.name + (p.git ? "" : answers.projects.notGitYet)).join("\n");
    }),
  );
});
