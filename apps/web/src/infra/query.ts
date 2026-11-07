import { Predicate, Schema } from "effect";

import { VibeValleyApiError } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { CursorManifest, SpriteManifest } from "#/base/manifests.ts";

import { api } from "./api";
import type { FramesSource } from "./frame";
import { defineQuery, type QueryClient } from "./query/cache";
import { useQuery } from "./query/solid";
export { createQueryClient, defineQuery, type QueryClient, type QueryDescriptor } from "./query/cache";
export { QueryProvider, ready, useQuery, useQueryClient, type QueryResult } from "./query/solid";

export const retryRead = {
  retry: 1,
  retryWhen: (error: unknown) =>
    Predicate.isTagged(error, "ApiConnectionError") || error instanceof TypeError || (error instanceof VibeValleyApiError && error.status >= 500),
};
export function refetchOnRelink(source: FramesSource, client: QueryClient) {
  let was = source.get().link;
  return source.subscribe(() => {
    const now = source.get().link;
    if (now === "open" && was === "lost") void client.invalidate();
    was = now;
  });
}
const spritesQuery = defineQuery({
  schema: SpriteManifest,
  key: () => ["sprites"],
  fetch: async (_: void, { signal }): Promise<unknown> => (await fetch("/pixel/sprites.json", { signal })).json(),
  staleTime: Infinity,
  ...retryRead,
});
export const cursorsQuery = defineQuery({
  schema: CursorManifest,
  key: () => ["cursors"],
  fetch: async (_: void, { signal }): Promise<unknown> => (await fetch("/cursors/cursors.json", { signal })).json(),
  staleTime: Infinity,
  ...retryRead,
});
export const agentsQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.Agent)),
  key: () => ["agents"],
  fetch: (_: void, context) => api.agent.list(context),
  ...retryRead,
});
export const templatesQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.AgentTemplate)),
  key: () => ["agent-templates"],
  fetch: (_: void, context) => api.agent.template.list(context),
  ...retryRead,
});
export const reposQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.RepoSummary)),
  key: () => ["repos"],
  fetch: (_: void, context) => api.repo.list(context),
  ...retryRead,
});
export const settingsQuery = defineQuery({
  schema: S.SettingsStatus,
  key: () => ["settings"],
  fetch: (_: void, context) => api.setting.get(context),
  ...retryRead,
});
export const runtimesQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.RuntimeInfo)),
  key: () => ["runtimes"],
  fetch: (_: void, context) => api.runtime.list(context),
  ...retryRead,
});
export const achievementsQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.Achievement)),
  key: () => ["achievements"],
  fetch: (_: void, context) => api.game.achievement.list(context),
  staleTime: Infinity,
  ...retryRead,
});
export const useSprites = () => useQuery(spritesQuery);
export const useAgents = () => useQuery(agentsQuery);
export const useAgentTemplates = () => useQuery(templatesQuery);
export const useRepos = () => useQuery(reposQuery, { interval: () => 30_000 });
export const useSettings = () => useQuery(settingsQuery);
export const useRuntimes = () => useQuery(runtimesQuery, { interval: () => 60_000 });
