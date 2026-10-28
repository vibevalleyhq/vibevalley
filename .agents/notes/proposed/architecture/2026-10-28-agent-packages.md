# Agent Note: VibeValley 自己的 agent 拆成 packages/ai 和 packages/agent，server 只组装

Status: proposed

## Problem

VibeValley 自己的 agent（[VibeValley 自己的 agent](docs/subsystems/brain.md)）三层都在 `apps/server/src` 里：`ai`（模型请求）、`agent/loop`（循环）、`agent/brain`（Brain）。它们和农场的边界只靠约定：

- `ai` 和 `agent/loop` 不 import server 的任何东西，`brain` 有几处外溢：自己的任务存进库（`agentTaskStore.ts` 用 `base/db` 和生成的查询）、给主人看的话（`config.ts` 的 `noDeepSeekKey`、`run.ts` 的 `modelFailed` 用 `t()`）、主人的语言（`prompts.ts` 的 `helperInstructions` 读 `ownersLanguage`）、`base/time`、`base/text`、`base/json`、`base/dag`。没有检查挡着新的外溢。
- 服务端有好几处只要模型、不要 agent（工具参数的 JSON Schema：`tool/schemas.ts`、`mcp/mcp.ts`；模型表和价格：`runtime/price.ts`），却和 agent 放在一起。
- 以后服务端的模块要在进程里起短命的 agent 干小活，agent 要先有清楚的边界。

## Proposal

### 包

| 包 | 放什么 | 依赖 |
|---|---|---|
| `packages/ai`（`@vibevalley/ai`） | 现在的 `apps/server/src/ai`：请求和流、消息形状、模型表和价格、工具参数、照脚本回答的测试模型（`testing.ts`）、黄金数据 | `effect` |
| `packages/agent`（`@vibevalley/agent`） | `core/`：循环（现在的 `agent/loop/agent.ts` → `core/loop.ts`）、`Tool` 和建工具的函数（现在的 `brain/tool.ts` → `core/tool.ts`）；其余是 Brain（`brain/agent.ts` → `brain.ts`）、对话文件、压缩、提示开头、技能、记性、帮手、自己的任务（规则和接口、内存里的存储）、提醒；`coding.ts`、`mcp.ts` 各是单独的入口 | `@vibevalley/ai`、`effect`、`@modelcontextprotocol/sdk` |
| `packages/testkit`（`@vibevalley/testkit`，只在 devDependencies） | 测试共用的：黄金数据（`golden.ts`，按文件路径）、在真实时间上等条件（`until.ts` 里和农场无关的那些）、测试金字塔（`pyramid.ts`、`budgets.ts`，能解析 workspace 包） | `vite-plus` |

每个包照 Vite+ 的 monorepo 写法：`package.json` 的 `exports`（`"./*": "./src/*.ts"` 这样按文件导出，`@vibevalley/agent/core/loop`）、`vite.config.ts` 只放 `test` 和 `run.tasks.test`、`tsconfig.json` 继承根目录的；版本写 `catalog:`。

### server 留什么

- 组装：档案 → `BrainOptions`（管家经 `session/host.ts`、命令行）；农场的工具（`tool`）照 `@vibevalley/agent/core` 的 `Tool` 写。
- 适配：农机 `vibevalley`（`agent/brain/runtime.ts` → `runtime/vibevalley.ts`，它依赖 oar，`helperInstructions` 跟着它）；`/v1/chat/completions`（`agent/brain/openai.ts` → `orchestrator/openai.ts`：它只读最后一句、靠 agent 自己记着对话，是管家的入口，不是通用协议）；自己的任务存进库（`agent/taskStore.ts`，表 `agent_task` 仍归 `agent` 模块）。
- 给主人看的话：包里不 import `@vibevalley/i18n`。缺钥匙是包里的一个错误类（`MissingKey`），模型出错时 `RunResult.error` 只带模型自己的话，由 server 和命令行说给主人。
- 模型和钥匙的组合 `LLM`（`brain/config.ts`）改名 `ModelClient`，进 `@vibevalley/ai`，和传输的 `Llm` 服务分开。
- `base/dag.ts` 进 `@vibevalley/agent`（`dag.ts`），种植计划（`task/graph.ts`）用它。真实时间的两个小函数（`afterRealTime`、`withinRealTime`）包里另有一份（`realTime.ts`），server 的 `base/time.ts` 照旧。

### 检查

- **方向**：lint 的 `no-restricted-imports` 按目录挡：`packages/ai/**` 不 import `@vibevalley/agent`、`@vibevalley/server`；`packages/agent/src/core/**` 不 import Brain 的文件；`packages/**` 不 import `apps/`、`@vibevalley/i18n`、`@vibevalley/protocol`。
- **lint 的覆盖**：`no-console`、`vibevalley/no-wall-clock` 扩到两个包；`realTime.ts` 和测试豁免 `no-wall-clock`。
- **测试金字塔**：`pyramid.ts` 跟着 `@vibevalley/*` 的 import 进包里的文件，server 的测试经包碰到子进程或网络的，照样算模块测试；两个包各用 `budgets` 报告。
- **黄金数据**：`goldenCases` 收文件路径；`vp run golden:update -- ai` 认包名，在 `packages/<名字>` 里跑。
- **任务和 CI**：`server:check` 加上 `@vibevalley/ai`、`@vibevalley/agent`、`@vibevalley/testkit` 的 `test`；CI 的 server 那一段同样。
- **交付**：桌面打包和开发时的重启已经按 `package.json` 的 workspace 依赖找包（#146），新包自动在内。

### 做的顺序（一个 PR，一步一个提交）

1. `packages/testkit`：黄金数据、等待、金字塔；server 的测试改用它。
2. 原地拆接缝：存库的任务存储挪到 `agent/taskStore.ts`；`MissingKey` 和不带 `t()` 的 `RunResult`；`helperInstructions` 跟着农机适配器；`reminders.ts` 直接用 `Schema.fromJsonString`；`dag.ts`、`realTime.ts`。
3. `packages/ai`：搬文件、`ModelClient`、改所有 import、测试和黄金数据。
4. `packages/agent`：先 `core`，再 Brain；`runtime/vibevalley.ts`、`orchestrator/openai.ts`。
5. 检查和任务：lint 的方向和覆盖、金字塔、`golden:update`、`server:check`、CI。
6. 文档：[VibeValley 自己的 agent](docs/subsystems/brain.md)、[地基](docs/subsystems/foundation.md)、`AGENTS.md` 的目录和命令、各包的 README；本篇删掉。

## Alternatives considered

**`ai` 和 agent 放一个包。** 工具参数的 Schema 和价格只要模型，就得依赖整个 agent。

**循环单独一个包。** 循环只有 Brain 和以后的短命 agent 用；子路径 `core` 加 lint 的方向检查就够了，多一个包多一份配置。

**`openai.ts`、MCP 客户端留在 Brain 的入口里。** `openai.ts` 是管家的 HTTP 入口；MCP 客户端和编码工具要起子进程，只用 `core` 的地方不该加载它们。

**测试工具复制一份到包里。** 黄金数据的读写和更新、金字塔的分层各有两份，改一处另一处不跟。

**server 的 `agent` 模块改名 `profile`。** 和包名没有技术冲突；表 `agent_task` 归 `agent` 模块，改名要先定它归谁。另做。

## Acceptance criteria

- `apps/server/src` 里没有 `ai/`、`agent/loop/`、`agent/brain/`；两个包里没有 `apps/`、`@vibevalley/i18n`、`@vibevalley/protocol` 的 import，lint 挡着。
- 黄金数据（`ai/testdata`、`declared.json`）和管家的提示开头逐字节不变（`tool/testdata/parameters.json`、`agent/brain/testdata/declared.json` 的测试照旧过）。
- `vp check`、`vp run server:check`、`vp run web:check`、页面 e2e、`vp run desktop:test` 通过；`vp run package:mac` 打出的包在仓库外能起服务端。
- 命令行 `vibevalley`（自己的 agent）和农机 `vibevalley` 各真跑一轮（照脚本回答的模型）。

## Risks

- **改名的 import 多**：七十多个文件。按步提交，每步跑 `vp check` 和相关测试。
- **`isolate: false` 和模块状态**：server 的测试把模块加载一次；包里的测试各有自己的配置，不受它影响。
