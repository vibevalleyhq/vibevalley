import { userId } from "@vibevalley/protocol";
import type { ArtifactHandlers } from "@vibevalley/protocol/api";

import type { Agent } from "#/modules/agent/agent.ts";
import type { Artifact } from "#/modules/artifact/artifact.ts";
import type { Issue } from "#/modules/issue/issue.ts";

export function artifactHandlers(deps: { readonly agent: Agent; readonly artifact: Artifact; readonly issue: Issue }): ArtifactHandlers {
  const { agent: agents, artifact: artifacts, issue: issues } = deps;
  return {
    "artifact.list": async ({ channel, issue }) => {
      const id = issue ? await issues.idOf(issue) : undefined;
      return artifacts.list({ ...(channel ? { channel } : {}), ...(id ? { issue: id } : {}) });
    },
    "artifact.get": ({ id }) => artifacts.get(id),
    "artifact.content.get": async ({ id, version }) => {
      const c = await artifacts.content(id, version);
      return { version: c.version, content: c.content };
    },
    "artifact.create": async (req) => {
      const issue = req.issue ? await issues.idOf(req.issue) : undefined;
      return artifacts.create({ from: userId, by: userId }, { ...req, ...(issue ? { issue } : {}) });
    },
    "artifact.version.create": (req) => artifacts.version({ from: userId, by: userId }, req),
    "artifact.html.edit": (req) => artifacts.htmlEdit({ from: userId, by: userId }, req),
    "artifact.update": (req) => artifacts.update(req),
    "artifact.delete": ({ id }) => artifacts.remove(id),
    "artifact.previewDelete": ({ id }) => artifacts.previewRemove(id),
    "artifact.block.list": ({ id }) => artifacts.blocks(id),
    "artifact.submit": ({ id, ...body }) => artifacts.submit(id, userId, body),
    "artifact.block.create": ({ id, ...body }) => artifacts.insertBlock(id, userId, body),
    "artifact.block.update": ({ id, ...body }) => artifacts.updateBlock(id, userId, body),
    "artifact.block.delete": ({ id, ...body }) => artifacts.deleteBlock(id, userId, body),
    "artifact.block.previewDelete": ({ id, block }) => artifacts.previewDeleteBlock(id, { block }),
    "artifact.suggestion.list": ({ id }) => artifacts.suggestions(id),
    "artifact.suggestion.create": ({ id, ...body }) => artifacts.suggest(id, userId, body),
    "artifact.suggestion.accept": ({ id, suggestion }) => artifacts.acceptSuggestion(id, suggestion, userId),
    "artifact.suggestion.reject": ({ id, suggestion }) => artifacts.rejectSuggestion(id, suggestion, userId),
    "artifact.markdown.get": async ({ id }) => ({ markdown: await artifacts.markdown(id) }),
    "artifact.demo": ({ id }) => artifacts.demo(id, agents.agents()),
  };
}
