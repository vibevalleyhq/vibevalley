# Agent Note: 桌面版的渠道和命令行

Status: proposed

## Problem

**渠道。** 发版分了 alpha、beta 和正式版（[发版的阶段](.agents/notes/proposed/process/2026-11-04-alpha-beta-release.md)），但桌面版只有一个身份：`apps/desktop/src/main.ts` 写死 `app.setName("VibeValley")`，`scripts/package.ts` 写死 `appId: dev.vibevalley.app`，农场在 `~/.vibevalley`。想试 alpha 只能让天天用的那个应用换通道（「关于」里刚加的选项），而 alpha 可能让农场从头来，下一版的第一个 beta 也可能改表结构：拿来干活的农场（包括[用 VibeValley 开发 VibeValley](.agents/notes/proposed/process/2026-10-18-build-vibevalley-with-vibevalley.md)）跟着冒险。两个渠道也不能同时开：名字一样就共用 userData 和单实例锁，后开的直接退出；语音线路（8788）、连接到本机（8790）是固定端口，全局快捷键和刘海上的灵动岛整台电脑只有一份。

**命令行。** 能力先于入口（[核心状态](docs/subsystems/core.md)）：页面和命令行调同一批接口，`docs/reference/capabilities.md` 是它们的表，命令行覆盖每个接口。但只装了桌面版的人用不上：
- 打好的应用里有服务端的包，没有 `vibevalley` 命令；命令行只在仓库里（`vp run --filter @vibevalley/server cli`）。
- 命令行找农场靠家目录的 `server.json`（服务端占着家目录时写下自己的地址，`apps/server/src/infra/lease.ts`），家目录只认一个（`~/.vibevalley`，或 `VIBEVALLEY_HOME`）：有了渠道，`vibevalley-beta` 得找 beta 的家目录。
- 桌面版自己的能力（更新、打开窗口到某一页、退出、重启）只在页面和 Electron 主进程之间（`desktopBridge`），不是服务端的接口，命令行没有对应的。
- 命令行的帮助不说命令做什么：一条命令的说明是它的路径（`POST /api/v1/issue/list`），一组的说明是「issue 的接口」，主人和 agent 都看不出该用哪条。
- 有重复的命令：七组各有一条 `preview-delete`，和 `delete --dry-run` 调的是同一个接口。
- 笔记是 VibeValley 最要紧的一块，命令行里却和别的接口一样：记一句话要写 `vibevalley pkm capture --json '{"text":"…"}'`，读一页拿到的是块的 JSON。在终端里记、查、读、改笔记的人和 agent（Claude Code、帮工）都用不顺。
- 出了问题没有一处说清楚：找到的是哪个农场、连不连得上、哪些农机装着、缺哪把钥匙、哪个端口被占，要一条条命令去拼。

## Proposal

**一个渠道一个应用、一个农场、一条命令；桌面版自己的能力和服务端的接口一样写成契约，命令行经本机的套接字调它。**

### 渠道

| 渠道 | 应用 | appId | 农场（家目录） | 工作目录 | 语音线路、连接到本机 | 命令 |
|---|---|---|---|---|---|---|
| 正式版 | VibeValley | `dev.vibevalley.app` | `~/.vibevalley` | `~/vibevalley` | 8788、8790 | `vibevalley` |
| beta | VibeValley Beta | `dev.vibevalley.app.beta` | `~/.vibevalley-beta` | `~/vibevalley-beta` | 8798、8800 | `vibevalley-beta` |
| alpha | VibeValley Alpha | `dev.vibevalley.app.alpha` | `~/.vibevalley-alpha` | `~/vibevalley-alpha` | 8808、8810 | `vibevalley-alpha` |
| 源码 | VibeValley Dev（`desktop:dev`） | 不打包 | `~/.vibevalley-dev` | `~/vibevalley-dev` | 8818、8820 | 仓库里的 `vp run … cli` |

- **身份由版本定**：打包时版本是 tag（`v0.4.0-beta.1` 是 beta），渠道是它的阶段（`releases.ts` 的 `stageOf`）；没打包的是源码。名字、appId、图标的角标、目录、端口都从渠道来，一张表（`apps/desktop/src/channel.ts`），写成 `Record<渠道, …>`，加渠道时编不过。文件名照旧（`VibeValley-<版本>-<架构>`，版本里已经带着阶段），`release.yml` 不用改。
- **更新只在自己的渠道里**：正式版读 `latest`，beta 和 alpha 读 Release 列表里同一阶段的最新一个。「关于」里的更新通道选项去掉：换渠道就是装另一个应用。
- **整台电脑一份的东西**：全局快捷键和灵动岛归先开的那个渠道（拿不到的不抢、不报错），岛上标出它是哪个渠道；它退出后不交给别的。
- **源码的农场挪到 `~/.vibevalley-dev`**：今天源码和打好的应用共用 `~/.vibevalley`，同时开会抢一个库。按[不留兼容](docs/subsystems/foundation.md)直接改，源码的农场从新的开始（旧的还在 `~/.vibevalley`，归正式版）。

### 命令行找到农场

已经有的不动：服务端占着家目录时写 `server.json`（地址和进程），命令行按 `--server` → `VIBEVALLEY_SERVER` → 家目录的 `server.json` → `127.0.0.1:8787` 找。要加的只是家目录跟着渠道：每条命令的启动脚本带上它渠道的 `VIBEVALLEY_HOME`。

### 命令行随应用装上

- `vp pack` 多打一个入口：`src/cli.ts` 成 `dist/cli.mjs`，和服务端的包放在一起。
- 应用里带一个启动脚本（`Contents/Resources/bin/<命令>`）：用应用自带的 Node（`ELECTRON_RUN_AS_NODE=1`）跑 `cli.mjs`，带上这个渠道的家目录。
- 「关于」和应用菜单里「安装命令行」：把它链到 `~/.local/bin/<命令>`（不要管理员权限）；`~/.local/bin` 不在 PATH 里时说怎么加。也能移除。

### 桌面版自己的能力也有命令

- **契约**：`packages/protocol/src/host.ts` 加 `desktopControl`：`open(路径)`（打开窗口到那一页）、`quit`、`restart`、`update.state`、`update.check`、`update.install`。主进程在 userData 的 `control.sock`（只有主人能读写）上用 `@vibevalley/bridge` 回答它，加一个套接字的 `Link`（一行一个 JSON）。
- **命令**：`vibevalley app open /issues/12`、`vibevalley app update [check|install]`、`vibevalley app quit|restart`。应用没开时 `app open` 先开应用（`open -b <appId>`），其余说应用没开。
- **不让它漏**：`desktopBridge` 的每个调用要么在 `desktopControl` 里有对应，要么标明只给页面（通知、托盘、语言、主题、标题栏）：一张 `Record<keyof typeof desktopBridge, "control" | "page">`，加调用时编不过。

### 命令的样子

- **名字照接口**：组和命令的名字就是 `api.ts` 的操作（`pkm`、`artifact`、`game` 都照旧），接口、命令行和 agent 的工具是同一套词；界面上的叫法（笔记、稿子）只在界面上。
- **每个接口一句说明**：词典里每个操作一句（`server.cli.op.<操作>`），每组一句（`server.cli.group.<模块>`），中英两份；命令行的帮助、能力表（`docs/reference/capabilities.md` 多一列）都读它。命令行按操作取说明时键的类型是全部操作的联合，少了一句编不过。管家和帮工的工具描述照旧在各自的 `prompts.ts`（它们为模型调过，评测管着），不改。
- **删掉 `preview-delete`**：命令行不再为 `previewDelete` 这类接口生成命令，它们只经 `--dry-run` 用到（`issue delete --dry-run`）；接口本身留着，页面在用。
- **笔记的命令**（手写的，和 `issue work` 一样，在 `pkm` 组里；手写的顶替同名的生成命令或组，其余生成的照旧在）：读的命令默认打 Markdown，`--format json` 给接口的答复（不用 `--json`：生成的命令拿它收请求体）；只有这一组这样，别的命令照旧是 JSON。

  ```bash
  vibevalley pkm capture 一句话             # 记进今天的日记；--page <标题> 记到那一页的末尾；不给字就读标准输入
  vibevalley pkm today                      # 今天的日记（--day YYYY-MM-DD 看别的一天）
  vibevalley pkm search <词…>               # 按页分组，一条一行：页 › 路径: 块
  vibevalley pkm page get <标题>            # 一页给人读的 Markdown（pkm.page.export：引用读成字，批注去掉）
  vibevalley pkm page edit <标题>           # 在 $EDITOR 里改这一页的原文，关掉编辑器存回去
  vibevalley pkm radar                      # 收件箱、搁着的、过期的
  ```

  接口要补，规则都在服务端：`pkm.capture` 收 `page`（不给是今天的日记），`text` 照大纲读（多行按缩进拆成块）；`pkm.source.get` 读一页文件的原文（带 `id::`）和它上次写的时间，`pkm.source.update` 照原文重写这一页，这期间文件被改过就拒绝，`page edit` 说清楚、把改过的原文留在临时文件里（`pkm.page.save` 对已有的页只改属性和文件夹，不换大纲，所以另起一对）。页名照页面的找法认（标题、slug、别名），找不到时说最像的几页。剪藏不在这一组：它要网页的标题和正文，是浏览器里的剪藏工具给的，命令行不去抓网页，`pkm clip create` 照旧。
- **`vibevalley doctor`**：一条命令说清楚现在的样子，答复和别的命令一样是 JSON：一项一行（哪个渠道和家目录、`server.json` 指向哪、连不连得上、服务端和命令行的版本、装着哪些农机、缺哪些钥匙、语音线路和连接到本机的端口占没占），每项 `ok`、不 ok 时 `why` 和 `next`（和失败时的 `next` 同一种写法）。农场连不上时退出码不是 0。
- **这篇不做**：`vibevalley serve`（不开桌面版、只起一个农场）和把只给 agent 用的命令（`voice hear`、`lan pairing` 这类）收进一个「高级」组，以后另起。

## Alternatives considered

- **一个应用里选更新通道**（刚做的那版）：省掉几个应用，但天天用的农场跟着 alpha 冒险，beta 换到下一版时也一样；同一个应用也开不了两个渠道对比。取代它。
- **渠道各一份配置文件、同一个应用读不同的家目录**：appId 和 userData 还是一份，单实例锁仍然挡住第二个。
- **桌面版的能力挪进服务端的接口**：服务端不该知道窗口和应用怎么换；而且应用没开、服务端也就没有，`app open` 恰好要在那时管用。
- **命令行经 `vibevalley://` 的链接打开页面**：只能做 `open`，做不了更新和退出，还要注册一个全系统的协议。
- **命令行照界面起名**（`notes`、`drafts`）：主人读着顺，但接口、命令行、agent 的工具成了两套词，agent 照帮助调接口时要再翻一次。
- **笔记的命令也只给 JSON**：全命令行一条规矩，但笔记本来就是字，人读 JSON 的块读不下去；agent 要结构时加 `--json`。
- **`page append` 另起一条**：和 `capture --page` 做一样的事，两条路会分开长。
- **说明写在 `api.ts` 的接口旁边**：对主人说的话归词典（[话放在哪](docs/subsystems/foundation.md#话放在哪)），写在契约里就只有一种语言。
- **把命令装进 `/usr/local/bin`**：要管理员权限，每次更新都可能要重来；`~/.local/bin` 链到应用里的脚本，应用换了版本链接还在。

## Acceptance criteria

- 正式版、beta、alpha 的包能同时开，各用各的 userData、家目录、工作目录和端口；先开的那个拿到全局快捷键和灵动岛。
- beta 渠道的应用只更新到 beta，alpha 只到 alpha，正式版只到正式版；「关于」里没有通道选项。
- 只装了应用、跑了「安装命令行」以后，在新的终端里 `vibevalley issue list` 读到这个应用的农场，`vibevalley-beta issue list` 读到 beta 的。
- `vibevalley app open /issues/12` 让窗口到那一页；应用没开时先开它。`vibevalley app update` 说出和「关于」一样的状态。
- `vibevalley issue --help` 里每条命令有一句说明；没有 `preview-delete` 命令，`issue delete --dry-run` 照旧；能力表多了说明一列。
- 笔记：`pbpaste | vibevalley pkm capture` 把一段大纲按缩进记进今天的日记；`vibevalley pkm capture --page 读书 一句话` 记到那一页末尾；`pkm today`、`pkm page get` 打的是和导出一样的 Markdown，`--json` 是接口的答复；`pkm search` 一条一行；`pkm page edit` 存回去时块的 id 不变，编辑器开着时页面在应用里被改过，就拒绝、改过的原文留着。
- `vibevalley doctor` 在应用开着时每项都 ok；关掉应用再跑，说连不上、`next` 说怎么开，退出码不是 0。
- 测试：渠道表是纯函数，有单元测试；套接字的 `Link` 和 `desktopControl` 的来回（bridge 的测试）；`pkm.capture` 带 `page`、多行，和 `page.save` 的 `updated` 冲突（服务端的测试）；笔记命令的输出和 `page edit` 的来回（`EDITOR` 换成一个改文件的脚本）进命令行的测试；命令行 `app` 一组和 `doctor` 的帮助、`doctor` 在测试农场里的答复进命令行的黄金数据；桌面版的 Playwright 起应用后经套接字 `app open` 一页、看窗口到了。
- 文档：[应用](docs/subsystems/app.md) 的桌面壳、自己更新两段，[开发](docs/development.md) 的命令行，`AGENTS.md` 的目录和命令；[发版的阶段](.agents/notes/proposed/process/2026-11-04-alpha-beta-release.md) 里更新通道那一段指到这里。

## Risks

- 命令行在应用里起得慢：`@botiverse/oar` 一加载就带上 Pi 的整套东西（几百毫秒）。命令行只在用到农机的命令里加载它（`runtime chat`），其余的命令不碰。
- 端口按渠道固定，被别的程序占了时那个渠道的语音线路或连接到本机起不来：照今天一样在「设置」里说，能在设置里换。
- 全局快捷键和灵动岛归先开的那个，主人可能以为后开的坏了：后开的「设置」里说它们在哪个渠道那里。
- `~/.local/bin` 里的链接指向应用的位置；应用被挪走或删掉，命令就断了：命令说找不到应用、去哪重新装。

## 做到哪了

- 做了：渠道表和各渠道的应用、农场、工作目录、端口；只在自己的渠道里更新，「关于」里的通道选项去掉；先开的渠道拿全局快捷键和灵动岛；命令行随应用打包（`cli.mjs` 和每个渠道的启动脚本）、「关于」里装到 `~/.local/bin`；`desktopControl` 和 `vibevalley app`；每个接口和每组的说明、能力表的说明一列；`preview-delete` 这类命令去掉；`vibevalley doctor`；笔记的命令和 `pkm.capture` 的 `page`、`pkm.source.get`、`pkm.source.update`。验过：打包一个 `0.5.0-beta.1`，应用是 `dev.vibevalley.app.beta`，经 `~/.local/bin` 的链接跑它的 `vibevalley-beta`，`doctor` 读的是 `~/.vibevalley-beta`；桌面版的 Playwright 经套接字问状态、让窗口到一页。
- 还没做：灵动岛上标出它是哪个渠道（岛是 Swift 的，要它收一个渠道的名字来画）；各渠道图标的角标（要出图）；后开的渠道在「设置」里说快捷键和灵动岛在谁那里。
