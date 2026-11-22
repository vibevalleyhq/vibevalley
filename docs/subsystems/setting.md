# 设置和配置

服务端的运行参数与钥匙来自两处：
- **启动配置（`ServerConfig`）**：二进制 `vibevalley-server` 开机时从命令行参数和环境变量读一次，运行期只读。
- **设置（`Setting`）**：用户在工作台 `/settings` 保存的钥匙、语言、语音、记忆来源和 AI 服务，以 `0600` 权限存在 `$VIBEVALLEY_HOME/settings.json`，保存即生效。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 启动配置的来源和默认值 | 各农机自己的配置文件（如 `pi` 的 `models.json`） |
| `settings.json` 的原子读写、校验、钥匙优先级（设置 > 启动配置）与末四位提示 | 记忆来源的业务（[记性](docs/subsystems/memory.md)） |
| 每个功能的就绪状态（`SettingsStatus.readiness`） | 连接与用途的规则（[AI 服务](docs/subsystems/provider.md)）；档案、技能与农机（`config.json`，[档案和农机](docs/subsystems/agent.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/main.rs` | 读参数（`--web`、`--ready-json`）和环境变量，组装 `ServerConfig`，只听 `127.0.0.1` |
| `crates/server/src/start.rs` | `ServerConfig`（家目录、空间根、钥匙、内置模板、测试开关）与开机组装 |
| `crates/server/src/modules/infra/setting.rs` | `Setting`：`settings.json` 读成 `Stored`；`Secret`；`status`、`validate`、`save`；语音默认值与差异；就绪状态 |
| `crates/protocol/src/home.rs` | 发布通道判定（`ReleaseChannel`）、各通道默认端口与数据目录、`VIBEVALLEY_HOME`、`server.json`、保存的语言 |
| `apps/mac/src/theme.rs`、`apps/mac/src/shell/settings.rs` | 设备本地外观设置（主题、`Settings.motion` 动画幅度、字体与字号，存于 `state.db` `app.settings`）及 `VIBEVALLEY_NO_ANIMATION` 测试覆盖 |
| `apps/mac/ui/features/setting/` | 工作台设置页（`/settings/general` 含通用与设备本地外观分组，`/settings/appearance` 重定向到此页） |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`setting.get`、`setting.validate`、`setting.update`）。

## 模型和不变量

### 启动配置

| 来源 | 用途 | 默认值 |
|---|---|---|
| `VIBEVALLEY_CHANNEL` | 覆盖发布通道（`release`/`final`/`stable`、`beta`、`alpha`、`dev`，不区分大小写） | 见下表判定顺序 |
| `VIBEVALLEY_HOME` | 家目录：`settings.json`、`config.json`、`server.db`、`server.json`、附件 | 按通道（`~/.vibevalley{,-beta,-alpha,-dev}`） |
| `VIBEVALLEY_WORK_ROOT` | 空间：`repos/`、`worktrees/`、`pkm/` 的根，开机时建好 | `~/vibevalley-dev` |
| `VIBEVALLEY_PORT` | 主 HTTP 与 `/mcp` 的端口（只绑 `127.0.0.1`，`0` 随机）；显式非零端口冲突或非法值拒绝开机 | 按通道（`8787` / `8788` / `8789` / `8790`） |
| `VIBEVALLEY_STORE` | 原生应用宿主库 `state.db` 路径（覆盖按通道默认路径） | 按通道（`~/Library/Application Support/VibeValley{,-beta,-alpha,-dev}/state.db`） |
| `VIBEVALLEY_AGENT_STARTERS` | 新农场装在助手旁边的内置模板 ID，逗号分隔 | 空 |
| `VIBEVALLEY_TEST_RUNTIMES=1` | 页面测试用：只有替身农机、媒体离线、不探测农机、不抓链接预览 | 关 |
| `--web <目录>` | 在 `/` 提供构建好的页面 | 无 |
| `--ready-json` | 开始监听后打印一行 `{"url","pid"}` | 关 |

没有 `vibevalley.yaml`；巡查间隔、PR 轮询这类值写在代码里。

### 发布通道默认端口与数据目录

发布通道判定统一收口在 `crates/protocol/src/home.rs`（`ReleaseChannel`），优先级依次为：① 有效的 `VIBEVALLEY_CHANNEL` 环境变量；② 位于 `*.app/Contents/MacOS/` 内的打包二进制读取 `Contents/Info.plist` 的 `VibeValleyVersion`（回落 `CFBundleShortVersionString`：空或 `0.0.0` 为 `dev`，含 `-alpha.` 为 `alpha`，含 `-beta.` 为 `beta`，其余为 `release`）；③ 未打包运行（如 `cargo run`）默认为 `dev`。显式设置的 `VIBEVALLEY_PORT`、`VIBEVALLEY_HOME` 与 `VIBEVALLEY_STORE` 始终优先于通道默认值。

| 发布通道 | 默认端口 | 默认家目录（`VIBEVALLEY_HOME`） | macOS 宿主数据目录（`Application Support`） |
|---|---|---|---|
| `release`（`final` / `stable`） | `8787` | `~/.vibevalley` | `VibeValley` |
| `beta` | `8788` | `~/.vibevalley-beta` | `VibeValley-beta` |
| `alpha` | `8789` | `~/.vibevalley-alpha` | `VibeValley-alpha` |
| `dev`（未打包 / `0.0.0`） | `8790` | `~/.vibevalley-dev` | `VibeValley-dev` |

`vibevalley-mac` 在未显式指定 `VIBEVALLEY_PORT` 时优先绑定当前发布通道默认端口，遇到端口已被占用（`AddrInUse`）会向 stderr 告警并自动回落到 `127.0.0.1:0`，将实际监听地址写入对应通道家目录的 `server.json`。

### 设置与钥匙

- **设置优先于启动配置**：DeepSeek 钥匙先取 `settings.json`，空的才用 `ServerConfig` 给的，保存后立刻生效。
- **钥匙在内存里是 `Secret`**：`settings.json` 一次读成 `Stored`，钥匙封成 `Secret`，`Debug` 只出提示，只在真正发请求处 `expose()`；`setting.get` 只给来源（`settings`/`config`）和末四位。
- **原子写、坏文件留底**：经临时文件改名写入，权限 `0600`；读不懂的文件改名为 `settings.json.bad`，从空设置开始。
- **就绪状态由服务端算一份**：`status` 为每个功能（助手、生图、理解、语音、对白、音色设计、转写、听写、Live、Vision、电话）给出就绪或缺什么；连接的部分问 `Providers::readiness`。
- **空间路径**：`SettingsStatus.paths` 给出 `repos`、`worktrees`、`pkm` 的绝对路径。
- **语音设置只存差异**：`voice` 只存和默认值不同的项。
- **设备本地外观与动画幅度独立于 `settings.json`**：主题、动画幅度（`Settings.motion`：`off | on | system`，默认 `system`）、界面缩放与终端字体属于单机宿主设置，存在 `state.db` 的 `app.settings` 中，在 `/settings/general` 外观分组经 `host.*`（含 `host.motion`）即时生效并同步到全部托管视图；环境变量 `VIBEVALLEY_NO_ANIMATION=1`（`1` 或 `true`）仅在当前进程将生效动画幅度强制覆盖为 `off`（供 UI 截图与测试使用，不改写用户设置），TSX 页面通过 `apps/mac/ui/design/motion.ts` 统一消费并由 `scripts/audit/ui-tokens.ts` 的 `unmanaged-motion` 规则守护（详见[客户端](docs/subsystems/app.md)）。

## 怎么走

1. **开机**：`main.rs` 组装 `ServerConfig`；`Setting::open` 读 `settings.json` 并按它设好语言。
2. **校验与保存**：页面调 `setting.validate` 查格式；保存调 `setting.update`（`can` 只有 `user`），整份原子写盘。

## 为什么这样

- **启动配置与设置分开**：启动配置只在开机读一次，设置在运行期由界面原子更新，互不覆盖；两类钥匙在内存里都是 `Secret`，明文不进日志。
- **就绪状态由服务端算**：绑定规则只写一处，页面不再推一份，也不等发出去才报错。

## 怎么验证

- `crates/server/tests/setting.rs`：这里存的钥匙压过启动配置且只显示末四位、有一项不对整份不存、语音只存差异、语音厂商的钥匙只给提示且就绪跟着连接走。
- `apps/mac/ui/design/motion.test.ts`、`apps/mac/ui/app/interactions.test.tsx`、`apps/mac/ui/app/scenarios.test.tsx`、`apps/mac/ui/app/components.test.tsx`：动效辅助函数、设置页（含动画幅度切换与宿主同步）与表单控件的虚拟时钟页面测试（`nsh/test`），配合 `vpx scripts/audit/ui-tokens.ts` 校验未托管动画规则。
