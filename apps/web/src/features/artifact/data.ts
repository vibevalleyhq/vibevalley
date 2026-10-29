// Artifacts (docs/subsystems/artifact.md) are not in the frame: they are read when shown, and read again every few
// seconds while shown, so a new version a helper hands in comes up on its own.

import type { ArtifactListRequest } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { useQuery } from "../../base/query";

const fresh = 5_000;

export const useArtifact = (id: () => string) =>
  useQuery(() => ({ queryKey: ["artifacts", "one", id()], queryFn: () => api.artifact.get({ id: id() }), refetchInterval: fresh, retry: false }));

export const useArtifacts = (q: () => ArtifactListRequest) =>
  useQuery(() => ({ queryKey: ["artifacts", "list", q()], queryFn: () => api.artifact.list(q()), refetchInterval: fresh }));

/** Where an artifact is looked at; a version other than the latest is in the query string. */
export const artifactHref = (id: string, version?: number) => `/artifacts/${id}${version ? `?v=${version}` : ""}`;
