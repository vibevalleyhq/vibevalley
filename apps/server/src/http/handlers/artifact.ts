// The answers of the artifact endpoints (packages/protocol/src/artifact/api.ts): each forwards to the service that owns the rule.

import { Effect } from "effect";

import { ownerId } from "@vibevalley/protocol";
import type { ArtifactHandlers } from "@vibevalley/protocol/api";

import { Agent } from "@/agent/agent.ts";
import { Artifact } from "@/artifact/artifact.ts";
import { Issue } from "@/issue/issue.ts";

export const artifactHandlers = Effect.gen(function* () {
  const agents = yield* Agent;
  const artifacts = yield* Artifact;
  const issues = yield* Issue;
  const done: ArtifactHandlers = {
    "artifact.list": ({ channel, issue }) =>
      Effect.flatMap(issue ? issues.idOf(issue) : Effect.succeed(undefined), (id) =>
        artifacts.list({ ...(channel ? { channel } : {}), ...(id ? { issue: id } : {}) }),
      ),
    "artifact.get": ({ id }) => artifacts.get(id),
    "artifact.content.get": ({ id, version }) => Effect.map(artifacts.content(id, version), (c) => ({ version: c.version, content: c.content })),
    "artifact.create": (req) =>
      Effect.flatMap(req.issue ? issues.idOf(req.issue) : Effect.succeed(undefined), (issue) =>
        artifacts.create({ from: ownerId, by: ownerId }, { ...req, ...(issue ? { issue } : {}) }),
      ),
    "artifact.version.create": (req) => artifacts.version({ from: ownerId, by: ownerId }, req),
    "artifact.html.edit": (req) => artifacts.htmlEdit({ from: ownerId, by: ownerId }, req),
    "artifact.update": ({ id, title }) => artifacts.rename(id, title),
    "artifact.delete": ({ id }) => artifacts.remove(id),
    "artifact.previewDelete": ({ id }) => artifacts.previewRemove(id),
    "artifact.block.list": ({ id }) => artifacts.blocks(id),
    "artifact.submit": ({ id, ...body }) => artifacts.submit(id, ownerId, body),
    "artifact.block.create": ({ id, ...body }) => artifacts.insertBlock(id, ownerId, body),
    "artifact.block.update": ({ id, ...body }) => artifacts.updateBlock(id, ownerId, body),
    "artifact.block.delete": ({ id, ...body }) => artifacts.deleteBlock(id, ownerId, body),
    "artifact.block.previewDelete": ({ id, block }) => artifacts.previewDeleteBlock(id, { block }),
    "artifact.suggestion.list": ({ id }) => artifacts.suggestions(id),
    "artifact.suggestion.create": ({ id, ...body }) => artifacts.suggest(id, ownerId, body),
    "artifact.suggestion.accept": ({ id, suggestion }) => artifacts.acceptSuggestion(id, suggestion, ownerId),
    "artifact.suggestion.reject": ({ id, suggestion }) => artifacts.rejectSuggestion(id, suggestion, ownerId),
    "artifact.markdown.get": ({ id }) => Effect.map(artifacts.markdown(id), (markdown) => ({ markdown })),
    "artifact.demo": ({ id }) => artifacts.demo(id, agents.agents()),
  };
  return done;
});
