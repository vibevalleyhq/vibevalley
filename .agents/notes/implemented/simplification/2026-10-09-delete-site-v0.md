# Agent Note: 删掉工地版的代码，和别的停用代码

Status: implemented

## Problem

仓库里有几处不参与构建的代码，留着「只作参考」：

- `archive/site-v0/`：换成农场以前的界面（three.js 工地、机器人、zustand），留着是为了万一要回头（[farm-instead-of-construction-site](../feature/2026-10-09-farm-instead-of-construction-site.md)）。
- `go/`、`apps/console/`、`tests/replay/`、`docs/oar-go/`：从 oar 仓库迁来的 Go 版 oar v0、手动驱动它的桌面小窗（建在已经退役的 MyGo 上）、oar 的回放用例和这些代码的文档。帮工后来跑在 smith 上（`server/pkg/smith`），它有自己的一份回放用例。
- `research/mygo/`：MyGo 的调研报告，MyGo 已经退役（[一个服务端、一个客户端](2026-10-14-one-server-one-client.md)）。

它们会被搜到、被误读，注释和文档还指向已经不存在的东西；lint 和格式化的配置要专门绕开它们。

## Decision

全部删掉（2026-10-15），连同 `experiments/` 空目录、当时 `vite.config.ts` 里忽略它们的条目和文档里的链接。需要时从 git 历史里找。

## Alternatives considered

**一直留着。** 没有用处，只会误导；每次规整目录、写 lint 配置都要再解释一遍它们为什么在。

**挪进一个 `archive/` 统一放。** 没人构建、没人测的代码在哪都会悄悄坏掉，挪个地方不改变这一点；git 历史已经是存档。

## Consequences

仓库的一级目录只剩在用的（后来又收成 `server/` 和 `app/` 两块，见 [服务端和客户端两个目录](../architecture/2026-10-15-server-and-app.md)）。要看 oar 的 Go v0 或工地版，翻删之前的提交。
