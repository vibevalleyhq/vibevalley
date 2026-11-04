# Agent Note: 命令行自成一个包，包之间只经包名和打好的包

Status: proposed

## Problem

[给 agent 用的命令行](.agents/notes/proposed/feature/2026-11-04-agent-first-cli.md)写完了，它还住在 `apps/server/src/cli/` 里；包和包之间也还是互相读源码。

- **命令行不是服务端**：除了 `runtime chat` 和不带参数的那一个（和农机、和 VibeValley 自己的 agent 直接聊，`cli/chat.ts`），其余命令只经 `VibeValleyApi` 和服务端说话，从服务端拿的只有四样：家目录在哪、`server.json` 写的地址（`infra/lease.ts`）、`settings.json` 里的语言（`setting/setting.ts`）、`config.ts` 的默认值。可它跟着服务端一起装、一起起，`vibevalley issue list` 也要先载入整个服务端的依赖。
- **家目录的文件各读各的**：`server.json`、`settings.json` 的语言、`desktop.sock`、渠道的家目录，服务端（`infra/lease.ts`、`setting/setting.ts`）、命令行、桌面版（`apps/desktop/src/locale.ts` 重写了一遍读语言，`channel.ts`、`control.ts`）各写一份，格式改了要记得改三处。
- **路径穿过包**：`apps/desktop/scripts/package.ts` 读 `../../server/src/assets.ts`；`site/src/lib` 读 `../../../apps/web/public/…/sprites.json`；根目录的 `scripts/` 读 `../packages/protocol/src/api.ts` 这类，一共 12 处。服务端里 50 个文件写 `../../db/generated/…`，`@/` 只是 tsconfig 的 paths，别的包载入服务端的源码时认不出它。
- **包给出去的是源码**：10 个库（`packages/` 里除了 `tsrs`）的 `exports` 都指向 `src/*.ts`，用的一方拿自己的 tsconfig、lint 和 Vite 配置去编译别人的源码；一个包的公开面只是 `exports` 的那张表，类型上没有边界，桌面版的服务端靠 `vp pack` 把这些源码再打一遍。

## Proposal

分三步，各自一个 PR。

### 1. 包之间只经包名

- 一个包只用别的包的名字（`@vibevalley/protocol/api`），不写穿出包的相对路径；lint 规则 `vibevalley/no-cross-package-path` 查（失败时说该用哪个包名、那个包要不要加一条 `exports`）。
- 服务端的 `@/…` 换成 package.json 的 `imports`（`#server/…`、`#db/…`），Node、Vite、Vitest、tsx、tsgo 都按包认它，不依赖 tsconfig 的 paths；`../../db/generated/x.sql.ts` 写成 `#db/x.sql.ts`。
- 穿包的 12 处各自改成包名：`apps/server` 给出 `exports`（`./assets`、`./testing`），`apps/web` 给出 `./sprites/*`，根目录的脚本照包名载入。
- 新包 `packages/home`（`@vibevalley/home`，只在 Node 上）：一个农场的家目录在磁盘上的约定，`homeOf`、渠道的家目录、`server.json` 的写和读、`settings.json` 的语言、`desktop.sock` 的位置；服务端、命令行、桌面版都用它，各自那一份删掉。

### 2. 命令行搬进 `apps/cli`

- `@vibevalley/cli`，`bin` 是 `vibevalley`：`cli.ts` 和 `cli/` 里除了 `chat.ts` 的都搬过去，依赖 `protocol`、`i18n`、`home`，不依赖 `apps/server`。
- **聊天留在服务端**：`runtime chat` 和不带参数的 `vibevalley` 要服务端的 runtime 表、农机和模型，留成服务端的一个程序（`vibevalley-server chat …`）；命令行起它，标准输入输出交给它。装了桌面版的，两样都在包里，`vibevalley` 的启动脚本跑命令行的包。
- **测试**：命令行的测试 dev 依赖 `@vibevalley/server/testing` 的 `farm`、`workingFarm`，进程里起整个农场，和现在一样快；另加一条冒烟测试，`vp pack` 出命令行的包，真的起一个服务端（`VIBEVALLEY_TEST_RUNTIMES`，和页面的 e2e 一样）跑 `issue new`、`issue show`。黄金数据跟着搬，`vp run golden:update cli` 照旧。
- 文档里 `vp run --filter @vibevalley/server cli` 改成 `vp run --filter @vibevalley/cli start`；`AGENTS.md` 的目录加 `apps/cli/`。

### 3. 包之间给的是打好的包

每个库用 `vp pack`（tsdown）打到 `dist/`：ES 模块、`.d.mts` 和 source map；`exports` 写成三个条件：

```json
"./api": {
  "@vibevalley/source": "./src/api.ts",
  "types": "./dist/api.d.mts",
  "default": "./dist/api.mjs"
}
```

- **跑起来的和发出去的用 `dist`**：桌面版的包、命令行的包、`vp run --filter @vibevalley/server start`。
- **开发和测试用源码**：Vite、Vitest、tsx 设 `@vibevalley/source` 条件，改一个包，页面热更新、测试马上看到，不用先打包。
- **类型照 `dist` 的 `.d.mts` 查**：`vp check` 查一个包时，它依赖的包是打好的类型，不再拿自己的配置编译别人的源码；`check` 任务 `dependsOn` 依赖的包的 `build`，带缓存，没改的包不重打。
- **页面的零件**（`base-ui`、`stories`、`engine` 里带 JSX 的）照 Solid 的库的做法，留着 JSX 打（`solid` 条件），由页面的 Vite 编译。
- 每个包的 `exports` 由 `publint` 一类的检查查：指的文件都在、类型和代码对得上。

## Alternatives considered

- **命令行留在 `apps/server`，只拆文件夹**：最省事，但命令行还是要载入整个服务端，`apps/server` 的依赖也还是命令行的；家目录的约定也没有一个主人。
- **聊天也经 HTTP**：服务端加一个流式的聊天接口，命令行只做客户端，最干净；但要新接口和新的流，`runtime chat` 今天不要服务端开着也能聊，这次先起服务端的程序，等聊天进了农场的接口再改。
- **命令行的测试一律起真的服务端进程**：边界最真，但每个测试多一两秒，帮工的替身要经环境变量配；进程里的农场加一条真进程的冒烟测试，两样都有。
- **只靠包名、不打包**（停在第 1 步）：没有构建的先后，开发最快；但用的一方仍然编译别人的源码，类型上没有边界，包能不能单独发出去也没人查。
- **全都只认 `dist`、没有源码条件**：边界最硬，但每改一个包都要先打包，页面的热更新跨不过包，测试前要等构建；源码条件只给开发和测试，`vp check` 和发出去的包照 `dist`。
- **TypeScript 的 project references**：也能让类型照声明查，但 tsgo 和 `vp check` 不走它，还要另配一套 `tsconfig`；`vp pack` 已经在打服务端，用同一个工具。

## Acceptance criteria

- `vibevalley/no-cross-package-path` 在 lint 里，仓库里没有穿出包的相对路径；服务端里没有 `@/` 和 `../../db`。
- `packages/home` 是家目录的约定的唯一一份，服务端、命令行、桌面版都用它。
- `apps/cli` 不依赖 `@vibevalley/server`（dev 依赖的 `./testing` 除外，lint 或 knip 查）；`vibevalley issue list` 不载入服务端；命令行的测试和冒烟测试都过，桌面版装的 `vibevalley` 能用、`runtime chat` 能聊。
- 每个库有 `build`，`exports` 是上面的三个条件，`vp check` 照依赖的 `.d.mts` 查类型；`desktop:test`、`package:mac` 用的是打好的包。
- 文档：[架构](docs/architecture.md)、[地基](docs/subsystems/foundation.md)写包之间怎么引用、什么时候用源码、什么时候用 `dist`；`AGENTS.md` 的目录和命令跟着改。

## Risks

- **打包的类型**：Effect 的服务和 `Effect.gen` 推出来的类型很大，`.d.mts` 可能慢或推不出来；第 3 步先打 `protocol`、`i18n` 量一下时间，再定用 tsgo 出声明还是给导出的东西写明类型（`isolatedDeclarations`）。
- **`dist` 过期**：源码条件只在开发和测试里，`vp check` 和发出去的包照 `dist`，`dependsOn` 管先后；手动起服务端前忘了打包会用到旧的，`start` 任务也 `dependsOn` 依赖的 `build`。
- **桌面版的启动脚本**：命令行和服务端成了两个包，渠道的 `~/.local/bin` 链接和 `vibevalley app` 的那几条要跟着改，`desktop:test` 和 `update-check` 跑一遍。
