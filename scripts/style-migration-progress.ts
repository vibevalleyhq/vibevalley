import type { StyleFinding } from "./style-migration-scan";

const areas = [
  "apps/web/src/ui",
  "apps/web/src/features",
  "apps/web/src/farm",
  "apps/web/src/tree",
  "apps/web/src/app",
  "apps/web/src/stories",
  "apps/web",
  "apps/site",
  "packages/stories",
  "packages/base-ui",
  "design",
];

export function migrationProgress(findings: readonly StyleFinding[]) {
  const grouped = new Map<string, { categories: Record<string, number>; tokenFiles: Set<string>; classTokens: number }>();
  const tokenFiles = new Set<string>();
  let classTokens = 0;
  for (const finding of findings) {
    const area = areas.find((prefix) => finding.path.startsWith(`${prefix}/`)) ?? "other";
    let group = grouped.get(area);
    if (group === undefined) {
      group = { categories: {}, tokenFiles: new Set(), classTokens: 0 };
      grouped.set(area, group);
    }
    group.categories[finding.category] = (group.categories[finding.category] ?? 0) + 1;
    if (finding.category === "unconverted-class-token") {
      classTokens++;
      group.classTokens++;
      group.tokenFiles.add(finding.path);
      tokenFiles.add(finding.path);
    }
  }
  return {
    classTokens,
    filesWithClassTokens: tokenFiles.size,
    areas: [...grouped.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([area, group]) => ({
        area,
        classTokens: group.classTokens,
        filesWithClassTokens: group.tokenFiles.size,
        categories: group.categories,
      })),
  };
}
