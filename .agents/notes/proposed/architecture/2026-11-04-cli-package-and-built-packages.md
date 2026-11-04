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

### 3. 包之间给的是打好的类型

每个库用 `vp pack`（tsdown）打到 `dist/`：ES 模块、`.d.ts` 和指回源码的 `.d.ts.map`；`exports` 每条两个条件：

```json
"./api": { "types": "./dist/api.d.ts", "default": "./src/api.ts" }
```

- **类型照 `dist`**：`vp check`、`effect:check` 查一个包时，它依赖的包是打好的声明，不再拿自己的配置编译别人的源码；包的公开面就是它的声明。
- **代码照源码**：`vpx`、Vitest、Vite、桌面版的打包都编译 TypeScript，用源码就不会过期，也不用为跑起来先打包；`dist` 里的 JS 等到有包要单独发出去（比如命令行发到 npm）再用。
- **打好的要新**：根目录的 `packages:build` 打每个有 `pack` 的包，带缓存（缓存命中也会放回 `dist`）；`server:check`、`web:check`、`effect:check`、提交前的钩子、`vp install`（`prepare`）和 CI 的检查都先跑它。
- **工具跟着认**：测试金字塔（`testkit/src/pyramid.ts`）照 `default` 找源码；knip 照包的 tsconfig 的 `outDir` 把 `dist` 映回 `src`。
- **页面的零件**（`base-ui`、`stories`、`engine` 里带 JSX 的）照 Solid 的库的做法，留着 JSX 打（`solid` 条件）。

**试过的**（2026-11-04，`protocol`、`i18n`）：两个包各打一次不到 0.5 秒；声明保住了类型（Schema 是 `Codec<T>`，`endpoints` 有类型）；整个仓库照 `dist` 查类型全过，挪走 `dist` 就是两万多个错，确认读的是它；服务端、页面、脚本的测试、e2e 的沙箱、knip、Effect 的诊断都过。原先打算的「开发用源码的条件、跑起来用 `dist`」没有用：仓库里服务端、e2e、桌面版的开发、脚本四处用 `vpx` 直接跑源码，都要另配条件；而跑起来的本来就编译 TypeScript，只让类型读 `dist` 就得到了边界。

## Alternatives considered

- **命令行留在 `apps/server`，只拆文件夹**：最省事，但命令行还是要载入整个服务端，`apps/server` 的依赖也还是命令行的；家目录的约定也没有一个主人。
- **聊天也经 HTTP**：服务端加一个流式的聊天接口，命令行只做客户端，最干净；但要新接口和新的流，`runtime chat` 今天不要服务端开着也能聊，这次先起服务端的程序，等聊天进了农场的接口再改。
- **命令行的测试一律起真的服务端进程**：边界最真，但每个测试多一两秒，帮工的替身要经环境变量配；进程里的农场加一条真进程的冒烟测试，两样都有。
- **只靠包名、不打包**（停在第 1 步）：没有构建的先后，开发最快；但用的一方仍然编译别人的源码，类型上没有边界，包能不能单独发出去也没人查。
- **代码也照 `dist`**（开发和测试经一个源码的条件读源码）：发出去的和跑起来的一样，但仓库里四处用 `vpx` 跑源码，都要配条件，忘了配就跑旧的；跑起来的本来就编译 TypeScript，`dist` 的 JS 只在单独发包时有用。
- **TypeScript 的 project references**：也能让类型照声明查，但 tsgo 和 `vp check` 不走它，还要另配一套 `tsconfig`；`vp pack` 已经在打服务端，用同一个工具。

## Acceptance criteria

- `vibevalley/no-cross-package-path` 在 lint 里，仓库里没有穿出包的相对路径；服务端里没有 `@/` 和 `../../db`。
- `packages/home` 是家目录的约定的唯一一份，服务端、命令行、桌面版都用它。
- `apps/cli` 不依赖 `@vibevalley/server`（dev 依赖的 `./testing` 除外，lint 或 knip 查）；`vibevalley issue list` 不载入服务端；命令行的测试和冒烟测试都过，桌面版装的 `vibevalley` 能用、`runtime chat` 能聊。
- 每个库有 `build`，`exports` 是上面的两个条件，`vp check` 照依赖的 `.d.ts` 查类型。
- 文档：[架构](docs/architecture.md)、[地基](docs/subsystems/foundation.md)写包之间怎么引用、什么时候用源码、什么时候用 `dist`；`AGENTS.md` 的目录和命令跟着改。

## Risks

- **打包的类型**：`protocol`、`i18n` 很快；`agent`、`ai` 里 Effect 的服务和 `Effect.gen` 推出来的类型更大，轮到它们时再量，推不出来的给导出的东西写明类型。
- **类型过期**：改了一个包、没打包就单跑 `vp check`，别的包看到的是旧的声明，编辑器里也一样，直到 `packages:build`（钩子和各项检查都先跑它）。写文档和 `AGENTS.md` 说清，嫌烦再加 `vp pack --watch`。
- **桌面版的启动脚本**：命令行和服务端成了两个包，渠道的 `~/.local/bin` 链接和 `vibevalley app` 的那几条要跟着改，`desktop:test` 和 `update-check` 跑一遍。
