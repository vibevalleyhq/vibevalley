import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vite-plus/test";

const root = resolve(import.meta.dirname, "..");

/** The workspace's package.json files, as pnpm-workspace.yaml lists them (apps/*, packages/*) and the root's. */
const manifests = [
  "package.json",
  ...["apps", "packages"].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${dir}/${e.name}/package.json`),
  ),
];

test("every version the workspace uses is in pnpm-workspace.yaml's catalogs", () => {
  const written: string[] = [];
  for (const file of manifests) {
    const pkg = JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
      for (const [name, spec] of Object.entries(pkg[field] ?? {}))
        if (!spec.startsWith("catalog:") && !spec.startsWith("workspace:")) written.push(`${file} ${field} ${name}: ${spec}`);
  }
  expect(written, 'say "catalog:" and put the version in pnpm-workspace.yaml').toEqual([]);
});

test("every package is named @vibevalley/<its folder>, the root vibevalley", () => {
  const named = manifests.map((file) => [file, (JSON.parse(readFileSync(join(root, file), "utf8")) as { name?: string }).name]);
  const want = (file: string) => (file === "package.json" ? "vibevalley" : `@vibevalley/${file.split("/")[1]}`);
  expect(named.filter(([file, name]) => name !== want(file!))).toEqual([]);
});
