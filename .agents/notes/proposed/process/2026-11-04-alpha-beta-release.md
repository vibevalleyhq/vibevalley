# Agent Note: alpha、beta 和正式版

Status: proposed

## Problem

桌面版只有一种版本：打 `vX.Y.Z` 的 tag，CI 出一份草稿 Release，主人看过发出去，所有装了的人在 4 小时内更新到它。没有给愿意先试的人的版本，也没有「这一批功能冻住、只修错」的阶段。现有的代码也接不住预发布的版本：

- `apps/desktop/scripts/package.ts` 只认 `X.Y.Z`，`v0.4.0-beta.1` 打出来的包版本是 `0.0.0`，永远不会更新。
- `apps/desktop/src/releases.ts` 的 `newer` 只比三个数，分不出 `0.4.0-beta.1` 和 `0.4.0`。
- 更新只读 `releases/latest/download/release.json`，GitHub 的 latest 不含预发布：试新版的人收不到。
- 版本号、该不该打、表结构变没变，都靠人记；表结构一变农场就从头来（[不留兼容](docs/subsystems/foundation.md)），beta 上不该发生。

## Proposal

**三个阶段，semver 的预发布号；版本号和检查由一条命令算，构建和发布仍是现有的 `release.yml`，这次不改 CI。**

### 阶段

```
v0.4.0-alpha.1 → alpha.N → v0.4.0-beta.1 → beta.N → v0.4.0 → v0.4.1
```

- **alpha**：主人和自用。功能随时变，农场可能从头来。从 `main` 打。
- **beta**：给愿意先试的人。这一版的功能冻住，只修错；**同一条 beta 线里表结构不变**，农场不会从头来。第一次 beta 从 `main` 切出 `release/0.4`，之后都在它上面打；修错先进 `main`，再挑到 `release/0.4`。
- **正式版**：和最后一个 beta 同一份代码，从 `release/0.4` 打。之后的 `0.4.1` 也在这条线上。

### 命令

- `vp run release <alpha|beta|final>`（`scripts/release.ts`，会打 tag、推送，所以在 `package.json`，不缓存）：
  1. 工作区干净、在这一阶段该在的分支上、和远端一致。
  2. 从已有的 tag 算出下一个版本号，不手写。
  3. beta 和正式版：先跑 `vp run release:verify`；表结构（`apps/server/db/migrations/0001_schema.up.sql`）和这条线上一个 beta 比，变了就拒绝，说怎么办。
  4. 说清楚要打什么、从哪个提交、这一版包含哪些提交、会不会让农场从头来，主人说是了才打 tag、推送。推送以后现有的 `release.yml` 出草稿；预发布的那份主人发的时候勾上 pre-release。
- `vp run release:verify`（`vite.config.ts` 的任务，带缓存）：beta 和正式版要过的检查：`server:check`、`web:check`、`docs:verify`、`desktop:test`。

### 应用里

- `package.ts` 收 `X.Y.Z` 和 `X.Y.Z-alpha.N`、`X.Y.Z-beta.N`。
- `newer` 照 semver 排：`0.4.0-alpha.2 < 0.4.0-beta.1 < 0.4.0`。
- 应用更新到哪个阶段由它是哪个渠道定：一个渠道一个应用、一个农场，见[桌面版的渠道和命令行](.agents/notes/proposed/feature/2026-11-04-desktop-channels-and-cli.md)。正式版照旧读 `latest`；beta 和 alpha 读 GitHub 的 Release 列表（不含草稿），挑同一阶段里最新的一个，再读它的 `release.json`。

## Alternatives considered

- **Makefile**：本仓库的任务一律 `vp run`（缓存、`dependsOn`），再加一个跑任务的东西就有了两条路，绕开缓存的那条会被走。
- **每个通道一份清单（`beta.json`）放在固定的地方**：不受 GitHub 接口的次数限制，但要 CI 在发布时写它；这次不改 CI。未登录的接口一小时 60 次，应用 4 小时问一次，够用；以后改 CI 时可以换过去，应用只换读清单的那一处。
- **beta 直接在 `main` 上打、不切分支**：冻住功能就得停下 `main`，帮工合 PR 很快，停不住。

## Acceptance criteria

- `v0.4.0-beta.1` 的 tag 打出来的包版本是 `0.4.0-beta.1`，`newer` 的测试覆盖预发布的顺序。
- `vp run release alpha` 在 `main` 上算出下一个 alpha、列出要打的东西、问过才推；工作区不干净、分支不对、表结构在 beta 线上变了时拒绝，并说怎么改。
- beta 渠道的应用在只有预发布时更新到它，正式版的不会。
- 改完的文档：[应用](docs/subsystems/app.md) 的自己更新一段、[开发](docs/development.md) 的发版。

## Risks

- GitHub 未登录接口的次数限制：同一个出口 IP 后面装了很多份时可能被限，限了就这一次查不到，下一次再查。
- 发预发布时忘了勾 pre-release，它会成为 latest，正式版通道的人也会收到。以后改 CI 时按 tag 自动标上。
- 表结构的比较只看基线文件有没有变；只改了注释也算变，宁可多拒一次。
