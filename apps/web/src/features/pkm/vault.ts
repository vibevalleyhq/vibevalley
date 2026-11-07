import * as S from "@vibevalley/protocol/schema";

import { api } from "#/infra/api.ts";
import { defineQuery, retryRead, useQuery, type QueryClient } from "#/infra/query.ts";

const fresh = 5_000;
const vaultQuery = defineQuery({ schema: S.PkmVault, key: () => ["pkm", "vault"], fetch: (_: void, context) => api.pkm.page.list(context), ...retryRead });
export const pkmPageQuery = defineQuery({
  schema: S.PkmPageView,
  key: (page: string) => ["pkm", "page", page],
  fetch: (page, context) => api.pkm.page.get({ page }, context),
});
const radarQuery = defineQuery({ schema: S.PkmRadar, key: () => ["pkm", "radar"], fetch: (_: void, context) => api.pkm.radar.get({}, context), ...retryRead });
export const usePkmVault = () => useQuery(vaultQuery, { interval: () => fresh });
/** Pause polling while editing; confirmed writes update the cached page. */
export const usePkmPage = (slug: () => string, quiet: () => boolean = () => false) =>
  useQuery(() => pkmPageQuery(slug()), { interval: () => (quiet() ? false : fresh) });
export const usePkmRadar = () => useQuery(radarQuery, { interval: () => 30_000 });
export const refreshPkm = (client: QueryClient) => client.invalidate({ prefix: ["pkm"] });
export const refreshVault = (client: QueryClient) =>
  Promise.all([client.invalidate({ prefix: ["pkm", "vault"] }), client.invalidate({ prefix: ["pkm", "radar"] })]);
export const pkmHref = (slug: string, block?: string) => `/pkm/${encodeURIComponent(slug)}${block ? `?b=${encodeURIComponent(block)}` : ""}`;
