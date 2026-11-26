import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ReleaseChannelName = "alpha" | "beta" | "release";
export type BumpIncrement = "auto" | "patch" | "minor" | "major";

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: { readonly stage: "alpha" | "beta"; readonly n: number } | undefined;
}

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/u;

export function normalizeChannel(raw: string): ReleaseChannelName | undefined {
  if (raw === "alpha" || raw === "beta" || raw === "release") return raw;
  if (raw === "final") return "release";
  return undefined;
}

export function parseVersion(raw: string): ParsedVersion | undefined {
  const match = versionPattern.exec(raw.trim());
  if (!match) return undefined;
  const stage = match[4] === "alpha" || match[4] === "beta" ? match[4] : undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: stage ? { stage, n: Number(match[5]) } : undefined,
  };
}

export function formatVersion(v: ParsedVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre ? `${base}-${v.pre.stage}.${v.pre.n}` : base;
}

export function channelOfVersion(raw: string): ReleaseChannelName | "dev" | undefined {
  const parsed = parseVersion(raw);
  if (!parsed) return undefined;
  if (parsed.major === 0 && parsed.minor === 0 && parsed.patch === 0 && !parsed.pre) return "dev";
  if (parsed.pre?.stage === "alpha") return "alpha";
  if (parsed.pre?.stage === "beta") return "beta";
  return "release";
}

function withChannel(major: number, minor: number, patch: number, channel: ReleaseChannelName, n = 1): ParsedVersion {
  switch (channel) {
    case "alpha":
      return { major, minor, patch, pre: { stage: "alpha", n } };
    case "beta":
      return { major, minor, patch, pre: { stage: "beta", n } };
    case "release":
      return { major, minor, patch, pre: undefined };
  }
}

export function bumpVersion(current: string, channel: ReleaseChannelName, increment: BumpIncrement = "auto"): string {
  const parsed = parseVersion(current);
  if (!parsed) {
    throw new Error(`Invalid current version "${current}". Expected X.Y.Z, X.Y.Z-alpha.N, or X.Y.Z-beta.N.`);
  }

  if (increment === "major") {
    return formatVersion(withChannel(parsed.major + 1, 0, 0, channel));
  }
  if (increment === "minor") {
    return formatVersion(withChannel(parsed.major, parsed.minor + 1, 0, channel));
  }
  if (increment === "patch") {
    return formatVersion(withChannel(parsed.major, parsed.minor, parsed.patch + 1, channel));
  }

  if (parsed.major === 0 && parsed.minor === 0 && parsed.patch === 0 && !parsed.pre) {
    return formatVersion(withChannel(0, 1, 0, channel));
  }

  switch (channel) {
    case "alpha": {
      if (parsed.pre?.stage === "alpha") {
        return formatVersion(withChannel(parsed.major, parsed.minor, parsed.patch, "alpha", parsed.pre.n + 1));
      }
      return formatVersion(withChannel(parsed.major, parsed.minor, parsed.patch + 1, "alpha"));
    }
    case "beta": {
      if (parsed.pre?.stage === "alpha") {
        return formatVersion(withChannel(parsed.major, parsed.minor, parsed.patch, "beta"));
      }
      if (parsed.pre?.stage === "beta") {
        return formatVersion(withChannel(parsed.major, parsed.minor, parsed.patch, "beta", parsed.pre.n + 1));
      }
      return formatVersion(withChannel(parsed.major, parsed.minor, parsed.patch + 1, "beta"));
    }
    case "release": {
      if (parsed.pre) {
        return formatVersion(withChannel(parsed.major, parsed.minor, parsed.patch, "release"));
      }
      return formatVersion(withChannel(parsed.major, parsed.minor, parsed.patch + 1, "release"));
    }
  }
}

export function scriptArgs(): string[] {
  // `vp run <script> -- --flag` keeps `--` in argv, which would otherwise halt `parseArgs` option parsing.
  return process.argv.slice(2).filter((arg) => arg !== "--");
}

export function resolveExplicitIncrement(values: {
  readonly patch: boolean;
  readonly minor: boolean;
  readonly major: boolean;
}): "patch" | "minor" | "major" | null {
  const flags = [values.patch ? "patch" : null, values.minor ? "minor" : null, values.major ? "major" : null].filter(
    (item): item is "patch" | "minor" | "major" => item !== null,
  );
  if (flags.length > 1) {
    throw new Error(`Pass at most one of --patch, --minor, or --major (received: ${flags.map((f) => `--${f}`).join(", ")})`);
  }
  return flags[0] ?? null;
}

function readPackageJson(packageJsonPath: string): Record<string, unknown> {
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON object in ${packageJsonPath}`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

export function readRootVersion(root: string): string | undefined {
  const packageJsonPath = join(root, "package.json");
  const pkg = readPackageJson(packageJsonPath);
  if (typeof pkg.version !== "string") return undefined;
  const parsed = parseVersion(pkg.version);
  return parsed ? formatVersion(parsed) : undefined;
}

export function writeRootVersion(root: string, version: string): void {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`Invalid version "${version}". Expected X.Y.Z, X.Y.Z-alpha.N, or X.Y.Z-beta.N.`);
  }
  const normalized = formatVersion(parsed);
  const packageJsonPath = join(root, "package.json");
  const pkg = readPackageJson(packageJsonPath);

  const ordered: Record<string, unknown> = {};
  let inserted = false;
  for (const [key, value] of Object.entries(pkg)) {
    if (key === "version") {
      ordered.version = normalized;
      inserted = true;
      continue;
    }
    ordered[key] = value;
    if (key === "name" && !("version" in pkg)) {
      ordered.version = normalized;
      inserted = true;
    }
  }
  if (!inserted) {
    ordered.version = normalized;
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(ordered, null, 2)}\n`);
}
