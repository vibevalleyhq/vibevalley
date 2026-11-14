# 验收应用

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册：起一个和用户的数据隔开的原生应用（`apps/mac`），用脚本一步一步驱动它，把要看的页面和像素场景截成 PNG，拿眼睛看。不用看屏幕，锁屏时也能跑。命令以 `apps/mac/src/debug.rs` 为准。

## 什么时候用

- 改了 `apps/mac/ui`（工作台的页面、外壳的面、令牌）。
- 改了 `apps/mac/src`（外壳、宿主能力、终端、像素场景）或 `assets` 的贴图、字体、地图。
- 改了形状，想看服务端的新字段在页面上画出来。

不用它：只改了 `apps/mac/ui/vv/web/infra`、`apps/mac/ui/vv/web/state` 或 feature 里的纯函数、测试已经覆盖的；只改了像素场景的规则、`apps/mac/src/pixel/tests.rs` 已经覆盖的（设 `VIBEVALLEY_PIXEL_OUT=<目录>` 跑 `cargo test -p vibevalley-mac pixel`，看它写出的 PNG）。

## 准备

1. `vp run nsh:install`（一次），`vp run mac:check`：类型检查，并把页面的包打到 `apps/mac/ui/build/`，调试构建的应用从这里读。
2. `cargo build -p vibevalley-mac --features shot`：不带 `shot` 时 `shot:` 一步只报「build with --features shot」。
3. 改了 TSX 只用重跑第 1 步；改了 Rust 重跑第 2 步。

## 步骤

1. 建一个临时目录，写脚本文件。一行一步，`#` 开头的是注释；步骤在项目读完以后开始，每步之间隔 400 毫秒：

   ```
   {"shell":"hosted:vv {\"route\":\"/issues\"}"}
   {"shell":"wait:1500"}
   {"shell":"shot:/tmp/vv-app/issues-light.png"}
   {"shell":"toggle_theme"}
   {"shell":"shot:/tmp/vv-app/issues-dark.png"}
   {"shell":"toggle_theme"}
   {"shell":"pixel:farm {}"}
   {"shell":"wait:1500"}
   {"shell":"shot:/tmp/vv-app/farm.png"}
   {"shell":"close_kind:hosted"}
   {"shell":"close_kind:pixel"}
   {"shell":"quit"}
   ```

2. 在仓库根目录起应用，家目录、外壳的库都指到临时目录：

   ```bash
   mkdir -p /tmp/vv-app/home
   VIBEVALLEY_HOME=/tmp/vv-app/home VIBEVALLEY_STORE=/tmp/vv-app/state.db VIBEVALLEY_NO_OPENING=1 \
   VIBEVALLEY_DEBUG_DUMP=/tmp/vv-app/dump.json VIBEVALLEY_DEBUG_SCRIPT=/tmp/vv-app/steps.txt \
     target/debug/vibevalley-mac 2> /tmp/vv-app/app.log
   ```

   - 要一座有工单、有帮工的样例农场而不起服务端：加 `VIBEVALLEY_FAKE_SERVER=crates/vibevalley-bridge/fixtures/farm`（`state.json` 和 `responses.json`）。
   - 要真的服务端里的数据：不设 `VIBEVALLEY_FAKE_SERVER`，应用自己在 `VIBEVALLEY_HOME` 里起服务端并写 `server.json`；另开一个终端用同一个 `VIBEVALLEY_HOME` 跑命令行造数据（`VIBEVALLEY_HOME=/tmp/vv-app/home target/debug/vibevalley issue create …`），脚本里先 `wait` 够久。
   - 库是空的时候，起应用的那个目录就是第一个项目。

3. 脚本里能写的步骤：

   | 步骤 | 做什么 |
   |---|---|
   | `{"shell":"hosted:<视图>[ <参数 JSON>]"}` | 开一个托管视图的窗格；工作台是 `vv`，参数 `route` 是打开的路由 |
   | `{"shell":"pixel:<场景>[ <参数 JSON>]"}` | 开一个像素窗格：`farm`（参数 `repo`）、`map`、`tree`、`catalog`、`opening` |
   | `pixel_tap:<x>,<y>[,right]`、`pixel_point:<x>,<y>` | 在当前像素窗格上点、指，坐标是画里的像素 |
   | `pixel_clock:<0..1>[,<速度>]` | 定住农场的昼夜时间 |
   | `shot:<文件.png>`、`draw` | 画一帧并把窗口截成 PNG；只画一帧 |
   | `key:cmd-1 cmd-shift-p`、`type:<文字>` | 按键走快捷键的分发；逐字敲 |
   | `mouse:<down\|up\|move\|drag\|click>,x,y[,right]` | 鼠标事件，坐标是窗口里的点 |
   | `new_terminal`、`split_right`、`split_down`、`close_tab`、`activate:<n>` | 终端、分栏、关标签页、切项目 |
   | `send:<文字>` | 敲进当前终端并回车 |
   | `palette:<files\|commands\|search>`、`query:<文字>`、`close_palette` | 命令面板 |
   | `resize:<宽>,<高>` | 调整窗口尺寸（点），验窄窗布局 |
   | `toggle_theme`、`save`、`wait:<毫秒>`、`quit` | 换主题、存布局、等、退出 |
   | `close_kind:<pixel\|hosted\|terminal>[@<标题里的字>]`、`close_tab_id:<id>` | 关掉脚本自己开的窗格（布局会存下来） |
   | 不带 `shell` 的一行 JSON | 当成页面发来的动作（`apps/mac/src/hosted/bridge.rs` 的 `Action`），如 `{"type":"openFarm","repo":""}` |

4. 读证据：截图；`dump.json`（每秒重写：项目、布局、每个终端可见的字、每个托管视图收到的帧和报的错、像素窗格的状态）；每个开着的像素窗格另有一张 `dump.<场景>-<标签页>.png`，是同一帧在 CPU 上画的；`app.log` 里 `debug script:` 开头的行是每一步和它的结果。
5. 打开截图，对照改动检查内容、用语、溢出和重叠，浅色、深色各看一张。空状态只能证明空状态，不能代替列表、卡片和详情的验收。

## 证据

- 脚本文件、起应用的命令、`app.log` 里每步的行。
- 和改动有关的截图，以及截图里对应的变化；改了布局时附一张窄窗口的。
- `dump.json` 里托管视图没有报错（`hosted` 下的错误是空的）。

## 出错时

- **视图说包没打出来**：没有 nsh 或没跑 `vp run mac:check`；看构建时 `cargo:warning=nsh build` 的行。
- **`shot` 没写出文件**：构建没带 `--features shot`，或路径的目录不存在；看 `app.log`。
- **页面是空的或一直在读**：`dump.json` 里看那个视图有没有收到 `state` 帧；用真服务端时看 `app.log` 里 `vibevalley server:` 的行。
- **`key` 一步写着 `handled=false`**：焦点不在认这个快捷键的地方；先 `mouse:click` 到那个窗格。
- **像素窗格是空的**：`assets/` 找不到（`VIBEVALLEY_ASSETS` 指过去），或素材没切（[开发](docs/development.md#素材音效和官网)）。

## 收拾

脚本最后 `quit`；删掉临时目录。截图不进 git。

## 打包和更新

1. 跑 `vp run package:mac -- --version 0.0.1 --out /tmp/vv-package-old` 和 `vp run package:mac -- --version 0.0.2 --out /tmp/vv-package-new --skip-build`。默认使用本地 ad-hoc 签名，不上传或公证；发布包才显式传 `--sign` 和 `--notary-profile`。
2. 跑 `vp run update-check -- --from /tmp/vv-package-old/VibeValley.app --to /tmp/vv-package-new/release.json`。脚本复制旧包到临时目录，用本机 HTTP 提供新清单和 ZIP，以隔离家目录运行旧包，等它校验并在退出后替换，再启动新包。
3. 核对打印的证据目录：`result.json` 的 `ok`、`restarted`、`serverHealthy`、`signatureVerified` 均为 true，`before`、`after` 是两个版本；`app.log` 含 ready 状态，`health.json` 是新进程的健康响应，`dump.json` 的 `loaded` 是 true、`load_error` 为空，`workbench` 已应用 `state` 帧且没有错误。
4. 检查新旧输出目录都含 `.app`、`.dmg`、`.zip`、`release.json`。用 `codesign --verify --deep --strict <app>` 验签；ad-hoc 验签不代表 Developer ID 或公证通过。

脚本不改 `/Applications`，失败也保留证据；日志中出现 hash、signature 或 archive 错误时先查清单和包，不跳过校验。交付后可删两个输出目录和打印的临时目录。
