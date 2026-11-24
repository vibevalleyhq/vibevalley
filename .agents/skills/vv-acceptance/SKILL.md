---
name: vv-acceptance
description: 改完 VibeValley 的代码之后，在真的程序上验收、拿到证据再汇报：起一个和用户的数据隔开的 Rust 服务端，用 Rust 命令行看接口和 /api/v1/slice/{name}（crates/server、crates/core、crates/cli、crates/protocol）、用脚本驱动原生应用并截图（apps/mac、assets）、验媒体任务（crates/server/src/content/media）。用在：用户说「验证一下」「验收」「跑起来看看」「截个图」；改了接口、服务、表结构、开机流程、页面、像素场景之后，说「做完了」之前，即使用户没开口；写 PR 的 Checks 要附证据时。只改了纯函数、测试已经覆盖的，或只改了注释和文档，跑测试就够。
---

# 验收

测试和检查之后的那一段：程序真的起来、接口真的返回、应用真的画出来。测试用假的帮工、假的模型，证明不了这些；用户看的是证据，不是「测试过了」这句话。

每一块的做法在 `references/` 下的一份分册里：先照下表找到要读的那份，只读用得上的，验一个接口不用带上截图和真实厂商的步骤。下面的「准备」「步骤」「证据」「出错时」「收拾」是各块共同的部分，分册里写它自己多出来的。

## 什么时候用

| 改了什么 | 读哪份 | 证明什么 |
|---|---|---|
| `crates/server`、`crates/core`、`crates/server/src/transport/http`、`crates/cli`、`crates/protocol` 的接口或形状；开机的流程 | [server.md](.agents/skills/vv-acceptance/references/server.md) | 隔开的服务端起得来，接口和 `/api/v1/slice/{name}`（5 域切片与 `farm`）里有这次的改动；工单能派、交回、完成 |
| `apps/mac/ui`、`apps/mac/src`、`assets` 的画面、组件、像素场景、贴图 | [app.md](.agents/skills/vv-acceptance/references/app.md) | 隔开的原生应用起得来，页面和像素场景画出来是对的（截图） |
| `media`、生图协议、结果下载、助手媒体工具 | [media.md](.agents/skills/vv-acceptance/references/media.md) | 隔离程序的生成、落盘、发布与 Artifact 引用真的接通；费用和未知结果边界不变 |

一次改动碰了几块，就读几份。服务端和媒体在同一个沙箱子命令里一起做（造数据、调接口）；应用自己带着服务端，照它的分册另起。

不用它：只改了纯函数、单元测试已经覆盖的；只改了注释和文档。

**连网、花钱的（真模型、真实厂商）跑之前先问用户。** 没问、没钥匙时只做离线的部分，汇报里写明在线的那半没跑。没有用真模型重放助手的评测：改了助手的提示（`crates/core/src/prompts.rs`）或工具说明（`assets/tools/`）只能跑 `cargo test -p vibevalley-server --test orchestrator`，汇报里写明没用真模型验。默认不派真的帮工（要本机登录的农机或钥匙）；用户明确授权验证真实帮工 CLI 时，按服务端分册的「真实帮工的 CLI 与连接观测」执行。普通派活使用沙箱的 `--scripted-helper`（[server.md](.agents/skills/vv-acceptance/references/server.md)）。

## 准备

1. 先跑和改动有关的最窄的检查：服务端、命令行和 `apps/mac/src` 跑 `cargo xtask check`，`apps/mac/ui` 跑 `vp run mac:check`。
2. `cargo build -p vibevalley-server -p vibevalley-cli`：沙箱用构建好的二进制，不替你构建。
3. 照分册的「准备」做它要的事（构建、钥匙）。

## 步骤

1. 照上表选出分册，读它。
2. 服务端和媒体用同一个沙箱，在仓库根目录跑（应用照[它的分册](.agents/skills/vv-acceptance/references/app.md)起）：

   ```bash
   vpx scripts/release/verify-server.ts [--scripted-helper] -- <这一轮的子命令>
   ```

   它起 `${CARGO_TARGET_DIR:-target}/debug/vibevalley-server`（`VIBEVALLEY_SERVER_BIN` 可指定别的），临时的家目录和工作目录、回环地址的空闲端口，环境里去掉一切钥匙，不碰 `~/.vibevalley`，也不占用户的 8787。子命令拿到 `VIBEVALLEY_SERVER`（服务端的地址）和 `VIBEVALLEY_VERIFY_CLI`（连着它的 Rust 命令行 `vibevalley`，`--help` 列出全部命令）。每次调用是一个新农场，要的数据在同一个子命令里造。

3. 照分册的「步骤」写子命令、跑。
4. 读脚本打印的证据目录：`command.stdout.log`、`command.stderr.log`、`server.stdout.log`、`server.stderr.log`，核对结果。只有启动成功的 `health.json` 不能证明改动生效。

## 证据

说「验收过了」时，附上：

- 执行的命令和打印的证据目录；`result.json` 的 `code` 是 0、`stopped` 是 true。
- 分册「证据」一节要的东西：接口的 JSON、截图。
- 日志里的错误和对它们的结论。

## 出错时

- **服务端起不来或健康检查超时**：看 `server.stdout.log`、`server.stderr.log`（二进制不在、表结构对不上、端口）。脚本已经停掉它起的进程。
- **子命令失败**：看 `command.stderr.log` 和 `command.stdout.log`；脚本不会把非零退出码改成成功。
- **清理失败**：看 `result.json` 的 `cleanupErrors`；`stopped` 为 false 时临时目录会留着，不要当成已收拾。
- **接口或形状对不上**：跑 `cargo xtask protocol`、`cargo xtask check` 和 `vp run mac:check`；确认二进制是改完以后构建的。
- 各块自己的失败在分册的「出错时」。

## 收拾

沙箱脚本自己停掉服务端、删掉临时的 `home`、`work`，证据日志留在打印的临时目录，交付后可删。截图不进 git。
