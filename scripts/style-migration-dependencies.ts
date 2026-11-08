import type { StyleFinding } from "./style-migration-scan";

const record = (input: unknown): Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null ? Object.fromEntries(Object.entries(input)) : {};
const tailwind = (name: string) => /^(?:@tailwindcss\/|tailwind(?:css)?(?:[-@]|$)|prettier-plugin-tailwindcss(?:@|$))/u.test(name);
const astro = (name: string) => /^(?:@astrojs\/|astro(?:@|$))/u.test(name);
const packageName = (key: string) =>
  key
    .split("@")
    .slice(0, key.startsWith("@") ? 2 : 1)
    .join("@");

function formatterParsers(input: unknown): ReadonlySet<string> {
  const documents = Array.isArray(input) ? input : [input];
  const snapshots = documents.flatMap((document) => Object.entries(record(record(document).snapshots)));
  const allowed = new Set<string>();
  for (const [name, value] of snapshots)
    if (packageName(name) === "oxfmt" && typeof record(record(value).optionalDependencies)["@astrojs/compiler-rs"] === "string")
      allowed.add("@astrojs/compiler-rs");
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, value] of snapshots)
      if (allowed.has(packageName(name))) {
        for (const field of ["dependencies", "optionalDependencies"])
          for (const dependency of Object.keys(record(record(value)[field]))) {
            if (astro(dependency) && !allowed.has(dependency)) {
              allowed.add(dependency);
              changed = true;
            }
          }
      }
  }
  for (const document of documents)
    for (const importer of Object.values(record(record(document).importers))) {
      for (const field of ["dependencies", "devDependencies", "optionalDependencies"])
        for (const [name, spec] of Object.entries(record(record(importer)[field]))) {
          allowed.delete(name);
          const version = record(spec).version;
          if (typeof version === "string" && astro(version)) allowed.delete(packageName(version));
        }
    }
  changed = true;
  while (changed) {
    changed = false;
    for (const [name, value] of snapshots)
      if (packageName(name) !== "oxfmt" && !allowed.has(packageName(name))) {
        for (const field of ["dependencies", "optionalDependencies"])
          for (const dependency of Object.keys(record(record(value)[field]))) {
            if (allowed.delete(dependency)) changed = true;
          }
      }
  }
  return allowed;
}

export function scanStyleDependencies(path: string, input: unknown) {
  const findings: StyleFinding[] = [];
  const classifications: { path: string; offset: number; kind: string }[] = [];
  const parsers = path === "pnpm-lock.yaml" ? formatterParsers(input) : new Set<string>();
  const inspect = (value: unknown, trail: string[] = []): void => {
    const object = record(value);
    for (const [key, child] of Object.entries(object)) {
      if (key === "peerDependencies") {
        const metadata = record(object.peerDependenciesMeta);
        for (const [peer, range] of Object.entries(record(child))) {
          if (record(metadata[peer]).optional === true) classifications.push({ path, offset: 0, kind: `optional-peer-metadata:${peer}` });
          else if (tailwind(peer) || astro(peer))
            findings.push({
              category: tailwind(peer) ? "tailwind-dependency" : "astro-dependency",
              path,
              offset: 0,
              evidence: `${[...trail, key, peer].join(".")}: ${String(range)}`,
            });
        }
        continue;
      }
      if (key === "peerDependenciesMeta") continue;
      if (tailwind(key) || astro(key)) {
        if (astro(key) && parsers.has(packageName(key))) classifications.push({ path, offset: 0, kind: `formatter-only-parser:${packageName(key)}` });
        else findings.push({ category: tailwind(key) ? "tailwind-dependency" : "astro-dependency", path, offset: 0, evidence: [...trail, key].join(".") });
      }
      if (typeof child === "object" && child !== null) inspect(child, [...trail, key]);
    }
  };
  inspect(input);
  return { findings, classifications };
}
