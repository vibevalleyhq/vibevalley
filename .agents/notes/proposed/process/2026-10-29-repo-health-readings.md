# Agent Note: 给仓库做体检：按复杂度的三种症状读数，只有类型逃生口是棘轮

Status: proposed

## Problem

挡问题的手段（[四层](docs/subsystems/process.md)）都在「拦」：lint、测试、`docs:verify` 拦下写错的东西。拦不住的是慢慢变坏：一个文件越改越大、两个模块总是一起改、写下去的代码几天后又被改掉。这些在单个 PR 里都看不出来，人也没有精力每个 PR 细看。

2026-10-29 的两次审查都是凭印象挑的地方：上一轮拆了 `connector/connector.ts`（879 行），按「改动次数 × 行数」它不在前十；排第一的是 `channel/chat.ts`（30 天 34 次改动、1982 行），其后是 `issue/issue.ts`（42 次、1262 行）、`session/session.ts`（29 次、1312 行）。凭印象挑会挑错。

第 1 步上线的热点和逃生口只回答「哪里大、哪里常改」，不回答「为什么难改」。热点排第一的文件，可能是一个函数又长又常改，可能是它和别的模块总是一起改，也可能是接口太宽、用它的人都要懂它的内部；三种情况的改法不一样。

医生的做法可以借：几项生命体征天天量，和这个人自己的过去比，异常了再做专项检查；指标是筛查，不是诊断；报警太多就没人看。

## Proposal

一个包 `packages/health`（`@vibevalley/health`），三层：读 git 和源码（`collect.ts`）→ 纯函数算读数（`readings.ts`）→ 报告和棘轮（`report.ts`、`cli.ts`）。包不认识 VibeValley：算哪些文件、怎么分区（服务端照 `modules.ts`）、哪些文件本来就热、哪些地方本来就薄、棘轮放在哪，由仓库的配置给（`scripts/health.config.ts`）。纯函数不碰 git 和文件，以后能搬进 `apps/server/src/project`，给主人的项目做体检。

读数分两种：

- **报告**：只排出先看哪里，不拦合并。对象是一个文件、一个函数或一个区，和这个仓库自己的前一个窗口比。
- **棘轮**：只许减不许增，CI 查。只给数得清、意思明确、没有动机去刷的读数：类型逃生口。能写成 lint 的不进体检：import 环由 `import/no-cycle` 拦（ADP），服务端模块的方向由 `modules.test.ts` 拦。

### 报告的骨架：复杂度的三种症状

报告按 Ousterhout《软件设计的哲学》（*A Philosophy of Software Design*）的三种症状分节，每个读数归在一种症状下；Robert Martin 的依赖原则（SDP、CCP；ADP 已由 lint 拦）和 Clean Code 的函数级读数归到它们表现出来的症状里。每一节开头写一句它提示什么、看到以后先查什么。

| 症状 | 读数 | 原则 | 形式 | 2026-10-29 的数 |
|---|---|---|---|---|
| 改动放大：改一处要动很多地方 | 热点（第 1 步） | — | 报告 | `channel/chat.ts` 第一 |
| | 跨区一起改 | CCP、信息泄漏 | 报告 | 60 天里支持度 ≥ 4 的文件对 318 个，跨区的 244 个 |
| | 改动放大：动到一个区的提交平均动几个区 | Ousterhout | 报告 | 页面的 feature 中位数 8–14 个区 |
| | 依赖朝不稳定的方向 | SDP | 报告 | 未量 |
| 认知负担：改之前要先懂很多 | 模块的深度 | Ousterhout | 报告 | 服务端最浅 `core`（每个成员 13 行），最深 `tool`（477 行） |
| | 只转一手的函数 | Ousterhout | 报告 | 朴素匹配 137 处，多数是回调 |
| | 函数级热点：热文件里又复杂又常改的函数 | Clean Code | 报告 | 未量 |
| 未知的未知：不知道还得改哪里 | 隐性耦合：一起改，但没有 import 关系 | Ousterhout | 报告 | 6 对，多数经包的 `index` 转了一手 |
| 写下去又改掉 | 代码存活率 | 战术式编程 | 报告 | 未量 |
| 类型被手动关掉 | 类型逃生口（第 1 步） | — | **棘轮** | `scripts/health.ratchet.json` |

「2026-10-29 的数」由一次性的脚本量出（`collect.ts` 读 git 和源码，oxc 解析 import），只用来定阈值和看噪音，不是基线。

### 每个读数怎么算

都只看 `counted` 的文件；改动来自 `underTodaysNames`，超过 `mechanicalFiles` 的提交不算。`main` 只经 squash 合并，一个提交就是一个 PR。

- **import 图**：oxc 的 `module.staticImports` 和带来源的 `staticExports`；相对路径和 `@vibevalley/*` 都解析到文件，包名照它的 `package.json` 的 `exports`。`import type` 也算边：类型变了，用它的地方也要跟着改。这张图是隐性耦合和 SDP 共用的。
- **跨区一起改**：动过 40 个以下文件的提交里，两个文件一起出现的次数是支持度，除以两者中改得少的那个的次数是置信度。只报分属不同区的、支持度 ≥ 4、置信度 ≥ 60% 的。契约和用它的地方一起改是正常的，配置写 `coChangeByDesign`，和 `hotByDesign` 一样带理由。超过 40 个文件的提交不算：一个大功能 PR 让上百个文件两两成对，什么也说明不了。
- **隐性耦合**：跨区一起改的文件对里，import 图上两者之间没有路径的。路径要穿过只转一手的 `index`（只有 `export … from` 的文件），否则 `runtime/vibevalley.ts` 经 `@vibevalley/agent` 用到 `self.ts` 也会被报出来；今天报出的 6 对里有 4 对是这种。
- **改动放大**：每个区，动到它的提交平均还动了几个区，和全仓库的中位数、这个区自己的前一个窗口比。只看 40 个文件以下的提交。页面的 feature 是一个功能从 protocol 到服务端到页面竖着切下来的，数本来就高，所以只看变化，不看绝对值。
- **SDP**：区之间的 import 边。每个区的不稳定度 I = 扇出 ÷（扇入 + 扇出），报出从 I 小的区指向 I 大的区的边。服务端模块之间的方向 `modules.test.ts` 已经在拦，这里主要看 `packages/*` 和页面的 feature 之间。
- **模块的深度**：实现的行数 ÷ 接口的大小。接口由配置的 `interfaceOf` 给：服务端是模块当前服务接口的成员，页面的 feature 是 `index.ts` 的导出，包是 `exports` 指向的文件的导出。接口的大小 = 成员数 + 参数数。只出排序，浅的排前面；深度单独不分「深」和「大」（`tool` 4 个成员、1908 行），所以和热点一起看。
- **只转一手的函数**：导出的函数和服务的成员里，函数体只有一个调用、把自己的参数照原样原顺序传下去的。回调（`(x) => f(x)`）不算，朴素的匹配报出的 137 处多数是这种。网关（`handlers.ts`、`http/`）照规矩就该只转发，配置写 `thinByDesign`。
- **函数级热点**：热点前 10 的文件，用 HEAD 的 `git blame` 把每一行归到最后动它的提交，一个函数的改动数 = 它的行里落在窗口内的不同提交数；复杂度 = oxc 数出的分支数（`if`、`?:`、`&&`、`||`、`??`、`case`、`catch`、循环）和最深的嵌套。排序用改动数 × 分支数。
- **代码存活率**：一个 PR 新写的行，14 天后用 `git blame` 看还归在它名下的比例。agent 一次写对和写完反复修，测试都是绿的，这一项分得开。按 PR 算，报告列最低的几个和按区的中位数。函数级热点和它共用 blame 的读取。

### 配置加的几项

```ts
interface Health {
  // …第 1 步的几项
  /** The files that make up an area's interface: its exported shapes, its index. */
  readonly interfaceOf: (area: string, sources: readonly Source[]) => readonly Source[];
  /** File pairs that change together by design (a contract and its users), each with the reason. */
  readonly coChangeByDesign: Readonly<Record<string, string>>;
  /** Files whose functions only forward by design (the gateway's handlers), each with the reason. */
  readonly thinByDesign: Readonly<Record<string, string>>;
}
```

`*ByDesign` 里的文件不在了，理由就过期，报告列出来。

### 本轮范围

先实现第 2 步的 import 图、跨区一起改与隐性耦合，人工核对报告前列是否指向真实的重复知识。深度、SDP、blame 和存活率保留为后续候选，不与这一阶段绑定验收；不能证明有用的读数撤掉。接口识别按当前服务声明和导出关系配置，不继续依赖已经改名的 `*Shape` 后缀。

### 步骤

1. **热点和逃生口的棘轮**（做完了）。
2. **import 图和一起改**：跨区一起改、隐性耦合、改动放大，三节共用一张一起改的表，隐性耦合再减去 import 图。
3. **深度、只转一手、SDP**：都只读 import 图和源码。
4. **blame 的读数**：函数级热点和代码存活率。
5. **回测和取舍**：第 t 周的各项读数能不能预测第 t+1 周的低存活率和热点；预测不了的删掉。之后再考虑变异测试，只对 `rules` 里的纯函数。

报告同时出 JSON（`--json`），每项带症状和它指向的文件，让管家拿排第一的一项开一张工单，接上[用 VibeValley 开发 VibeValley](.agents/notes/proposed/process/2026-10-18-build-vibevalley-with-vibevalley.md)。

## Alternatives considered

- **设门槛**（文件不超过 N 行、函数不超过 M 行、参数不超过 K 个）：agent 会照数字机械地切文件，读数好了，代码没变好。Clean Code 的函数读数只和热点合起来排先看哪里。
- **Martin 的抽象度 A 和到主序列的距离 D**：A 是包里抽象类和接口的比例，给 Java 的包设计。这里的「抽象」是 `Context.Service` 的 tag 和 `packages/protocol` 的形状，数不准，D 是噪音。只留不稳定度 I，用来查 SDP。
- **深度、改动放大做成棘轮**：接口缩一缩，深度就「变好」；一个功能 PR 竖着切，改动放大就高。都有动机去刷，或者意思不明确。
- **把错误定义得不存在**（数一个服务的错误通道里有几种错误）：要类型信息；仓库用的 TypeScript 7 没有 JS 接口，oxc 只有语法。等有了类型的读法再加。
- **注释的覆盖率**：和「注释只写不显然的」（[代码风格](docs/style/code.md)）冲突，注释由 `vv-comments` 管。
- **import 环做成棘轮**：lint 的 `import/no-cycle` 已经拦值的环，今天是 0 个；只靠 `import type` 闭合的环有 3 个（`session/execution.ts`、`host.ts`、`session.ts`；`engine/src/pixi/light.ts`、`critters.ts`、`index.ts`；`web/features/issue/state.ts`、`cards.ts`），类型的环不影响加载顺序，不拦。
- **用 dependency-cruiser 或 madge 建 import 图**：多一个依赖，还要另配 `@vibevalley/*` 的解析；oxc 已经在包里，解析 `exports` 二十行。
- **和行业的数比**：仓库的大小、阶段、写代码的方式（agent 写、PR 很大）都不一样，别处的阈值没有意义；和自己的前一个窗口比。
- **放在 `scripts/`**：`scripts/` 里是拦问题的检查；体检要自己的测试、依赖（oxc 的解析）和以后给主人的项目用，所以是一个包，仓库只留配置。
- **用 TypeScript 编译器数逃生口**：TypeScript 7 是原生实现，没有 `createSourceFile` 这类 JS 接口；Vite+ 带的 oxc（`vite` 的 `parseSync`）解析出带 TS 节点的 AST，不另加依赖。
- **把历史读数存起来画趋势**：要另维护一份数据；读数都从 git 历史和 HEAD 算，过去某个窗口的数随时能重算。

## Acceptance criteria

- `vp run health` 出报告，按三种症状分节，每节开头一句它提示什么；`vp run health:verify` 跑包的测试再对棘轮，在 CI 的 check 里。
- 在一个算进去的文件里加一个 `x!`，`--check` 报出那一区，退出 1；删掉一个，也退出 1，要求 `vp run health:write`。
- 隐性耦合不报经只转一手的 `index` 连着的文件对。
- 第 2–4 步每个读数有测试（手搭的 git 仓库或手写的源码），报告里有对应的一节。
- 第 5 步的回测结果写进本 Note，留下的读数写进 [工程流程](docs/subsystems/process.md)，删掉的写明为什么。

## Risks

- **历史太短**：仓库从 2026-10-16 开始，到 2026-10-29 是 403 个提交；前一个 30 天的窗口是空的，报告注明「历史不够，不比」。存活率要 14 天以上的 PR，回测要等两三个月的历史。
- **大 PR 让读数失真**：squash 以后一个 PR 是一个提交，功能 PR 常常动一两百个文件。热点里每个文件都记一次改动；一起改和改动放大排掉了 40 个文件以上的提交（今天 18 个），等于不看最大的那批功能。
- **一起改的阈值是看今天的数定的**：支持度 ≥ 4、置信度 ≥ 60% 在 60 天里出 6 对隐性耦合，历史长了要重定。
- **深度的接口要配置给**：服务端靠当前服务声明与导出关系，页面靠 `index.ts`；没照这个写的模块读不出接口，报告列为「没有接口」，不算深。
- **棘轮让小改动变红**：删掉一个 `!` 也要跑 `vp run health:write`。这是有意的，失败信息里写了要做什么。
- **读数被当成考核**：报告每一节写明它提示什么；不把热点、深度当成 PR 的门槛。
