import type { Health } from "@vibevalley/health/readings";

const generated = ["packages/i18n/src/catalogs.ts", "packages/protocol/src/client.ts", "packages/protocol/src/go-contract/"];

const health: Health = {
  counted: (path) =>
    /^(apps|packages)\/.+\.tsx?$/u.test(path) &&
    !path.endsWith(".d.ts") &&
    !/\.(test|spec|stories)\.tsx?$/u.test(path) &&
    !/\/(test|testing|testdata|flows)\//u.test(path) &&
    !generated.some((g) => path.startsWith(g)),
  areaOf: (path) => {
    const parts = path.split("/");
    if (path.startsWith("apps/web/src/features/") && parts.length > 5) return `web: features/${parts[4]}`;
    if (path.startsWith("apps/web/src/")) return `web: ${parts.length > 4 ? parts[3] : "app"}`;
    return parts.slice(0, 2).join("/");
  },
  hotByDesign: {
    "packages/protocol/src/shapes.ts": "Only gathers <concept>/shapes.ts now; its changes in the window are from when every shape was written here.",
    "packages/protocol/src/schema.ts": "Only gathers <concept>/schema.ts now; its changes in the window are from when every Schema was written here.",
    "packages/protocol/src/api.ts": "Puts the concepts' endpoints together; its changes in the window are from when every endpoint was written here.",
  },
  ratchet: "scripts/audit/health.ratchet.json",
  days: 30,
};

export default health;
