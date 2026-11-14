<h1 align="center">VibeValley · 码农场物语</h1>

> Direct a team of coding agents by voice or chat, on your own machine. Linear for agents, drawn as a pixel farm.

**VibeValley**（码农场物语）让一个人用一句话指挥一队编码 agent：你对**助手**说要做什么，它拆成工单、挑帮工、派出去、把结果告诉你；**帮工**是你机器上真实的编码 agent（pi、Claude Code、Codex……），在你的项目里开分支、改代码、跑测试、提交；你看过改动，才合进主分支。它是跑在本机的 AI 版 Linear，外面画成一座像素农场：庄稼跟着真实的进度长（[概念](docs/concepts.md)）。

![农场：田地、助手和右下角的田头](docs/images/farm.png)

## 为什么用它

- **说一句话，派出一队人。** 你只和助手说话。它把一句话拆成工单，按档案挑帮工、开分支，派出去；帮工确认、提问、汇报都在同一个群聊（田头）里，每件活一个串，你随时插话。
- **用的是你本机真的编码 agent。** pi、Claude Code、Codex 等由 [oar](https://github.com/botiverse/oar) 统一驱动，用你已经登录好的账号；没有也行，自带一个只要 DeepSeek 钥匙的农机。
- **同时干好几件，互不踩脚。** 最多 6 个帮工同时干活（每个仓库默认 3 个），各在自己工单的 worktree 和分支上；派不出去的排队，空出来自动接上。
- **合不合由你说了算。** 做完的活先给你看提交、diff 和会不会冲突，你说「完成」才合进主分支；冲突了让它自己解决。长任务拆成有先后的子工单，修 bug 先写一个**会失败的验收测试**，后面的子工单改不了它，最后一步要让它通过。
- **服务端停了也不丢活。** 助手和自带的农机每一轮、每个工具调用先落盘再显示。助手答到一半服务端停了，重启后接着答完；进程崩在半路时，帮工也从断点接着做，这一轮只记一次。
- **一眼看清谁在干什么。** 工作台照 Linear：看板、工单详情、每一步的轨迹（收到的话、每条命令和输出），哪一步不对就在那一步写评论。农场把同样的状态画出来：每个仓库是一座岛，在做的工单是一块地，读代码发芽、改文件长叶、做完结出麦子。
- **窗口里和终端里都能派活。** macOS 应用之外，命令行 `vibevalley` 一条命令一个操作，对着同一个服务端。
- **少操心。** 「每天九点跑一遍测试」这样的定时任务；不调模型的巡查，提醒没人回的提问、没动静的帮工、做完没收的活；每个农机的额度和每日预算，用完了就不再派。
- **全在你的机器上。** 服务端只听 `127.0.0.1`，数据在你的家目录（`~/.vibevalley`）；帮工的记性、档案、笔记和 Artifact 都在本机。

> [!WARNING]
> 帮工**没有权限确认、不开沙箱**，能在这台机器上执行任意命令。服务端只监听 `127.0.0.1`，不要把它暴露到网络上。只把你愿意交给编码 agent 的项目放进工作目录。

![地图：每个项目一座岛，地是在做的工单和空位](docs/images/map.png)

## 它是怎么工作的

```mermaid
flowchart LR
  you([你]) -- 打字 --> app[工作台和农场<br/>原生 macOS 应用]
  app -- 命令 --> server
  server -- 折好的核心状态 --> app
  subgraph server[Rust 服务端，在应用的进程里]
    manager[助手<br/>自研 agent]
    chat[田头和工单<br/>SQLite]
    site[核心状态<br/>只由事实改变]
    sessions[帮工<br/>oar]
  end
  manager --> sessions
  sessions -- 会话事件 --> site
  sessions --> rt[本机的农机<br/>Claude Code · Codex · ACP …]
  rt --> repo[(你的项目<br/>项目目录或工单的 worktree)]
```

- **一个服务端进程**（`crates/vibevalley-server`，Rust）：助手、帮工、田头、工单和交付、Artifact 和笔记、媒体都在里面；数据在家目录的 SQLite 和文件里。它跑在应用的进程里，也能单独跑。
- **核心状态只有一份**：农场上的一切是一个值，只因「事实」而变（雇了一个帮工、开始一轮、跑了一条命令……）。服务端用纯函数把事实折进状态，页面只读折好的结果。
- **客户端**：原生应用 `apps/mac`：GPUI 的窗口，工作台是 nsh 跑的 TSX 页面，像素农场由 Rust 画；命令行 `vibevalley` 经本机的 HTTP 调同一个服务端。只支持 macOS（[计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)）。
- **契约只写一次**：接口和形状按概念写在 `crates/vibevalley-protocol`，页面用的 TS 类型由它生成，服务端、页面和命令行用同一份。

更多见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

> [!NOTE]
> 还在快速迭代：概念、接口和存盘格式都会变，升级后旧数据可能作废重建。升级前先备份 `~/.vibevalley`。遇到问题欢迎提 issue。

### 需要

- macOS（Apple 芯片）。
- 至少一个装好并登录的编码 agent：[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://github.com/openai/codex) 或一个 ACP 农机。VibeValley 也自带一个农机，只要 DeepSeek 的钥匙。
- 一把 [DeepSeek](https://platform.deepseek.com/) 的 API 钥匙，助手要用。
- 构建要 Rust（照 `rust-toolchain.toml`）、Zig 和 [Vite+](https://viteplus.dev)（`vp`）：它照 `.node-version` 装 Node 24，带着 pnpm。

### 从源码跑

```bash
git clone https://github.com/vibevalleyhq/vibevalley.git && cd vibevalley
vp install
vp run nsh:install                  # 打页面的包要用的 nsh 命令行
vp run mac:check                    # 打出页面的包
cargo run -p vibevalley-mac         # 原生应用，里面带着服务端
```

![首页](docs/images/title.jpg)

农场的数据放在 `~/.vibevalley`（`VIBEVALLEY_HOME`）。钥匙在「设置」里填，存在 `$VIBEVALLEY_HOME/settings.json`，详见[设置和配置](docs/subsystems/setting.md)。签名的安装包还没有（[计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)）。

只要服务端和命令行时：

```bash
cargo run -p vibevalley-server                # 127.0.0.1:8787
cargo run -p vibevalley-cli -- issue list     # 对着它
```

### 第一次打开

1. 在「设置」里填 DeepSeek 的钥匙。
2. 在「农机」页里启用本机装好的农机。
3. 在「仓库」页克隆或新建一个仓库。没有也行，助手会帮你建。
4. 在聊天里对助手说要做什么。

从派第一张工单到完成、处理冲突和失败、管住花费，见 [使用指南](docs/guide.md)。

## 目录

```
crates/            Rust：服务端（vibevalley-server）、命令行（vibevalley-cli）、核心规则、契约、oar、自研 agent……
apps/mac/          原生应用：GPUI 的窗口和像素农场（Rust），工作台的页面（nsh TSX）
apps/island/       刘海上的灵动岛（Swift）
apps/site/         官网 vibevalley.dev（Solid 2 静态生成）
packages/          页面用的 TS：生成的契约类型和它的 Zod、词典的目录、笔记和 Artifact 的纯逻辑
assets/            图、像素字、指针和像素村的地图
design/            像素素材的生图提示词、脚本和切图规则（原图和效果图在单独的仓库 vibevalley-art）
docs/              文档：现在怎么用、怎么开发、各部分怎么工作
.agents/notes/     Agent Notes：每个设计决策为什么这样做、放弃了什么
```

## 开发和文档

- [docs/development.md](docs/development.md)：跑起来、检查和测试、发版。
- [AGENTS.md](AGENTS.md)：代码的规矩和常用命令（编码 agent 和人都照它来）。
- [docs/](docs/README.md)：各部分现在怎么工作，和农场叫法的用语表。
- [.agents/notes/](.agents/notes/README.md)：设计决策。改大的行为之前先读相关的那篇。

## 致谢

- [oar](https://github.com/botiverse/oar)（botiverse，Apache-2.0）：驱动编码 agent 的运行时。田头的频道、工单串和外部渠道参照了 botiverse 的 Raft。
- [pi-durable 和 pi-ai](https://github.com/earendil-works/pi)（Earendil）：自研 agent 的循环和持久照它们的做法写。
- [GPUI](https://www.gpui.rs/)、[Zod](https://zod.dev/)、[SQLite](https://sqlite.org/)、[Solid](https://www.solidjs.com/) 和 [Tailwind CSS](https://tailwindcss.com/)：原生应用、页面的解码、数据库、官网和样式。
- [DeepSeek](https://www.deepseek.com/)：助手用的模型。
- [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font)（OFL）：像素字体。
- [Hugeicons](https://hugeicons.com/)（MIT）、[LobeHub Icons](https://github.com/lobehub/lobe-icons)（MIT）：像素图标和农机 logo 照它们的形状重画。
- [openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)、[botpy](https://github.com/tencent-connect/botpy)（腾讯，MIT）：微信和 QQ 的连接器照它们写。
- [LDtk](https://ldtk.io/)：像素村的地图。

## 许可证

[Apache License 2.0](LICENSE)。用到的别的项目和它们的许可证见 [NOTICE](NOTICE)。

Claude、Codex、Cursor、DeepSeek、Agora、微信、飞书、QQ 等名字和 logo 归各自的所有者。VibeValley 用它们只为说明连的是哪一个，和它们没有隶属或背书关系。

发现安全问题请看 [SECURITY.md](SECURITY.md)。
