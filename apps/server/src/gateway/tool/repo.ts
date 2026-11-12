import { answers } from "./prompts.ts";
import { tool } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

export function repoTools(deps: Pick<ToolDeps, "repo">) {
  const repos = deps.repo;
  return tool("repo.list", async () => {
    const all = await repos.list();
    if (all.length === 0) return answers.repos.empty(repos.root);
    return all.map((p) => "- " + p.name + (p.git ? "" : answers.repos.notGitYet)).join("\n");
  });
}
