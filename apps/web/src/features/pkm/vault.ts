import { api } from "#/infra/api.ts";
import { queries, useQuery } from "#/infra/query.ts";

const fresh = 5_000;

export const usePkmVault = () => useQuery(() => ({ queryKey: ["pkm", "vault"], queryFn: () => api.pkm.page.list(), refetchInterval: fresh }));

/** quiet: while a block is being written the page is not read again on its own; the edits' answers bring it. */
export const usePkmPage = (slug: () => string, quiet: () => boolean = () => false) =>
  useQuery(() => ({
    queryKey: ["pkm", "page", slug()],
    queryFn: () => api.pkm.page.get({ page: slug() }),
    refetchInterval: quiet() ? false : fresh,
    retry: false,
  }));

export const usePkmRadar = () => useQuery(() => ({ queryKey: ["pkm", "radar"], queryFn: () => api.pkm.radar.get({}), refetchInterval: 30_000 }));

/** After a change: every notes read again, the open page first. */
export const refreshPkm = () => queries.invalidateQueries({ queryKey: ["pkm"] });

export const refreshVault = () =>
  Promise.all([queries.invalidateQueries({ queryKey: ["pkm", "vault"] }), queries.invalidateQueries({ queryKey: ["pkm", "radar"] })]);

/** A page's address; block: the block to show and light up on it. */
export const pkmHref = (slug: string, block?: string) => `/pkm/${encodeURIComponent(slug)}${block ? `?b=${encodeURIComponent(block)}` : ""}`;
