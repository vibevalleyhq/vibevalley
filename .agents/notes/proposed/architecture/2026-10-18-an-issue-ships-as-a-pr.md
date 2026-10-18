# Agent Note: 一张工单一条分支、一个 worktree，收获就是提 PR

Status: proposed

## Problem

[先只用服务端和命令行](../process/2026-10-18-a-feature-through-server-and-cli.md)走通以后，还剩三处别扭：

- **worktree 和分支跟着帮工，不跟着工单。** 名字是 `<项目>.<帮工>-<时间>`、`vibevalley/<帮工>-<时间>`（`project.Workplace`）。同一个帮工接着干几轮没问题，但工单关了再挪回待办，农场派一个新帮工，从主分支另开一条分支：取消时留下的提交（`project.Release` 留着有提交的分支）没人接着做；取消时还有没提交的改动，旧 worktree 也留着，一张工单就有了两个 worktree。
- **合进的是农场那份克隆的 main。** 推到 origin、主人的检出拉下来，都得手动，农场的克隆和 origin 会分叉。
- **农场不知道本机的 GitHub 能不能用。** `gh` 装没装、登没登录、对这个仓库有没有写权限，现在没人查。

## Proposal

分三步，前一步是后一步的地基。

### 1. 工单拥有一条分支、一个 worktree

进展：第 1 步已实现，工单按号复用分支和 worktree，取消后接着已有提交做；项目检查在锁外运行，合并前核对分支提交并复查冲突。

- 派给工单的帮工，分支是 `vibevalley/issue-<工单号>`，worktree 是 `worktrees/<项目>.<工单号>`。不挂工单的（直接 `Send` 的）照旧按帮工起名。
- `project.Workplace` 按工单开：worktree 已经在，就用它；分支在、worktree 不在（取消时清掉了），就在这条分支上重新开 worktree，接着干；都没有，从基分支（主分支，或种植计划的分支）新开。结构上一张工单就只能有一个。
- 合进去以后分支照旧删掉，再重开从主分支开一条同名的；取消时有提交的分支照旧留着，重开的帮工接着在上面干，重开的工单（`reopenTask`）告诉它分支上已经有上次的提交。
- 顺手：`.vibevalley/check` 现在在项目锁里跑，跑的几分钟里同一个项目开不了新 worktree。挪到锁外跑，进锁合并前确认分支没变。

### 2. 检测 `gh` 和登录

- 照农机的检测（`runtime` 的 probe）：农场级查 `gh --version`、`gh auth status --hostname github.com`，结果进设置检查（`setting.check`），只说「装了、登录了、哪个账号」，不出现 token。用 `gh`，不用早就不维护的 `hub`。
- 项目级：`origin` 是不是 github.com，`gh repo view --json viewerPermission` 有没有写权限。`Project` 带一个字段：能不能提 PR，不能的话为什么（没装 gh、没登录、不是 GitHub、没有写权限）。

### 3. 收获就是提 PR

- 能提 PR 的项目，挪到 done 一律提 PR，不在本地合；不能的照旧本地合。一条路，主分支只在 GitHub 上动。
- 挪到 done：先跑 `.vibevalley/check`，过了农场推工单的分支（帮工照旧不 push），`gh pr create`：标题是工单标题，正文是工单号、帮工的结论和检查结果。已经有 PR 就只推，PR 跟着更新。
- 工单记 PR（链接、编号、状态）。PR 开着时工单是 in_review，帮工不走：按审查意见挪回待办再干一轮，交回来再挪到 done，就推一次更新 PR。
- 农场隔几分钟用 `gh pr view` 看开着的 PR：合了，工单关成 merged，worktree 清掉，帮工离开；被关掉，算取消。主人的检出从 origin 拉。

## Alternatives considered

**本地合和提 PR 都可选。** 灵活，但两条路各有一套状态和失败方式，主分支有时在本地动、有时在 GitHub 上动，农场的克隆和 origin 迟早分叉。

**用 `hub`。** 本机也装了，但它早就不维护，GitHub 官方的是 `gh`。

**帮工自己 push、自己开 PR。** 省掉农场一步，但帮工就要拿到推送的权限，和「帮工只在工作目录里干活」的边界冲突；推送和开 PR 留给农场，帮工照旧只提交。

**worktree 按帮工、重开时去找上一个帮工的分支。** 不改命名也能接着干，但「一张工单一个」要靠调用方记着找，不是结构上的保证。

## Acceptance criteria

- 第 1 步：`project` 的测试用真的 git 仓库：同一张工单第二次开拿到同一个 worktree；取消（分支有提交）再重开，新帮工在同一条分支上、看得到上次的提交；合进去以后再重开从主分支开。检查在锁外跑时，同一个项目能同时开别的工单的 worktree。
- 第 2 步：没装 gh、没登录、远端不是 GitHub、没有写权限，各自在设置检查和项目上说清原因；`verify-server` 上看到本机的结果。
- 第 3 步：用一个测试仓库真跑一次（不是 vibevalley 本身）：挪到 done 开出 PR，再干一轮更新 PR，在 GitHub 上合了以后工单自己关成 merged。

## Risks

- 第 3 步要真的推送、开 PR，是对外的动作；第一次真跑用一个测试仓库，vibevalley 本身等主人点头再开。
- 看 PR 状态要轮询 `gh`，频率太高会撞 GitHub 的限额；几分钟一次，只看开着的。
- 主人的检出和农场的克隆都从 origin 拉；在检出里直接提交到 main 的，会和 PR 合进来的冲突，要先推。
