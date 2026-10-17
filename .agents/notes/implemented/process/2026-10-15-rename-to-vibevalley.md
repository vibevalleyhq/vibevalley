# Agent Note: 改名 VibeValley（码农场物语）

Status: implemented

## Problem

项目要开源，原来的名字 heybro 不利于被找到：GitHub 上已经有一个同样做 AI agent 的 HeyBro，搜这个名字先看到别人；名字本身也说不出它是什么。开源以前、还没有外部用户的时候改名最便宜。

## Decision

英文名 **VibeValley**（代码、命令、目录里写 `vibevalley`），中文名 **码农场物语**。

- **为什么是这两个**：VibeValley 一个词连着三样东西：vibe coding（让 AI 写代码），《星露谷物语》（Stardew Valley）那种种地、田园牧歌的感觉，和硅谷。两个 V 开头，好念好记。码农场物语是「码农」「农场」的双关，「物语」呼应《牧场物语》。给人看的地方用这两个名字（窗口、首页、通知、Dock 里写码农场物语，文档正文写 VibeValley），代码、命令、目录用小写的 `vibevalley`。
- **改了的**：Go 模块 `vibevalley`，命令 `cmd/server`、`cmd/vibevalley`，打进应用的 `vibevalley-server`；Dart 包 `vibevalley`，生成的 `lib/gen/vibevalley.dart` 和 `VibeValleyApi`；环境变量 `VIBEVALLEY_*`；目录 `~/.vibevalley`、`~/vibevalley-work`、`~/Library/Application Support/vibevalley`；bundle id `dev.vibevalley.app`（iOS、Android 同样）；新开的分支 `vibevalley/…`；院门配对链接 `vibevalley://pair`；shapegen 的指令 `//vibevalley:` 和标签 `vibevalley:"null"`；管家和语音管家的人设、自带农机的显示名、日志前缀、文档、Note。
- **数据里的标识也改**：自带农机的 id、语音线路「想」用农场管家时的 vendor 从 `heybro` 改成 `vibevalley`（后来改叫 `manager`，[通话、听写和管家的 OpenAI 协议](../../proposed/architecture/2026-10-18-calls-dictation-and-the-agent.md)），oar 事件名从 `heybro/…` 改成 `vibevalley/…`，smith 里给它分类工具的表跟着改。
- **迁移，不兼容**：代码里不再认旧名字，服务端和应用只找 `vibevalley` 的变量和目录。旧名字下的农场用 `vibevalley migrate`（`internal/migrate/oldnames.go`）迁移一次：搬走旧的家、日志和工作目录，改写农场的 JSON、`.env` 和 `vibevalley.db` 里的旧路径和旧标识，用 `git worktree repair` 重新连上帮工的 worktree，把 `heybro/…`、`vibefarm/…` 分支改名 `vibevalley/…`，复制应用的偏好；动手前全部备份一份，服务端开着时不做。项目先叫 heybro，又短暂地叫过 vibefarm，两代都迁，新的优先。从旧 TypeScript 服务端导入（`vibevalley import`）时，它的 `heybro` 农机 id 也改成 `vibevalley`。两个命令迁完以后都删了（[只有一份表结构，不认旧数据](../architecture/2026-10-16-one-schema-no-old-data.md)）：现在没迁的旧农场搬不过来。
- **黄金数据**：用例输入里的农机 id 同样迁移成 `vibevalley`；当时用 `go test ./internal/protocol -update`（现在是 `VIBEVALLEY_GOLDEN=update go test ./internal/...`）重写以后，和改名前比，只有 id 和显示名不同。
- **删掉的东西用它当时的名字**：改名以前就删掉了的 TypeScript 包、Electron 应用和它们的目录、环境变量、bundle id，从来没叫过 vibevalley；文档和 Note 讲到它们时照旧写当时的名字（`@heybro/core`、`~/.heybro`、`HEYBRO_HOME`、`dev.heybro.farm.alpha`），只有还在的东西用新名字。

## Alternatives considered

**vibefarm。** 先定了它，改完以后查占用才发现撞得厉害：vibefarm.dev 是一个同名、同样像素农场画风的游戏，vibefarm.ai 是一个在卖终身会员的 AI 提示词工具（Chrome 扩展只有十个用户，但它的付费推广稿占满了搜索结果），Steam 上还有一个快上线的 Vibe Farmer；GitHub 的 `vibefarm`、`vibe-farm` 也被人占了。仓库还没公开，于是再改一次。

**viberfarm。** 域名和 GitHub 都空着，但 VIBER 是乐天旗下即时通讯软件的注册商标，正好覆盖软件类；读出来也和 vibefarm 一个音，躲不开撞名。

**只改仓库名，产品照旧叫 heybro。** 改起来最快，但用户在 GitHub 上看到一个名字、打开应用是另一个，名字传不起来。

**别的候选。** lgtmfarm、10xfarm、yolofarm 这些开发者梗传播性强，但没有种地、田园的感觉；vibevale 的 vale 是书面语，很多人不认得；agentville、vibeyard 已经有同领域的项目；意耕信达雅，但听了写不出、要解释。

**兼容旧名字。** 服务端和应用一直认旧的环境变量、找旧的目录，旧的标识留在数据里。用户什么都不用做，但旧名字永远留在代码里，每加一个读环境变量或目录的地方都要记得它们；这个项目还没有外部用户，迁移一次的代价最小。

**只改名字，数据里的 id 不动。** 改动小，但界面看不到的地方永远叫 heybro，新写的代码要记住这个例外。

**旧的工作目录留在原地。** 不用碰主人的项目，但工作目录就得一直叫旧名字（或者在 `.env` 里写死）。搬过去以后 worktree 的绝对路径会断，由 `git worktree repair` 接上。

## Consequences

- 没迁移的旧农场不会被找到：应用像第一次打开一样从空的农场开始；`vibevalley migrate` 删了以后，也不再能迁。
- bundle id 换了：macOS 把它当成一个新应用，偏好由迁移复制过去，通知权限要重新给一次。
- 迁移和导入删了以后，代码里不再有 heybro、vibefarm；文档和 Note 里只在讲旧 TypeScript 服务端的地方。
- VibeValley 的 `.com` 在别人手里挂牌出售，`.dev`、`.sh`、`.cn` 可以注册；GitHub 的 `VibeValley` 用户名是别人的，组织用 `vibevalleyhq`。

## Verification

- 迁移在的时候，`internal/migrate/oldnames_test.go` 照 heybro 应用留下的样子摆一个农场，迁移以后文件夹、JSON、`.env`、数据库里的路径和 id、worktree、分支、偏好都换到了新名字，再跑一次什么都不做；它随迁移一起删了。
- `go vet ./... && go test ./...`、`bun run flutter:check`、`bun run docs:verify`，`bun run package:mac` 打出 `vibevalley.app`。
