# Agent Note: 桌面壳按职责分开，并且自己更新自己

Status: proposed

## Problem

`apps/desktop/src/main.ts` 一个文件管着资源路径、窗口、页面的加载、宿主的处理函数、菜单栏、服务端的起停、开发模式的重启和应用的生命周期，状态是几个模块级的 `let`（`server`、`starting`、`window`、`tray`、`bar`），谁都能改。同一件事写了几遍还不一样：把窗口叫到前面有三种写法（第二个实例那处不 `show`，窗口关了就叫不出来）；红绿灯的位置和页面让出的标题条在 main 和 preload 各写一遍；服务端地址去结尾斜杠写了三遍；子进程说的 JSON 行在 `server.ts`、`island.ts` 各手写一遍判断。

桌面版也没法更新：主人只能自己去下新的 `.dmg`。应用没有签名（没有 Apple Developer 账号），Electron 自带的 `autoUpdater`（Squirrel.Mac）只认签过名的应用，用不了。版本号来自 `git describe`，仓库还没有 tag；也没有发布的流水线。

## Proposal

### 一、按职责分开

| 模块 | 管什么 |
|---|---|
| `paths.ts` | 家目录、服务端、页面、岛、日志、字体、图标，一处算好；仓库里跑和打包的应用各一套 |
| `chrome.ts` | 窗口的样子：红绿灯的位置和页面让出的标题条（main 和 preload 共用）、两种主题的底色 |
| `bridge.ts` | 桥的通道和它的两个传输：preload 的 `ipcRenderer`、main 的 `ipcMain`（只听自己窗口的） |
| `lines.ts` | 子进程一行一个 JSON：按 Schema 读，不是的行跳过（服务端的就绪行、岛的点击） |
| `window.ts` | 唯一的窗口：建、只留在服务端的地址上、保持 3:2、开机条和页面的加载、叫到前面（没有就重开）、往页面发 |
| `tray.ts` | 菜单栏：按摘要建菜单，点一行叫出窗口 |
| `host.ts` | main 这一侧的宿主：`serve(desktopBridge, …)` |
| `server.ts` | 服务端子进程，加上它的起停：起来中、在跑、换一个（开发模式）、退出前等它存好；地址进门时去掉结尾斜杠 |
| `dev.ts` | 开发模式的整套接线（页面重载、服务端重启、问有没有帮工在干活） |
| `update.ts` | 自己更新（下面） |
| `main.ts` | 单实例、`whenReady` 里依次接起来、退出 |

第二个实例来时总是叫出窗口，窗口关了就重开。

### 二、自己更新

没有签名，不走 Squirrel；应用自己查、自己下、退出时自己换。信任和主人第一次从 GitHub Release 手动下载 `.dmg` 一样：GitHub 的 HTTPS 和 Release 上的文件，下下来的按清单的 SHA-512 核对。

- **发布**：新的 `.github/workflows/release.yml`，推 `v*` 的 tag 时在 macOS（arm64）上打包，产出 `.dmg`（第一次装）、`.zip`（更新用）和 `release.json`，建成草稿 Release，人看过再发布。`release.json`：版本、说明（这个 tag 和上一个之间合进来的 PR 标题）、表结构的哈希（服务端 `baselineHash` 的算法）、每个架构的文件名、大小和 SHA-512。版本号就是 tag，也写进应用（`package.json` 的 `version`），表结构的哈希一起写进去。
- **查**：打包的应用开机查一次，之后每 4 小时一次，主人也能在「关于」里点；读 `releases/latest/download/release.json`，比本机的版本新才算有。仓库里跑、测试里都不查。
- **下**：本机架构的 zip 下到 `~/Library/Caches/VibeValley/updates/<版本>/`，带进度；大小和 SHA-512 对不上就丢掉、报错。用 `ditto -x -k` 解开，读出的 `Info.plist` 版本要和清单一致。
- **换**：应用不在一个能写的地方时（从 `.dmg` 里直接跑、被系统挪到 `AppTranslocation`、没有写权限）不换，说清楚去哪里下。能换时：先自己停服务端、等它存好，再起一个脱离的小脚本：等这个进程退出，把旧的 `.app` 挪到缓存里留一份，把新的挪到原处，去掉隔离属性，要重开就 `open` 它。
- **什么时候换**：表结构没变的，主人退出时顺手换掉；「关于」和侧栏底部的小图标里可以「现在重启更新」，有帮工在干活时先问。表结构变了的（服务端会把旧库挪到一边，从一个新农场开始），不在退出时换，只告诉主人，由主人点了才换。
- **状态**：没事、在查、有新版（下载中，进度）、下好了（版本、说明、表结构变不变）、不能自己换（为什么、去哪下）、出错（为什么）。状态怎么变是纯函数，单独测。
- **页面**：`desktopBridge` 加推送 `update`（状态）、调用 `updateCheck`、`updateInstall`；`Host` 加可选的 `update`，浏览器和手机没有。「关于」里一行：版本、状态、检查或重启；下好了以后侧栏底部一个图标，悬停是版本和说明。

### 三、以后

有了 Apple Developer 账号，签名、公证，换成 electron-updater（同一份 Release 加 `latest-mac.yml`）；x64 的包另一个 runner。

## Alternatives considered

**electron-updater 不签名用**：它在 macOS 上底层是 Squirrel.Mac，不签名装不上。

**只提示有新版，让主人自己下**：主人还是要自己下载、拖进「应用程序」、处理 Gatekeeper；下载、核对、替换都能做的事不该交给人。

**更新文件再签一层自己的 Ed25519 签名**：能防 Release 上的文件被换，但写 Release 的权限和 CI 的密钥在同一处；没有 Apple 签名时，它不比第一次手动下载更可信。等有签名时一起考虑。

**universal 包或 x64**：服务端的原生模块和岛都分架构，合包容易错；先只出 arm64。

## Acceptance criteria

- `main.ts` 只剩组装；上面列的几处重复各只剩一处。
- 状态机、清单的读取、架构的挑选、表结构的比较、能不能换的判断有单元测试。
- 在一份本地起的假 Release 上，打包的应用查到新版、下载、核对、退出时换掉、重开是新版本；SHA-512 不对时报错不换。
- 仓库里跑和 `desktop:test` 不查更新。
- `vp check`、`web:check`、`desktop:test`、页面 e2e 都过。

## Risks

- 没有签名：Gatekeeper 第一次会拦，主人要右键打开；换上去的新版本是从网络下的，但 Node 下载的文件不带隔离属性，脚本也会去掉。
- 换的脚本出错会留下一个坏的应用：旧的 `.app` 留在缓存里，脚本失败时挪回来。
- 表结构的哈希要和服务端算的一样：用同一个函数（服务端导出），打包时算。
