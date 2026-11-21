import { z } from "zod";

import {
  type Agent,
  type AgentTemplate,
  type ProviderStatus,
  type ProviderVoiceListing,
  type ProviderVoiceRequest,
  type RepoSummary,
  type RuntimeInfo,
  type SettingsStatus,
  VibeValleyApiError,
} from "@vibevalley/protocol";

import { api, ApiConnectionError } from "./api";
import { CursorManifest, SpriteManifest } from "./base/manifests";
import type { FramesSource } from "./frame";
import { cursorManifest, loadSpriteManifest } from "./pixelManifests";
import { defineQuery, type QueryClient } from "./query/cache";
import { useQuery } from "./query/solid";
export { defineQuery, type QueryClient } from "./query/cache";
export { QueryProvider, ready, useQuery, useQueryClient, type QueryResult } from "./query/solid";

/** Pass-through schema for responses already typed by the trusted in-process Rust bridge. */
const trusted = <T>(): z.ZodType<T> => z.custom<T>(() => true);

export const retryRead = {
  retry: 1,
  retryWhen: (error: unknown) =>
    error instanceof ApiConnectionError || error instanceof TypeError || (error instanceof VibeValleyApiError && error.status >= 500),
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
  fetch: (): Promise<unknown> => loadSpriteManifest(),
  staleTime: Infinity,
  ...retryRead,
});
export const cursorsQuery = defineQuery({
  schema: CursorManifest,
  key: () => ["cursors"],
  fetch: (): Promise<unknown> => Promise.resolve(cursorManifest),
  staleTime: Infinity,
  ...retryRead,
});
export const agentsQuery = defineQuery({
  schema: trusted<Agent[]>(),
  key: () => ["agents"],
  fetch: (_: void, context) => api.agent.list(context),
  ...retryRead,
});
const templatesQuery = defineQuery({
  schema: trusted<AgentTemplate[]>(),
  key: () => ["agent-templates"],
  fetch: (_: void, context) => api.agent.template.list(context),
  ...retryRead,
});
const reposQuery = defineQuery({
  schema: trusted<RepoSummary[]>(),
  key: () => ["repos"],
  fetch: (_: void, context) => api.repo.list(context),
  ...retryRead,
});
export const providerVoicesQuery = defineQuery({
  schema: trusted<ProviderVoiceListing>(),
  key: (input: ProviderVoiceRequest) => ["provider-voices", input.connection, input.revision, input.after ?? null],
  fetch: (input, context) => api.provider.voice.list(input, context),
});

export const providerQuery = defineQuery({
  schema: trusted<ProviderStatus>(),
  key: () => ["providers"],
  fetch: (_: void, context) => api.provider.get(context),
  ...retryRead,
});
export const settingsQuery = defineQuery({
  schema: trusted<SettingsStatus>(),
  key: () => ["settings"],
  fetch: (_: void, context) => api.setting.get(context),
  ...retryRead,
});
export const runtimesQuery = defineQuery({
  schema: trusted<RuntimeInfo[]>(),
  key: () => ["runtimes"],
  fetch: (_: void, context) => api.runtime.list(context),
  ...retryRead,
});

export const useSprites = () => useQuery(spritesQuery);
export const useAgents = () => useQuery(agentsQuery);
export const useAgentTemplates = () => useQuery(templatesQuery);
export const useRepos = () => useQuery(reposQuery, { interval: () => 30_000 });
export const useSettings = () => useQuery(settingsQuery);
export const useRuntimes = () => useQuery(runtimesQuery, { interval: () => 60_000 });
