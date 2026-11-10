import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { maybe, t } from "@vibevalley/i18n";
import { endpoints, pathOf } from "@vibevalley/protocol/api";

const out = join(import.meta.dirname, "..", "docs/reference/capabilities.md");

const head = `# 能力表

由 \`scripts/capabilities.ts\` 从 \`packages/protocol/src/api.ts\` 的 \`endpoints\`（每个接口的 \`can\`）写出，不手改；\`vp run docs:verify\` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 用户 | 用户在农场那台电脑上 | 页面、命令行 |
| 连进来的设备 | 用户配对过的手机、另一台电脑 | 经「连接到本机」只放这一列打了 ✓ 的 |
| 管家 | 管家 | 它的工具：打了 ✓ 的每个接口是它的一个工具（\`channel.message.list\` 是 \`channel_message_list\`），\`apps/server/src/tool\` 照这一列给 |
| 帮工 | 在干活的帮工 | 经 \`/mcp\` 拿的工具，同上 |

\`GET /api/v1/state\`、\`GET /api/v1/events\` 和 \`GET /api/v1/live\` 是 SSE，不在 \`endpoints\` 里：用户和连进来的设备都能读；\`/state\` 给折好的帧，\`/live\` 只给页面要的三种 side event，\`/events\` 留给调试。接口都在 \`/api/v1\` 下；不兼容改动和 v1 的保留见 [接口版本](docs/subsystems/core.md#为什么这样)。
`;

const groups = new Map<string, typeof endpoints>();
for (const e of endpoints) {
  const g = e.op.split(".")[0]!;
  groups.set(g, [...(groups.get(g) ?? []), e]);
}
const mark = (on: boolean) => (on ? "✓" : " ");
let text = head;
for (const [g, list] of groups) {
  text += `\n## ${g}\n\n${maybe(`cli.group.${g}.about`) ?? ""}\n\n| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 管家 | 帮工 |\n|---|---|---|---|---|---|---|\n`;
  for (const e of list)
    text += `| \`${e.op}\` | ${t(`cli.op.${e.op}`)} | \`${pathOf(e.op)}\` | ${mark(e.can.includes("user"))} | ${mark(e.can.includes("remote"))} | ${mark(e.can.includes("orchestrator"))} | ${mark(e.can.includes("session"))} |\n`;
}

if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("capabilities: docs/reference/capabilities.md is stale: run vp run capabilities");
    process.exit(1);
  }
} else writeFileSync(out, text);
