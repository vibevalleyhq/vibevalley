# Agent Note: 迁移是一次性的，启动只认今天的名字

Status: implemented

## Problem

为了让旧的家还能打开，服务端在启动时带着几段搬家代码：`base.MoveSessionFiles` 把 `workers.json` 改成 `sessions.json` 并改 `state.json` 的键，`session.moveActivities` 把 `activities/` 改成 `events/`、拆开带结果的工具调用，`session.moveHeads` 把 `*.head.json` 搬进 `session` 表；`agent/cast.go` 在加载时给缺动物和衣服的档案补齐。数据库也有五个改名迁移，`0001` 之后叠着 `0002`–`0005` 的表名和列名。它们都是为了旧农场留在每次启动的路上。

而真实的家只有一份，还是 TypeScript 时代的：`~/Library/Application Support/vibevalley` 里是 `farm.db`、`farm.json`、`crew.json`、`steps/`、`foreman/`，没有一份当前格式的 `vibevalley.db`。Go 时代的旧家一个都不存在，那些启动搬家器从来没有被触发过。

## Decision

- **旧农场用一次性的导入搬，不在启动时搬**：`server/tool/import-ts` 读 TypeScript 的 `farm.db` 和 `steps/`，写今天的 `vibevalley.db` 和 `events/<会话>.json`：发言人、对话、消息、工单、Session、Run、账本、记性、院门、连接器按今天的名字和值写入，旧事件转成今天的 `SessionEvent`。旧文件不删，由主人移进 `retired-ts-<日期>/`。跑完以后导入器从树里删掉，只在 git 历史里。
- **启动搬家器删掉**：`base.MoveSessionFiles`、`session.moveActivities`、`session.splitAllResults`、`session.moveHeads` 和它们的测试、调用一起删。`agent/cast.go` 只在保存档案时补默认长相，加载时不再补。
- **表结构从一份基线开始**：`server/migrations/0001_schema.sql` 是今天的整份表结构（五次改名折进去），`0002`–`0005` 删掉。以后的改动仍然是在它后面加文件、跑一次。
- **启动只读今天的名字**：旧文件不读、不改写、不删；`state.json`、`sessions.json`、`events/`、`vibevalley.db` 是全部的家。

## Alternatives considered

**留着启动搬家器。** 新装的农场永远用不到，它们只在第一次开机时对一个旧家有用；留着就要一直维护它们的测试，而且每次加载都要问一遍「这文件是不是旧格式」。

**留着 `0002`–`0005` 的改名迁移。** 它们是表结构的历史；可没有一份旧 Go 库要看这段历史，新库每次开机按顺序跑四步改名，读表结构还要在脑子里叠五层。

**不管旧 TypeScript 农场，从空开始。** 那样 `clock-in` 那张工单、7 条消息、账本里的 135 金币和三条记性就只剩 `farm.db` 里的字节；这份农场是主人真实用过的，值得搬。

**看到旧文件时在启动里顺手导入。** 启动会变成一次不可中断的大迁移，出错时农场开不了门，也没法先看一眼导入的结果。

## Consequences

- 2026-10-17 之前的家要先导入才能继续用；导入器只在 git 历史里，旧文件归档在 `retired-ts-<日期>/`，备份在仓库外。
- 表结构只剩一份，读它不用再叠改动；旧 Go 库（如果以后从别处翻出来）不再能升，`0001` 是现在的形状。
- 档案少了动物或衣服时，客户端照 `castOf` 挑一个显示；服务端只在保存时把它写进去。
- 导入后的数据：1 张工单（`clock-in`，`number` 1，已合入）、7 条消息（每个对话里从 1 数）、15 条账本（135 金币、6 个成就）、3 条记性、1 个 Session（新的 uuid）和它的 10 条事件、1 次 run。

## Verification

- 真的家目录：先备份成 `~/vibevalley-home-2026-10-17.tar.gz`；uuidv7 的形状定下来后再次备份成 `~/vibevalley-home-2026-10-17-uuid.tar.gz`，用导入器把 TypeScript 农场重导进新库，起服务端后 `GET /api/v1/state` 里是 `number` 1 的工单、田头的 7 条消息、`progress.coins` 135；`session events <uuid>` 打出 10 条事件，`issue runs <uuid>` 打出 1 次 run。
- 干净的家：从 `0001_schema.sql` 建出的表和索引，和改动前 `0001`–`0005` 跑完的一样（21 张表）。
- `go vet ./... && go test ./...`、`go run ./tool/shapegen -check`、`bun run flutter:check`、`bun run docs:verify`。
