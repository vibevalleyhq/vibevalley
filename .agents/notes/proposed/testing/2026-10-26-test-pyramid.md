# Agent Note: 测试金字塔：每层从一个接缝进，边界由检查守住

Status: proposed

## Problem

测试的层现在只有 [foundation](docs/subsystems/foundation.md) 里的一句预算（流程 2 秒，其余 300 毫秒），没有边界：

- 一个测试属于哪一层是按路径猜的：`src/flows` 下的算流程，别的都算 300 毫秒的那一档。纯规则的测试和搭农场的测试用一样的文件名，金字塔的形状看不出来。
- 服务端 84 个测试文件里，7 个是流程，29 个搭服务、用库或 git，48 个只碰进程里的代码（纯规则，或带假端口的组件）。没有哪条规矩说一个测试该从哪里进系统、能把什么换成假的。
- 页面这边已经干净：26 个 Playwright 文件只经 `fixtures` 和协议进服务端，30 个单元测试只测页面自己的逻辑。但没有检查守着。
- 测试里还有十来处写死的 sleep 和自己写的轮询。

## Proposal

**一层就是一个接缝。** 测试从这个接缝进系统；接缝以内是真的，接缝外的世界只在端口上换成假的。

| 层 | 从哪进 | 真的 | 换成假的（端口） | 时间 | 预算 | 在哪 |
|---|---|---|---|---|---|---|
| 规则 | 函数和类的接口，在进程里 | 被测的代码 | 假模型（faux）、脚本帮工、手写的假端口 | 参数或 `TestClock` | 20 毫秒 | 各模块 |
| 模块 | 一个模块的服务接口（`Context.Service`） | 它和它下面的层：测试库池里的库、模块自己拥有的 git 和子进程 | 编码 agent（脚本帮工）、模型、聊天软件、GitHub、声网 | `TestClock`；真时间只用于真进程的期限（`afterRealTime`）和等后台（`until`、`whenState`） | 300 毫秒 | 各模块 |
| 流程 | 整座农场（`flows/farm.ts`） | 全部模块、真 git | 同上 | 同上 | 2 秒 | `src/flows` |
| 页面 | HTTP 和 SSE（`api.ts`、`StateFrame`） | 一个真的服务端进程 | 环境里没有钥匙；runtime 换成照字眼干活的帮工 | 真时间 | 3 秒 | `apps/web/test` |
| 整个应用 | 宿主接口（`packages/host`） | Electron、模拟器 | — | 真时间 | 不设 | `apps/desktop`、`apps/mobile` |
| 真模型 | 管家的提示和工具描述 | 真模型 | — | — | 不计；手动跑，先问主人 | 评测样例、`acceptance` skill |

**层由检查认出来，不靠起名或记得。** 服务端一个测试文件的层由它经 import（只算取值的，不算 `import type`）一路碰得到什么算出来，一个函数（`testing/pyramid.ts`）说了算：在 `src/flows` 下的是流程；碰得到库、子进程或网络（`@electric-sql/pglite`、`@effect/sql-pglite`、`@effect/platform-node`、`node:child_process`、`node:net`、`node:http`、`node:https`）的是模块；碰不到的是规则。看的是一路传下去的依赖，所以经一个帮手间接搭了服务的也认得出。预算报告、金字塔小结和边界检查都用这一个函数。

**三条边界，不守就失败：**

1. 搭整座农场的流程帮手（`flows/farm.ts`）只在 `src/flows` 里用；每个模块的 `rules.ts` 和它的测试留在进程里，规则测试名副其实（测试）。
2. 页面测试只经 `fixtures`、`@playwright/test` 和 `@vibevalley/protocol` 进系统，不 import `apps/server` 或 `apps/web/src`（测试）。
3. 测试不靠时间等：写死时长的 `Effect.sleep`、`setTimeout` 等待由 lint 拦（`vibevalley/no-test-sleep`）；等后台的事用 `until`、`whenState`，有窗口的拨 `TestClock`，假端口要花时间就在 Clock 上花。

**形状看得见。** 每次 `vp test run` 结束打一张小表：每层几个文件、几个测试、一共花多久、几个超了预算的两倍；Playwright 也列超预算的。只提示，不让跑失败。

**往下压（写不成检查，只写成规矩）：** 一个行为在能看见它的最低一层测；模块测试主要在验证一个决定时，把决定抽成纯函数，模块测试只留一个接线；流程测试只写跨模块的用户故事。

步骤，每步一个 PR，前后的数字写在 PR 里：

1. `testing/pyramid.ts`（层的判定）和 `pyramid.test.ts`（边界 1）；`budgets.ts` 按层算预算，打小结；量规则层的耗时，定它的预算。
2. lint `vibevalley/no-test-sleep`，改掉现有的写死等待。
3. 页面：边界 2 的检查（`apps/web` 自己的测试），Playwright 的预算报告。
4. 沉淀：六层、每层的接缝、真和假、时间、预算写进 `foundation.md` 的测试一节，`AGENTS.md` 的测试规矩指向它，删掉本篇。

## Alternatives considered

- **按文件名声明层**（`*.rules.test.ts`）：要改二三十个文件名，名字和内容还会对不上；按依赖算，加一个 import 就换了层，小表里看得见。
- **模块测试只搭到自己那一层的农场**（`world` 按层裁剪）：上一轮量过，农场搭起来中位数 10 毫秒；越层由依赖判定和预算挡住就够。
- **覆盖率门槛**：数字说不出测在哪一层、花多少；形状和预算更说明问题。
- **超预算就失败**：机器快慢不同，CI 会时好时坏；超两倍列出来，交给评审和 `vv-simplify`。

## Acceptance criteria

- 每个服务端测试文件都有一层；`vp test run` 结束有金字塔小结和超预算的列表。
- 边界 1、2 是测试，边界 3 是 lint，现有代码都过。
- `foundation.md` 写着六层、每层的接缝、真和假、时间、预算；`AGENTS.md` 的测试规矩指向它；本篇删除。

## Risks

- 判定靠扫 import 语句，不走 TypeScript 的解析：写法特别的 import（拼出来的路径）认不出来。仓库里的 import 都是字面量路径，够用。
- 规则层的预算对一次跑几百条记录的黄金数据测试偏紧：它们照实列在超预算里，要快就把记录拆小或换便宜的断言。
