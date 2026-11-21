import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { endpoints, pathOf } from "@vibevalley/protocol/api";

const root = join(import.meta.dirname, "../..");
const out = join(root, "docs/reference/capabilities.md");

interface Nested {
  readonly [k: string]: string | Nested;
}

const cliMessages = new Map<string, string>();
const walk = (prefix: string, v: string | Nested) => {
  if (typeof v === "string") cliMessages.set(prefix, v);
  else for (const [k, x] of Object.entries(v)) walk(`${prefix}.${k}`, x);
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- cli.json is validated by scripts/gen/i18n.ts check
walk("cli", JSON.parse(readFileSync(join(root, "crates/vibevalley-i18n/locales/zh/cli.json"), "utf8")) as Nested);

const maybe = (key: string): string | undefined => cliMessages.get(key);
const t = (key: string): string => cliMessages.get(key) ?? key;

const head = `# 能力表

由 \`scripts/gen/capabilities.ts\` 从 \`packages/protocol/src/api.ts\` 的 \`endpoints\`（每个接口的 \`can\`）写出，不手改；\`vp run docs:verify\` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 用户 | 用户在农场那台电脑上 | 页面、命令行 |
| 连进来的设备 | 用户配对过的手机、另一台电脑 | 「连接到本机」随手机壳砍掉了，Rust 服务端没有这道门；这一列留在契约里 |
| 助手 | 助手 | 它的工具；Rust 服务端的工具清单在 \`crates/vibevalley-server/assets/tools/orchestrator.json\`，以那份为准 |
| 帮工 | 在干活的帮工 | 经 \`/mcp\` 拿的工具，清单在 \`crates/vibevalley-server/assets/tools/helper.json\` |

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
  text += `\n## ${g}\n\n${maybe(`cli.group.${g}.about`) ?? ""}\n\n| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 助手 | 帮工 |\n|---|---|---|---|---|---|---|\n`;
  for (const e of list)
    text += `| \`${e.op}\` | ${t(`cli.op.${e.op}`)} | \`${pathOf(e.op)}\` | ${mark(e.can.includes("user"))} | ${mark(e.can.includes("remote"))} | ${mark(e.can.includes("orchestrator"))} | ${mark(e.can.includes("session"))} |\n`;
}

if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("capabilities: docs/reference/capabilities.md is stale: run vp run capabilities");
    process.exit(1);
  }
} else writeFileSync(out, text);
