// Papertrails static asset URLs rooted at the host's `assets/` directory (`host.assetsDir`).
import { ConnectorIDValues, SpeciesValues } from "@vibevalley/protocol";

import { useDesignHost } from "./host";

export const ROLE_AVATARS = [
  "avatar-orchestrator",
  "avatar-fullstack",
  "avatar-architect",
  "avatar-frontend",
  "avatar-backend",
  "avatar-reviewer",
  "avatar-tester",
  "avatar-designer",
  "avatar-product",
  "avatar-scout",
  "avatar-docs",
  "avatar-pages",
  "avatar-slides",
  "avatar-collector",
] as const;

const ROLE_AVATAR_SET = new Set<string>(ROLE_AVATARS);

const SPECIES_PORTRAITS: ReadonlySet<string> = new Set<string>([...SpeciesValues, "shiba"]);

const ORCHESTRATOR_PORTRAIT_KEY: Readonly<Record<string, string>> = {
  farmer: "default",
  default: "default",
  auntie: "auntie",
  foreman: "foreman",
  gardener: "gardener",
  grandpa: "grandpa",
  robot: "robot",
};

const ENGINE_LOGOS = new Set(["antigravity", "claude", "codex", "cursor", "dsh", "grok", "kimi", "opencode", "pi", "vibevalley"]);

const CONNECTOR_EMBLEMS: ReadonlySet<string> = new Set<string>(ConnectorIDValues);

/** Root `assets/` folder on disk, undefined until the host answers (or when unavailable). */
export function useAssetsDir(): () => string | undefined {
  return useDesignHost().useAssetsDir();
}

/** Builds a `file://` URL for `relPath` inside the host's `assets/` root. */
const assetUrl = (dir: string, relPath: string) => `file://${encodeURI(`${dir.replace(/\/+$/u, "")}/${relPath.replace(/^\/+/u, "")}`)}`;

export function roleAvatarUrl(dir: string, avatar: string | undefined): string | undefined {
  if (!avatar || !ROLE_AVATAR_SET.has(avatar)) return undefined;
  return assetUrl(dir, `avatars/${avatar}.png`);
}

export function speciesPortraitUrl(dir: string, species: string): string {
  const key = SPECIES_PORTRAITS.has(species) ? species : "bear";
  return assetUrl(dir, `avatars/species-${key}.png`);
}

export function orchestratorPortraitUrl(dir: string, look: string, railDpr?: 1 | 2): string {
  const key = ORCHESTRATOR_PORTRAIT_KEY[look] ?? "default";
  if (railDpr === 1 || railDpr === 2) return assetUrl(dir, `avatars/rail/manager-${key}-${railDpr}x.png`);
  return assetUrl(dir, `avatars/manager-${key}.png`);
}

export const ownerPortraitUrl = (dir: string): string => assetUrl(dir, "avatars/owner.png");

export function engineLogoUrl(dir: string, runtime: string | undefined): string | undefined {
  if (!runtime) return undefined;
  const key = runtime.toLowerCase().replace(/^acp:/u, "");
  return ENGINE_LOGOS.has(key) ? assetUrl(dir, `engines/${key}.png`) : undefined;
}

export function connectorEmblemUrl(dir: string, id: string): string | undefined {
  return CONNECTOR_EMBLEMS.has(id) ? assetUrl(dir, `engines/connector-${id}.png`) : undefined;
}
