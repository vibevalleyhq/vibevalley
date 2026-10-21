// Writes docs/reference/capabilities.md from the endpoint table (packages/protocol/src/api.ts): who may call each
// endpoint, by its `can`. --check fails when the file is not what the table says (docs:verify runs it).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endpoints } from "../packages/protocol/src/api.ts";

const out = join(import.meta.dirname, "..", "docs/reference/capabilities.md");

const head = `# 能力表

由 \`scripts/capabilities.ts\` 从 \`packages/protocol/src/api.ts\` 的 \`endpoints\`（每个接口的 \`can\`）写出，不手改；\`pnpm run docs:verify\` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 主人 | 主人在农场那台电脑上 | 页面、命令行 |
| 连进来的设备 | 主人配对过的手机、另一台电脑 | 经「连接到本机」只放这一列打了 ✓ 的 |
| 管家 | 管家 | 只是记下，不按它放行：管家的工具另写在 \`apps/server/src/tool\` |

帮工没有接口：它们经 \`/mcp\` 用 \`apps/server/src/tool\` 的工具。

\`GET /api/v1/state\`、\`GET /api/v1/events\` 和 \`GET /api/v1/live\` 是 SSE，不在 \`endpoints\` 里：主人和连进来的设备都能读；\`/state\` 给折好的帧，\`/live\` 只给页面要的三种 side event，\`/events\` 留给命令行和调试。接口都在 \`/api/v1\` 下；换成不兼容的形状时另起 \`/api/v2\`，\`v1\` 留到设备都升级（[理由](docs/subsystems/core.md)）。
`;

const groups = new Map<string, typeof endpoints>();
for (const e of endpoints) {
  const g = e.op.split(".")[0]!;
  groups.set(g, [...(groups.get(g) ?? []), e]);
}
const mark = (on: boolean) => (on ? "✓" : " ");
let text = head;
for (const [g, list] of groups) {
  text += `\n## ${g}\n\n| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |\n|---|---|---|---|---|\n`;
  for (const e of list)
    text += `| \`${e.op}\` | \`${e.method} ${e.path}\` | ${mark(e.can.includes("owner"))} | ${mark(e.can.includes("remote"))} | ${mark(e.can.includes("manager"))} |\n`;
}

if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("capabilities: docs/reference/capabilities.md is stale: run pnpm run capabilities");
    process.exit(1);
  }
} else writeFileSync(out, text);
