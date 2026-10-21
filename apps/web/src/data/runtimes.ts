import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** The runtimes on this machine (runtime.list), keyed ["runtimes"]; it is probed again every few minutes on the server. */
export function useRuntimes() {
  return useQuery({ queryKey: ["runtimes"], queryFn: () => api.runtime.list(), refetchInterval: 60_000 });
}
