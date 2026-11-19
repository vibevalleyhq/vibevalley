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

改宿主项目加载或终端恢复时，运行 `python3 scripts/release/verify-workspace-store.py target/debug/vibevalley-mac`。脚本从窗口动作打开新目录，并保持另一个 SQLite 写事务到下一次绘制。两个入口都应成功保存新项目。脚本只使用临时目录。

## 步骤

1. 建一个临时目录，写脚本文件。一行一步，`#` 开头的是注释；步骤在项目读完以后开始，每步之间隔 400 毫秒：

   ```
   {"shell":"hosted:vv {\"route\":\"/issues\"}"}
   {"shell":"wait:1500"}
   {"shell":"shot:/tmp/vv-app/issues-light.png"}
   {"shell":"toggle_theme"}
   {"shell":"shot:/tmp/vv-app/issues-dark.png"}
   {"shell":"toggle_theme"}
   {"shell":"hosted:vv {\"route\":\"/farm\"}"}
   {"shell":"wait:1500"}
   {"shell":"shot:/tmp/vv-app/farm.png"}
   {"shell":"close_kind:hosted"}
   {"shell":"close_kind:pixel"}
   {"shell":"quit"}
   ```

2. 在仓库根目录起应用，家目录、外壳的库都指到临时目录：

   ```bash
   mkdir -p /tmp/vv-app/home /tmp/vv-app/work
   VIBEVALLEY_HOME=/tmp/vv-app/home VIBEVALLEY_WORK_ROOT=/tmp/vv-app/work VIBEVALLEY_STORE=/tmp/vv-app/state.db VIBEVALLEY_NO_OPENING=1 \
   VIBEVALLEY_DEBUG_DUMP=/tmp/vv-app/dump.json VIBEVALLEY_DEBUG_SCRIPT=/tmp/vv-app/steps.txt \
     target/debug/vibevalley-mac 2> /tmp/vv-app/app.log
   ```

   - 要一座有工单、有帮工的样例农场而不起服务端：加 `VIBEVALLEY_FAKE_SERVER=crates/vibevalley-bridge/fixtures/farm`（`state.json` 和 `responses.json`）。
   - 要真的服务端里的数据：不设 `VIBEVALLEY_FAKE_SERVER`，应用自己在 `VIBEVALLEY_HOME` 里起服务端并写 `server.json`；另开一个终端用同一个 `VIBEVALLEY_HOME` 跑命令行造数据（`VIBEVALLEY_HOME=/tmp/vv-app/home target/debug/vibevalley issue create …`），脚本里先 `wait` 够久。
   - 验收目录里的 `state.db` 与 `nsh/` 分别保存宿主和页面数据。自定义库名使用同目录的 `<库名>.nsh/`。库是空的时候，起应用的那个目录就是第一个项目。

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

## 验证宿主存储隔离

修改宿主库或 nsh 存储路径时，用真实应用检查页面写入的文件。

1. 将 `apps/mac/ui/build` 复制到验收目录。向副本的 `bundle.js` 开头加入 `import { Storage as Probe } from "nsh"; void Probe.setItem("vv-store-probe", "first");`。
2. 将 `VIBEVALLEY_UI_BUNDLE` 指向该副本，按前文用隔离家目录启动应用。用 `VIBEVALLEY_STORE=/tmp/vv-app/state.db` 启动第一遍，等 `/tmp/vv-app/nsh/dev.vibevalley.ui/storage.json` 写入后退出。
3. 将副本中的 `first` 改成 `second`。用同目录的 `other.db` 启动第二遍，核对 `/tmp/vv-app/other.db.nsh/dev.vibevalley.ui/storage.json` 的值为 `second`，第一个文件仍为 `first`。

### 对齐 Web 和原生农场

在 macOS 上准备 Go/Web 和 Rust 原生源码检出，按各自开发指南安装依赖。验收工具使用当前仓库的 Playwright Chromium 和 `uv`。Retina 屏幕用 `--dpr 2`，标准屏幕用 `--dpr 1`。输出目录应为空。[验收入口](scripts/release/verify-farm-frames.py)

```sh
python3 scripts/release/verify-farm-frames.py \
  --web-root /path/to/go-checkout --native-root "$PWD" \
  --dpr 2 --out .test/farm-parity/run-1
```

已有构建可传 `--go-binary`、`--web-dist`、`--native-binary`、`--native-bundle` 和 `--native-assets`。原生可执行文件应为启用 `shot` 的调试构建。若省略某端的源码目录，应提供对应的完整生产提交号（`--web-commit` 或 `--native-commit`）。清单分别记录检出状态和实际产物的 SHA-256。

1. 工具启动隔离的 Go 服务提供正式 Web 构建。浏览器经本地回放层打开 `/farm/parity`。回放层在 SSE 连接中发送固定业务帧，并用同一份样例返回读取结果。
2. 原生应用经 `hosted:vv` 打开同一路由。两端使用相同的工单、工作槽和作物。原生帧补上工单作用域对应的 `issue`，缺少的 `refining` 取 `false`。原始帧、转换后帧和接口响应都保存在证据目录。[固定业务帧](scripts/release/fixtures/farm-parity/state.json)
3. 工具分别取 1280×800 白天、1280×800 夜间和 640×720 白天。每端每个场景取两张。浏览器核对画布就绪、字体和 HUD 时钟。原生核对业务帧序号、帮工、时钟和实际画布宽度。普通农场路由侧栏占 72 点，直开 `pixel:farm` 可能保留工作台的侧栏宽度。
4. 查看 `result.json` 及其链接的各份 `metrics.json`。每个场景包含跨端对照、Web 重复采样和原生重复采样。报告覆盖全图、世界区、地块、侧栏、工具栏、时钟和帮工按钮。仓库木牌保留世界坐标取样区，另按按钮的实际边界测量。昼夜固定后，帮工和环境动画仍会推进。两个同端报告记录这部分噪声。[图像指标](scripts/release/compare-farm-frames.py)

退出码 0 表示跨端与同端重复采样均过门槛。退出码 1 表示截图和指标已生成，存在未过门槛的区域。退出码 2 表示输入、构建、场景就绪或截图尺寸校验失败。交互动作与业务回执另在真实服务上验收。

对同一原生构建分别采自然动画和固定步数两组图后，运行 `python3 scripts/release/report-farm-modes.py <自然组目录> <固定组目录> --out <汇总.json>`。脚本核对两组的业务帧、视口、Go 服务、原生构建、素材、Web 提交和比较器，按模式汇总全图与各区域的跨端和同端分数。

### 核对固定步长的农场动画

运行自然时序对照后，在新目录运行同一命令，并增加 `--firefly-seed 93471 --ticks 30`。受控模式从 `--web-root` 的 Git 提交重新构建浏览器页面。准备好锁文件对应的离线包。原生应用使用带 `shot` 的构建。[采帧入口](scripts/release/verify-farm-frames.py)

两端等到相同业务序号后，各自执行指定次数的 1/60 秒步进。两端用同一串均匀随机数初始化萤火。场景仍执行飞行、闪烁、发光和渲染。Web 的跳动标牌也定位到该时刻。其他生物的随机输入单独核对。更换种子可复验读数顺序。[参考端输入适配](scripts/release/farm_motion.py) · [原生时钟](apps/mac/src/pixel/farm/capture.rs)

受控目录保存参考端的输入补丁、种子、步数及其回执。萤火的坐标和强度只用于对账。数值相同仍应检查真实窗口的图像门槛。发布判断保留 `natural` 与 `fixed_ticks_firefly_seed` 两份结果。

## 证据

- 脚本文件、起应用的命令、`app.log` 里每步的行。
- 和改动有关的截图，以及截图里对应的变化；改了布局时附一张窄窗口的。
- 切主题后核对画面颜色确实变化，不能只看 `theme_dark`；打开农场再缩窄窗口，`dump.json` 的 `pixel.kind` 应仍是 `farm`，不能先缩窄再重新打开农场代替这一步。
- `dump.json` 里托管视图没有报错（`hosted` 下的错误是空的）。

## 出错时

- **视图说包没打出来**：没有 nsh 或没跑 `vp run mac:check`；看构建时 `cargo:warning=nsh build` 的行。
- **`shot` 没写出文件**：构建没带 `--features shot`，或路径的目录不存在；看 `app.log`。
- **页面是空的或一直在读**：`dump.json` 里看那个视图有没有收到 `state` 帧；用真服务端时看 `app.log` 里 `vibevalley server:` 的行。
- **`key` 一步写着 `handled=false`**：焦点不在认这个快捷键的地方；先 `mouse:click` 到那个窗格。
- **像素窗格是空的**：`assets/` 找不到（`VIBEVALLEY_ASSETS` 指过去），或素材没切（[开发](docs/development.md#素材音效和官网)）。

## 验收三张并行工单

对本地安装包运行 `python3 scripts/release/verify-native-work.py <VibeValley.app>`。脚本创建隔离的家目录、宿主库和工作目录。帮工使用脚本农机。脚本在第三单写入 Git 后强制退出本次启动的应用，再重开同一目录。终端打印证据目录，`result.json` 记录问答、已审版本合并及中断轮次。使用开发构建时传入原生二进制和匹配的 `--cli`。[验收脚本](scripts/release/verify-native-work.py)

自愿试用时，加 `--prepare-trial`。脚本备好三单，关闭应用，并打印两个本地文件的路径。

1. 用「文本编辑」打开 `trial-card.txt`。给试用者看卡片开头的任务。若有观察者，由观察者填下半页。
2. 双击同目录的 `open-trial.command`。试用者自己找工单、做决定。观察者从三张工单可以点开时起计时，按卡片记录用时、提示、卡点和实际结果。
3. 退出应用，将卡片保存在原处。下次试用重新运行准备命令，使用新目录。程序演练只验入口和状态；真人的时间与决定由自愿参加的人填写。

### 演示页的就绪回执

运行 [WebView 验收脚本](scripts/release/verify-presenter-webview.sh)。它先在 AppKit 和 GPUI 中各读取一次本地 HTML 正文，再在真实 GPUI 窗口打开工作台的三页样例。脚本从侧栏进入 Artifact，打开演讲者视图，核对每一页的页码、下一页、讲稿、末页按钮和返回入口。三个日志保存在脚本输出的目录。比较其他 nsh 版本时，传入对应命令的绝对路径，两个宿主需与命令版本一致。

验收存储与真实应用时，用 `artifact.create` 保存一份 `kind: html`、`display: slides` 的三页文稿。给前两页写不同的 `aside.notes`，末页留空。从该文稿的演讲者按钮进入，用右方向键、Page Down、左方向键依次到第 2、3、2 页，再返回文稿。分别核对当前正文、下一页正文、讲稿，以及末页提示。

锁屏时，显示器会暂停请求新帧。脚本在 WebView 挂载后改变一次窗口宽度，让 GPUI 创建原生子视图。用应用的调试脚本验收时，在进入新页面后执行 `draw`，等网页回执后再绘制一次。`shot` 只记录 GPUI 的 Metal 纹理。WebView 的文字和图片应从解锁窗口直接查看，或用 WKWebView 的 `takeSnapshot` 对两个子视图分别取证。

## 收拾

脚本最后 `quit`；删掉临时目录。截图不进 git。

## 打包和更新

1. 跑 `vp run package:mac --version 0.0.1 --out /tmp/vv-package-old` 和 `vp run package:mac --version 0.0.2 --out /tmp/vv-package-new --skip-build`。默认使用本地 ad-hoc 签名，不上传或公证；发布包才显式传 `--sign` 和 `--notary-profile`。
2. 跑 `vp run update-check --from /tmp/vv-package-old/VibeValley.app --to /tmp/vv-package-new/release.json`。脚本复制旧包到临时目录，用本机 HTTP 提供新清单和 ZIP，以隔离家目录运行旧包，等它校验并在退出后替换，再启动新包。
3. 核对打印的证据目录：`result.json` 的 `ok`、`restarted`、`serverHealthy`、`signatureVerified` 均为 true，`before`、`after` 是两个版本；`app.log` 含 ready 状态，`health.json` 是新进程的健康响应，`dump.json` 的 `loaded` 是 true、`load_error` 为空，`workbench` 已应用 `state` 帧且没有错误。
4. 检查新旧输出目录都含 `.app`、`.dmg`、`.zip`、`release.json`。用 `codesign --verify --deep --strict <app>` 验签；ad-hoc 验签不代表 Developer ID 或公证通过。

在候选包上运行 `python3 scripts/release/verify-farm-dispatch.py /绝对路径/VibeValley.app`。脚本在原生农场手机上输入一条派工请求。回环模型返回建单工具调用。脚本还验包内 CLI 的 doctor 与频道读写，并等真实时钟触发一次定时任务。测试环境使用临时家目录和假凭据，沙箱只允许回环出站。凭 `result.json`、`local-model.json`、`field.json` 和 `cron.json` 对账。Debug 构建使用 `--features shot` 时另有渲染截图。该用例使用 1280 × 820 点窗口的农场布局。

更新检查先在旧包创建宿主项目和工单，再让脚本帮工按回复提交两次。升级后对照 `before-data.json` 与 `after-data.json`，确认项目、工单、会话、消息和 Git 提交保留。

脚本不改 `/Applications`，失败也保留证据；日志中出现 hash、signature 或 archive 错误时先查清单和包，不跳过校验。交付后可删两个输出目录和打印的临时目录。


### 数据库升级和回退

用旧包和候选包分别传给 `python3 scripts/release/verify-native-data.py <旧.app> <新.app>`。脚本限制外部网络，在临时目录运行真实应用及包内 CLI。终端输出证据目录。旧包写入工单、工单目录、消息、记性、笔记、Artifact、媒体和宿主布局。连接器加载[旧版离线存储样本](scripts/release/fixtures/connector-275732ef1.json)。脚本平移样本时间以保留其有效期，并将待发分片关联到本次旧包生成的汇报。

新包应能审查旧工单、合并原改动并结算一次新回复。回退前先归档升级后的完整数据，再将旧包的备份恢复到原绝对路径。查看 `result.json` 的新旧提交、实际 SQLite 版本、宿主与服务库版本和启动耗时。`backup-files.json` 记录冷备份清单。

在有冻结源码和工具链的开发机上，运行 `python3 scripts/release/verify-native-schema.py <证据目录>/upgraded-cohort --source <候选包检出>`。需要已安装 JS 依赖、sqlc 和 Cargo 缓存。若当前仓库缺少 Go 对照提交，可用 `--go-repo <Go 仓库>` 指向含 `a2c1851ab` 的检出。输出给出宿主库与服务库的表归属、DDL、索引、外键、生产与测试依赖。脚本还在临时目录修改一份生成物，验证 CI 使用的 `sqlc diff` 能发现变化。
