import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { endpoints, pathOf } from "@vibevalley/protocol/api";

const root = join(import.meta.dirname, "../..");
const out = join(root, "docs/reference/capabilities.md");

interface Nested {
  readonly [k: string]: string | Nested;
}

const copy = new Map<string, string>();
const walk = (prefix: string, v: string | Nested) => {
  if (typeof v === "string") copy.set(prefix, v);
  else for (const [k, x] of Object.entries(v)) walk(`${prefix}.${k}`, x);
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- static docs copy owned by this generator
walk("cap", JSON.parse(readFileSync(join(root, "scripts/gen/capabilities-zh.json"), "utf8")) as Nested);

const maybe = (key: string): string | undefined => copy.get(key);
const t = (key: string): string => copy.get(key) ?? key;

const head = `# 能力表

由 \`scripts/gen/capabilities.ts\` 从 \`packages/protocol/src/api.ts\` 的 \`endpoints\`（每个接口的 \`can\`）写出，不手改；\`vp run docs:verify\` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 用户 | 用户在运行 VibeValley 的这台电脑上 | 页面、命令行 |
| 连进来的设备 | 用户配对过的手机、另一台电脑 | 「连接到本机」随手机壳砍掉了，Rust 服务端没有这道门；这一列留在契约里 |
| 主助手 | 主助手 | 它的工具；Rust 服务端的工具清单在 \`crates/server/assets/tools/orchestrator.json\`，以那份为准 |
| 执行会话 | 运行中的执行会话 | 经 \`/mcp\` 拿的工具，清单在 \`crates/server/assets/tools/helper.json\` |

\`GET /api/v1/slice/{name}\`（\`name\` 为 \`board\`、\`sessions\`、\`collab\`、\`inbox\`、\`ops\` 五个核心切片或独立的 \`farm\` 画面）、\`GET /api/v1/live\` 和 \`GET /api/v1/events\` 不在 \`endpoints\` 里：用户和连进来的设备都能读；\`/slice/{name}\` 带 \`Accept: application/json\` 或 \`?once=1\` 返回当前 JSON 快照，否则是支持 \`Last-Event-ID\`／\`?after=<seq>\` 续读的 SSE，\`/live\`（别名 \`/events\`）只推页面要的三种实时 side event。接口都在 \`/api/v1\` 下；不兼容改动和 v1 的保留见 [接口版本](docs/subsystems/core.md#为什么这样)。
`;

const groups = new Map<string, typeof endpoints>();
for (const e of endpoints) {
  const g = e.op.split(".")[0]!;
  groups.set(g, [...(groups.get(g) ?? []), e]);
}
const mark = (on: boolean) => (on ? "✓" : " ");
let text = head;
for (const [g, list] of groups) {
  text += `\n## ${g}\n\n${maybe(`cap.group.${g}.about`) ?? ""}\n\n| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |\n|---|---|---|---|---|---|---|\n`;
  for (const e of list)
    text += `| \`${e.op}\` | ${t(`cap.op.${e.op}`)} | \`${pathOf(e.op)}\` | ${mark(e.can.includes("user"))} | ${mark(e.can.includes("remote"))} | ${mark(e.can.includes("orchestrator"))} | ${mark(e.can.includes("session"))} |\n`;
}

if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("capabilities: docs/reference/capabilities.md is stale: run vp run capabilities");
    process.exit(1);
  }
} else writeFileSync(out, text);
