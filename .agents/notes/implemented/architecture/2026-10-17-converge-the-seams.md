# Agent Note: 收敛接缝：投影一处、死代码进检查、协议瘦身、异步有规矩、客户端一个入口

Status: implemented

## Problem

第 7–11 轮的修补反复落在同几类地方（盘点见本次会话的回顾）：

1. **给人看的结论没有固定的家**。客户端一遍遍重写服务端的规则（`needOf`、`layersOf`、`whenText`、`quotaText`、`actionMeaning`……）；收回服务端时又放在了三处：`Reduce` 里（`phaseText`、`whenText`、`nextText`）、出帧时（`PlaybooksOf` 的 `layers` 等）、服务里（`playbook.Events` 的 `text`、`runtime` 的 `quota`）。`phaseText` 跟着帮工写进了 `state.json`，事实和画面混在一起。
2. **黄金数据成了代码存在的理由**。十几个 protocol 导出函数服务端从不调，只被黄金数据录着；移植时冻结的 JavaScript 语义（`Number()`、UTF-16 哈希）没人敢动。
3. **`protocol` 是杂物间**。形状、折法、游戏、计划、田头、文字、种子都在里面，只有一个包用的规则也放在这里。
4. **服务里的异步没有规矩**。缓存被晚到的旧读数覆盖（农机）、锁外读改写、后台 goroutine 没有完成信号，测试只能 `Sleep`。
5. **客户端到服务端没有一个入口**。`apiProvider` 和 `chatApiProvider` 是同一个 api；页面上千行，规则夹在页面里。

## Decision

分六个阶段做完，每个阶段结束时检查全过；下面是做了什么（勾着的是待办）。

### 阶段 1：投影只在一处

派生的、给人看的字段只在出帧那一步算：`protocol.FrameOf(state, effects) StateFrame` 是纯函数，`core.frame` 只调它。`Reduce` 只折事实和服务端规则要用的派生状态（工单的状态由服务读，留在 `Reduce`）。

- [x] `protocol.FrameOf`：在状态的副本上填帮工的 `phaseText`、定时的 `whenText`、`nextText`，再算 `Inbox`、`Plans`、`View`
- [x] `Reduce` 里删掉 `withPhaseWords` 和定时的两句话；`state.json` 不再存它们
- [x] `core.frame` 改调 `FrameOf`；黄金数据重录，diff 只少了这三个字段
- [x] `FrameOf` 的直接测试；`state-frame.sample.json` 由它写
- [x] 形状的注释写清这些字段「由 FrameOf 填，只在帧里有」；文档、Note 更新

### 阶段 2：死代码进检查

- [x] `scripts/` 加一个检查：`deadcode` 列出 `server/internal` 里从 `main` 走不到的函数，测试工具包（`testkit`、`golden`）除外，有就失败；接进 `AGENTS.md` 的命令
- [x] 清掉它现在报的（`base.ConfigAt` 挪成 `testkit/fixture` 的 `Config`；`gen.go` 的联合编解码是生成的，豁免）
- [x] 黄金数据的规矩写进 server README：它守折法和大量组合的规则，不是一段代码存在的理由

### 阶段 3：`protocol` 瘦身

- [x] 列出 protocol 每个导出函数的调用方（包）
- [x] 只有一个包调的，挪进那个包、不导出（计划的检查和排队给 `playbook`，账本的折法给 `game`……，先列再定）
- [x] 黄金数据的用例跟着挪（顺手把黄金输入里的旧形状——状态里的 `playbooks`、`playbook` 事实——一次转成现在的形状，删掉测试里现转的 `playState`、`playFact`）
- [x] 更新「规则跟着主人走」的 Note

### 阶段 4：服务里的异步有规矩

（阶段 3 顺带查出：照 JavaScript 算的数字在 arm64 上会被 Go 合成 FMA，`StreakMultiplier`、`num.Round`、定时的间隔、记性的打分都改成先舍入乘积；规矩在 server README「数字照 JavaScript 算」。）

- [x] 列出各服务里的缓存、后台 goroutine、锁外的读改写（大多是按顺序处理事件的循环，没问题；有问题的是农机信息、数提交、冲突复查）
- [x] 读改写统一成「开始时拿号，过期的丢掉」（农机），或一次一个（数提交加锁，冲突复查放回事件循环里做）
- [x] 后台的活给出完成信号（返回值、事件或 hub），测试改成等它，`Settle` 能删的删（等会发生的都改成 `Await`；剩下的 `Settle` 都是查「不该再来」的）
- [x] 规矩写进 server README（「后台的活不能乱序落地」）

### 阶段 5：客户端一个入口

- [x] `chatApiProvider` 并进 `apiProvider`，页面拿 api 只有一条路（`VoiceCall` 也只拿 api，不拿整个服务端）
- [x] 扫页面里的规则（不是排版、不是跟着时钟走的），能问服务端的改成字段，剩下的挪进 `rules/` 或 `shared/`（查出新增项目的检查是 Go 的抄本，改成 `POST /api/projects/check`；从 GitHub 地址猜项目名只是填表的方便，留在页面）
- [x] 测试替身只认 `test/support/server.dart`（看板测试也改用它；院门配对要连另一台农场的地址，自己建 api）

### 阶段 6：残留

- [x] 动物外形的 `castOf` 兜底原来也替旧档案（缺动物）补：改成服务端加载时按同一个挑法补一次、写回，存档案时也补（`agent/cast.go`），客户端的 `castOf` 只剩给不认识的档案挑；「不留兼容」改成「能在功能不变的前提下迁就迁一次」（[一份表结构](2026-10-16-one-schema-no-old-data.md)）
- [x] 代码里剩下的移植措辞和旧名字（调试台里还指着网页的 `sfx.ts`、`lastForemanSaid`、注释里的 crew 和 `crewNoRoom`）

### 不在这里做

- `shapes.go` 按概念拆成几个文件：要改生成器和大量文档里的路径，收益只是好找，等阶段 3 之后再看。
- 主键换 uuidv7：见 [改完旧名字](../../proposed/architecture/2026-10-16-finish-the-renames.md)。

## Alternatives considered

**派生字段继续放在 `Reduce` 里。** 好处是事件流的快照里也有。没选：快照只有调试台在看；放在 `Reduce` 里会进 `state.json`，每次折都要重算全部帮工的话，还让「事实」里混进画面。

**派生字段放在各服务里填。** 服务知道得最多（计划的标题、农机的花费）。没选：帧里的字段就该由出帧的那一步决定，服务各填各的就是现在的样子。服务自己的接口（农机信息、计划动态）仍由服务填，因为它们不走帧。

## Consequences

- 帧里给人看的字段都由 `FrameOf` 填，`Reduce` 和 `state.json` 里没有它们；事件流的快照里也没有（只有调试台看它）。
- `bun run go:deadcode` 守着 `server/internal`：只靠测试活着的函数会让它失败。
- protocol 里只被一个包调用的导出函数只剩写明理由的几个（见「规则跟着主人走」）。
- 后台读了再写回的活一次一个或拿号丢旧；测试里的 `Settle` 只剩查「不该再来」的。
- 照 JavaScript 算的数字在 arm64 上不再被合成 FMA：连胜倍率从 1.7 变回 1.7000000000000002，金币和 amd64、JavaScript 一致。
- 客户端只有 `apiProvider` 一条路拿 api；新增项目的检查问服务端。
- 旧档案缺的动物在服务端加载时补一次、写回；客户端的 `castOf` 只给不认识的档案挑。

## Verification

- `go vet ./... && go test ./...`、`bun run go:deadcode`、`bun run flutter:check`、`bun run docs:verify`。
- `server/internal/protocol`：`TestTheFrameSaysTheWordsOnACopy`；`server/internal/core`：`state.json` 里没有那几句话。
- 黄金数据每次重录都逐字段比过：阶段 1 只少了 `phaseText`、`whenText`、`nextText`；挪到各包的用例结果不变；FMA 只改了一个倍率。
- `pkg/x/num` 的 `TestRoundAProduct`、`game` 的 `TestStreakIsJavaScriptsNumber`：去掉修复就失败。
- `server/internal/runtime`：`TestASlowProbeDoesNotOverwriteANewerOne`；`server/internal/project`：`TestCheckSaysWhatCreateWouldRefuse`。
- `server/internal/agent`：`TestAProfileWithoutAnAnimalGetsTheOneItShowed`（和客户端 `desk_rules_test.dart` 的三个例子一样）、`TestOldProfilesAreFilledInOnceOnLoad`。
