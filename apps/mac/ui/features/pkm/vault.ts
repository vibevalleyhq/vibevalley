import { api } from "../../infra/api";
import { defineQuery, retryRead, useQuery, type QueryClient } from "../../infra/query";

const fresh = 5_000;
const vaultQuery = defineQuery({
  key: () => ["pkm", "vault"],
  fetch: (_: void, context) => api.pkm.page.list(context),
  ...retryRead,
});
export const pkmPageQuery = defineQuery({
  key: (page: string) => ["pkm", "page", page],
  fetch: (page, context) => api.pkm.page.get({ page }, context),
});
export const usePkmVault = () => useQuery(vaultQuery, { interval: () => fresh });
/** Pause polling while editing; confirmed writes update the cached page. */
export const usePkmPage = (slug: () => string, quiet: () => boolean = () => false) =>
  useQuery(() => pkmPageQuery(slug()), { interval: () => (quiet() ? false : fresh) });
export const refreshPkm = (client: QueryClient) => client.invalidate({ prefix: ["pkm"] });
export const refreshVault = (client: QueryClient) => client.invalidate({ prefix: ["pkm", "vault"] });
export const pkmHref = (slug: string, block?: string) => `/pkm/${encodeURIComponent(slug)}${block ? `?b=${encodeURIComponent(block)}` : ""}`;
