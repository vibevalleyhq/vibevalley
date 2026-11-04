// The notes are not in the frame: they are read when shown and read again every few seconds, so a file changed in another
// editor comes up on its own (the server reads it again when its file changed).

import { api } from "@/infra/api";
import { queries, useQuery } from "@/infra/query";

const fresh = 5_000;

export const usePkmVault = () => useQuery(() => ({ queryKey: ["pkm", "vault"], queryFn: () => api.pkm.page.list(), refetchInterval: fresh }));

export const usePkmPage = (slug: () => string) =>
  useQuery(() => ({ queryKey: ["pkm", "page", slug()], queryFn: () => api.pkm.page.get({ page: slug() }), refetchInterval: fresh, retry: false }));

export const usePkmRadar = () => useQuery(() => ({ queryKey: ["pkm", "radar"], queryFn: () => api.pkm.radar.get({}), refetchInterval: 30_000 }));

/** After a change: every notes read again, the open page first. */
export const refreshPkm = () => queries.invalidateQueries({ queryKey: ["pkm"] });

export const pkmHref = (slug: string) => `/pkm/${encodeURIComponent(slug)}`;
