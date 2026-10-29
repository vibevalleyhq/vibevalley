/**
 * This repository's say in its health readings (packages/health): what is production code, how files group into areas,
 * and which files are hot by design. `vp run health` prints the report; `vp run health:verify` holds the escape ratchet.
 */

import type { Health } from "@vibevalley/health/readings";
import { moduleOf } from "../apps/server/src/modules.ts";

const generated = ["apps/server/db/generated/", "packages/i18n/src/catalogs.ts", "packages/protocol/src/client.ts"];

const health: Health = {
  counted: (path) =>
    /^(apps|packages)\/.+\.tsx?$/.test(path) &&
    !path.endsWith(".d.ts") &&
    !/\.(test|spec|stories)\.tsx?$/.test(path) &&
    !/\/(test|testing|testdata|flows)\//.test(path) &&
    !generated.some((g) => path.startsWith(g)),
  areaOf: (path) => {
    const parts = path.split("/");
    if (path.startsWith("apps/server/src/")) return `server: ${moduleOf(parts.slice(3).join("/"))?.name ?? parts[3]}`;
    if (path.startsWith("apps/web/src/features/") && parts.length > 5) return `web: features/${parts[4]}`;
    if (path.startsWith("apps/web/src/")) return `web: ${parts.length > 4 ? parts[3] : "app"}`;
    return parts.slice(0, 2).join("/");
  },
  hotByDesign: {
    "packages/protocol/src/shapes.ts": "The contract: every new field the frame or an endpoint carries is written here.",
    "packages/protocol/src/schema.ts": "Each shape's Schema, so it changes with shapes.ts.",
    "packages/protocol/src/api.ts": "The endpoint table: every new endpoint is a line here.",
  },
  ratchet: "scripts/health.ratchet.json",
  days: 30,
};

export default health;
