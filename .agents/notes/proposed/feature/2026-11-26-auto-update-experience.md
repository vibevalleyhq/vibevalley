# Agent Note: 流畅、可恢复、透明的桌面自动更新体验

Status: proposed

## Problem

当前桌面端自动更新（`apps/mac/src/update/`、`packages/protocol/src/host.ts`、`apps/mac/ui/infra/host.ts`、`apps/mac/ui/app/Shell.tsx`、`apps/mac/ui/features/setting/UpdateRow.tsx`）已具备多通道清单解析、ZIP 路径校验、SHA-512 核验、`codesign` 团队签名核对与退出后 `swap.sh` 替换，但在真实桌面使用中存在十项体验与可靠性缺口：

| 缺陷 | 源码位置 | 机制与后果 |
|---|---|---|
| `host.updateCheck` 阻塞等待整次下载 | `apps/mac/src/update/updater.rs:349-354`、`apps/mac/ui/infra/host.ts:93-99` | `UpdateOp::Check` 直接 `updater.check().await` 直到下载、校验和解压全部结束才回包 `Envelope::ok(Value::Null)`；「设置 → 关于」触发检查后调用长时间挂起，慢网下容易超时或让按钮锁死 |
| 下载不可续传、无重试且先删旧目录 | `apps/mac/src/update/fetch.rs:213-250, 348-351` | `staged_app` 先执行 `remove_dir_all(folder)` 清空已有局部文件，随后 `download` 仅发一次普通 `GET`，无 `Range` 断点续传且不对瞬时断流或 5xx 重试；大包中断后必须从 0 字节重下 |
| 下载达 100% 后长时假死 | `apps/mac/src/update/fetch.rs:351-384` | 下载写满 `100%` 后依次执行 SHA-512 哈希、ZIP 条目扫描、`/usr/bin/ditto -x -k` 解压与两次 `/usr/bin/codesign` 校验，期间状态停在 `downloading(100%)`，数秒至十余秒无反馈，用户误以为卡死 |
| 替换阶段无反馈且 `swap.sh` 失败静默吞没 | `apps/mac/src/update/updater.rs:236-283` | `swap(true)` 在退出前同步执行 `/usr/bin/ditto` 复制 `.app` 且未发 `installing` 态；`swap.sh` 的 `stdout`/`stderr` 全部重定向到 `/dev/null`，退出后 `mv` 失败虽会回滚原包，但无日志落盘、下次启动无提示 |
| 一键直接退出隐藏更新内容 | `apps/mac/ui/app/Shell.tsx:142-150` | 无活跃执行会话且 `newFarm === false` 时，点击左侧栏 `rail-update-btn` 直接调用 `doInstall()` 退出应用，跳过更新说明弹窗，用户看不到版本变更、`release.notes` 与「下次退出时更新」选项 |
| 10 秒 / 1 秒轮询带来状态滞后 | `apps/mac/ui/infra/host.ts:54-92` | `update.watch` 仅定时轮询 `hostApi.updateState()`（空闲 `10 秒`、检查或下载中 `1 秒`），宿主推送能力未接入，手动检查或阶段切换存在可见延迟 |
| 原始英文错误直出且缺恢复路径 | `apps/mac/src/update/updater.rs:180`、`apps/mac/ui/features/setting/UpdateRow.tsx:29-30` | 所有失败压扁为裸字符串 `State::Failed { why }`，界面直接拼出原始英文异常，不区分网络、限流、校验、签名、权限与安装失败，也缺少回退的手动下载链接 |
| GitHub Releases API 无 ETag 缓存 | `apps/mac/src/update/updater.rs:159-166`、`apps/mac/src/update/fetch.rs:99-120` | Alpha / Beta 通道每 30 分钟请求 `api.github.com/repos/vibevalleyhq/vibevalley/releases?per_page=30`，未发送 `If-None-Match` 且不缓存响应；未认证客户端受 60 次/小时 IP 限额约束，易触发 `403` 限流 |
| 旧版本暂存目录持续堆积 | `apps/mac/src/update/updater.rs:219, 242, 267` | `$VIBEVALLEY_HOME/updates/<version>` 按版本落盘解压后的完整 `.app`，多次升级后不清理旧版本目录，且同目录残留的 `.VibeValley-update-*` 与 `.VibeValley-previous-*` 目录不被回收 |
| 开发构建误报「已是最新版本」 | `apps/mac/src/update/updater.rs:135, 174-176`、`apps/mac/ui/features/setting/UpdateRow.tsx:19-20, 46` | `Feed::Off`（仓库直跑、未打包或 `0.0.0`）时仍以 `State::Idle` 初始化；设置页据此显示「已是最新版本」和「检查更新」按钮，点击后 Rust 空返回，前端再弹出「已是最新版本」提示 |

## Proposal

围绕「非阻塞即时推送 + 显式完整状态机 + 可续传与缓存的下载管道 + 可观测的退出替换 + 克制透明的工作台交互」五部分重构桌面自动更新，保留既有的安全校验链路（SHA-512、ZIP 路径与符号链接检查、通道包标识校验、Developer ID 同团队签名校验）与 [update-check.ts](scripts/release/update-check.ts) 自动化验收约定。

### 1. 非阻塞检查与宿主即时推送（`update_state`）

- **`UpdateOp::Check` 立即返回**：`apps/mac/src/update/updater.rs` 收到 `host.updateCheck` 时，在 `vibevalley_runtime::rt` 后台任务启动 `updater.check()`，立即回包 `Envelope::ok(...)`，不再等待清单拉取或安装包下载完成。
- **Rust 侧状态广播**：`Updater` 内置 `tokio::sync::watch` 通道保存最新序列化的状态 JSON；每次 `set(next)` 状态变化时，一方面维持 `eprintln!("update: ...")` 供 [update-check.ts](scripts/release/update-check.ts) 解析，另一方面通过广播通知挂载中的 `HostedView`（`apps/mac/src/hosted/view.rs`），由宿主经 `host.send("update_state", ...)` 即时推送到页面。
- **前端推送优先订阅**：`apps/mac/ui/infra/host.ts` 的 `update.watch` 挂载后立即注册 `host.on("update_state", ...)`（在边界经 `UpdateState.safeParse` 解码），同时执行一次初始 `hostApi.updateState()` 获取当前快照，并将定时刷新降为低频兜底（例如 `60 秒`），消除 `10 秒 / 1 秒` 轮询滞后。

### 2. 完整状态机与类型化失败契约

在 [host.ts](packages/protocol/src/host.ts) 中将 `UpdateState` 扩充为 9 个显式判别联合分支，新增封闭错误分类 `UpdateFailureKind`，页面层以穷尽 `switch` 分支（无默认兜底）渲染：

| `_tag` | 字段 | 语义与触发条件 |
|---|---|---|
| `disabled` | `version` | `Feed::Off`（开发构建、未打包或 `VIBEVALLEY_UPDATE_FEED=off`）时的初始稳定态 |
| `idle` | `version`, `checkedAt?` | 当前无可用更新；`checkedAt` 为最近一次检查完成的毫秒时间戳 |
| `checking` | `version` | 正在请求发布清单或 GitHub Releases 列表 |
| `downloading` | `version`, `next`, `percent`, `downloadedBytes?`, `totalBytes?`, `speedBps?` | 正在下载安装包；提供百分比、已下载/总字节数与实时速率（字节/秒） |
| `verifying` | `version`, `next` | 下载结束后、正在执行 SHA-512、ZIP 结构检查、`ditto` 解压与 `codesign` 校验 |
| `ready` | `version`, `next`, `notes`, `newFarm`, `page` | 校验通过并已暂存新 `.app`，等待用户重启或下次退出时替换 |
| `installing` | `version`, `next` | `swap(true)` 已启动，正在复制 `.app` 至应用旁并拉起 `swap.sh` 准备退出重启 |
| `manual` | `version`, `next`, `why`, `page` | 环境不支持自动替换（`diskImage`、`translocated`、`readOnly`、`noBuild`），引导前往发布页手动下载 |
| `failed` | `version`, `why`, `kind?`, `page?` | 检查、下载、校验或替换失败；`kind` 为 `UpdateFailureKind`，`page` 存在时提供手动下载回退 |

`UpdateFailureKind` 封闭集合定义如下，Rust 侧 `FailureKind` 与之一一对应：

| `kind` | 涵盖来源 |
|---|---|
| `network` | DNS、TLS、连接超时、断流、非 403/429 的 HTTP 请求失败 |
| `rateLimit` | HTTP `403`（GitHub API 限流）与 `429 Too Many Requests` |
| `integrity` | 文件大小不符、SHA-512 校验失败、ZIP 损坏、符号链接或越界路径 |
| `signature` | `codesign --verify` 失败、`CFBundleIdentifier` 不匹配、团队签名不一致 |
| `permission` | 目标目录或 `.app` 不可写、无权限写入暂存目录 |
| `install` | `ditto` 复制失败、`swap.sh` 写出或启动失败、上次退出替换记录 `swap-failed.txt` |
| `unknown` | 其余未归类错误（保留原始 `why` 便于诊断） |

新增元数据字段（`checkedAt`、`downloadedBytes`、`totalBytes`、`speedBps`、`kind`、`page`）在 Zod 解码器中以 `z.exactOptional(...)` 声明，JSON 序列化在字段缺失时省略对应键且不输出 `null`；既有测试夹具不必大面积改写，Rust 宿主在对应分支按需完整写出。

### 3. 可续传下载、自动重试、ETag 缓存与缓存清理

- **`.part` 断点续传**：`apps/mac/src/update/fetch.rs` 将安装包写入 `$VIBEVALLEY_HOME/updates/<version>/update.zip.part`，进入 `staged_app` 时不再无条件删除同版本目录。当 `.part` 已存在且 `0 < len < build.size` 时，HTTP 请求附带 `Range: bytes=<len>-`：
  - 服务端返回 `206 Partial Content` 且 `Content-Range` 起始字节等于 `len` 时，以追加模式续写。
  - 服务端忽略 `Range` 返回 `200 OK` 时，截断 `.part` 从 0 重写。
  - 服务端返回 `416 Range Not Satisfiable` 或累计写入超过 `build.size` 时，删除 `.part` 后从 0 重新下载。
  - 完整下载后重命名为 `update.zip` 并立刻切入 `verifying` 态；仅在哈希或归档校验失败时删除损坏的压缩包。
- **`backon` 指数退避重试**：下载阶段遇到网络断流、`408`/`429`/`5xx` 或流式读取错误时，使用 `backon` 指数退避最多重试 3 次，每次重试自动基于当前 `.part` 长度续传。
- **字节数与速率遥测**：进度回调产出 `DownloadProgress { percent, downloaded_bytes, total_bytes, speed_bps }`，按约 `200 ms` 或百分比变化节流发送，并确保发出初始 `0%` 与终帧 `100%`。
- **ETag 条件请求缓存**：在 `Updater` / `fetch` 内存中维护 `URL -> (etag, body)` 缓存；拉取 `release.json` 或 GitHub Releases 列表时附带 `If-None-Match`，命中 `304 Not Modified` 时直接复用缓存体，避免 30 分钟轮询耗尽 GitHub API 限额。
- **旧缓存回收**：新版本暂存进入 `ready` 后，清理 `$VIBEVALLEY_HOME/updates/` 下除当前暂存版本与 `swap.log` 外的旧版本目录；若宿主 `.app` 父目录存在过期的 `.VibeValley-update-*` 或 `.VibeValley-previous-*` 残留目录且非当前进程创建，安全移除以释放磁盘空间。

### 4. 可观测的 `swap.sh` 与下次启动恢复

- **落盘日志与失败标记**：`SWAP_SCRIPT` 不再把错误重定向到 `/dev/null`，而是将标准错误写入 `$VIBEVALLEY_HOME/updates/swap.log`；若任一前置检查或 `mv` 失败（含触发回滚后），将目标版本号与失败原因写入 `$VIBEVALLEY_HOME/updates/swap-failed.txt`。
- **重启中状态反馈**：`swap(true)` 启动前先切换并推送 `State::Installing { next }`，使界面在 `/usr/bin/ditto` 复制 `.app` 期间立即呈现「安装中」禁用态；若复制或拉起 `swap.sh` 失败，恢复暂存句柄或进入 `State::Failed { kind: FailureKind::Install, ... }` 并向调用方返回明确拒绝原因。
- **下次启动恢复提示**：`Updater::from_env()` 初始化时读取 `$VIBEVALLEY_HOME/updates/swap-failed.txt`：
  - 若当前运行版本已等于记录的目标版本，说明后续已升级成功，静默删除标记文件。
  - 若当前版本仍不等于目标版本，删除标记文件并将初始状态置为 `State::Failed { kind: FailureKind::Install, why, page }`，用户打开「设置 → 关于」即可看见上次替换失败的原因，并可直接重试或手动下载。
- **普通退出保持静默替换**：`cx.on_app_quit` 仍调用 `updater.swap(false)`，不阻塞退出流程，并保持与 [update-check.ts](scripts/release/update-check.ts) 的 `wait_update` + `quit` 流程兼容。

### 5. 克制透明的工作台交互与双语文案

所有颜色、圆角、字号与动效均使用 `apps/mac/ui/design/theme.json` 与 `apps/mac/ui/nsh.json` 的语义令牌及 `apps/mac/ui/design/motion.ts`（符合 [01-philosophy-and-tokens.md](docs/design/01-philosophy-and-tokens.md)），对用户展示的文案统一写入 `crates/i18n/locales/{zh,en}/web.{base,setting}.json` 并经 `vp run i18n:gen` 生成：

- **左侧导航栏（[Shell.tsx](apps/mac/ui/app/Shell.tsx)）**：
  - `downloading`：展示紧凑进度组件（细进度条 `bg-accent` / `bg-hover` + `tabular-nums` 百分比），悬停气泡显示版本号与格式化的 `已下载 / 总大小 · 速率`（例如 `42.1 / 86.4 MB · 3.2 MB/s`）。
  - `verifying`：展示 `校验中` / `Verifying` 与 `wait` 图标。
  - `installing`：展示 `安装中` / `Installing` 禁用态。
  - `ready`：点击 `rail-update-btn` 始终打开克制的更新预览弹窗，不再静默退出。弹窗展示标题 `新版本 v{next} 已就绪`、`v{version} → v{next}` 等宽版本徽章、活跃执行会话数或 `newFarm` 提醒（存在时）、`notes` 变更列表与可选发布页外链，底部提供「下次退出时更新」（关闭弹窗，退出时由 `on_app_quit` 完成替换）与主按钮「立即重启更新」。
- **设置 → 关于（[UpdateRow.tsx](apps/mac/ui/features/setting/UpdateRow.tsx)）**：
  - 穷尽渲染 9 种 `UpdateState`：`disabled` 显示柔和提示「开发构建未启用自动更新」且隐藏检查按钮；`idle` 显示「已是最新版本」、可选「上次检查」相对时间（`checkedAt`）与「检查更新」按钮；`checking` 显示「正在检查更新…」；`downloading` 展示细进度条、百分比、已下载/总大小与速率；`verifying` 展示「正在校验并准备 {next}…」；`ready` 展示就绪状态、更新内容预览、发布页链接与「立即重启更新」按钮；`installing` 展示「正在安装 {next} 并重启…」禁用态；`manual` 展示本地化安装指引与「前往下载」外链；`failed` 按 `kind` 映射本地化说明与建议动作（保留原始 `why` 作为次要详情或提示），并提供「重试」按钮与可选「手动下载」外链。
  - 手动检查结束后的提示逻辑：仅当状态确认为 `idle` 时提示「已是最新版本」，`disabled` 或仍处于 `checking` / `downloading` / `verifying` 时不误弹 toast。

## Alternatives considered

**接入 macOS Sparkle 框架**：Sparkle 提供成熟的原生更新弹窗、Appcast 解析与 XPC 特权替换。未选：接入 Sparkle 需引入 Objective-C / Swift FFI、XPC Helper 签名与独立的 Appcast XML 发布链路，与当前纯 Rust 多通道架构（`release.json`、本地 `file://` Alpha 调试流、统一 `HostOp` 桥接与 `nsh` 令牌体系）割裂；当前自研管线只需补齐续传、推流、状态机与日志恢复即可覆盖全部真实痛点，维护面更小。

**检测到新版本时强制弹出全屏或阻塞式模态框**：一旦进入 `ready` 态立刻打断当前界面提示重启。未选：VibeValley 是编码执行会话工作台，用户常在阅读改动或等待执行会话收尾，强制弹窗会打断心流；保留左侧导航栏克制的就绪入口，由用户主动点击后再展示完整的更新内容预览弹窗，兼顾透明与不打扰。

**继续保留纯前端轮询（缩短轮询间隔）**：将 `update.watch` 的轮询周期从 `10 秒 / 1 秒` 缩短到 `500 ms` 以掩盖状态延迟。未选：高频轮询在空闲期无谓消耗桥调用与 QuickJS 调度，依然无法保证点击「检查更新」或进入 `verifying` / `installing` 的瞬时同步；宿主 `HostedView` 已具备 `host.send(event, json)` 推送通道，直接推送 `update_state` 零轮询开销且状态切换无滞后。

## Acceptance criteria

- **契约与解码（`packages/protocol`）**：`packages/protocol/src/host.test.ts` 覆盖全部 9 种 `UpdateState` 分支与 7 种 `UpdateFailureKind` 值的 Zod 编解码往返及非法输入拒绝；`vp run packages:check` 与 `vp run deadcode` 通过（零未使用导出）。
- **Rust 更新引擎与单测（`apps/mac/src/update/`）**：
  - `206 Partial Content` 续传测试：模拟流中途断开后保留 `.part`，重试携带 `Range: bytes=<len>-` 并拼接出完整文件。
  - `200 OK` 回退与 `416` 重置测试：服务端忽略 `Range` 或返回 `416` 时安全回退至从 0 下载。
  - `304 Not Modified` ETag 缓存测试：二次拉取携带 `If-None-Match` 并复用缓存清单体。
  - 非阻塞检查测试：`UpdateOp::Check` 在慢响应或下载进行中立即返回，不阻塞调用方。
  - 状态机与错误分类测试：验证 `Feed::Off` 启动为 `disabled`、`idle` 写入 `checkedAt`、下载完成后经 `verifying` 进入 `ready`、`swap(true)` 进入 `installing`、7 类 `FailureKind` 分类准确。
  - 缓存清理与替换恢复测试：暂存新版本后清除过时版本目录；存在 `swap-failed.txt` 且版本未变时启动进入 `failed(kind = "install")` 并删除标记，版本已变时静默删除标记。
  - `cargo fmt --all --check`、`cargo xtask audit`、`cargo clippy -p vibevalley-mac --all-targets -- -D warnings`、`cargo clippy -p vibevalley-mac --all-targets --features shot -- -D warnings` 与 `cargo test -p vibevalley-mac` 全部通过。
- **工作台交互与词典（`apps/mac/ui`、`crates/i18n`）**：
  - 新增 `apps/mac/ui/features/setting/UpdateRow.test.tsx`，覆盖全部 9 种状态、`checkedAt`、MB 与速率展示、更新说明预览及失败重试与手动下载回退。
  - 更新 `apps/mac/ui/app/interactions.test.tsx`，验证点击 `rail-update-btn` 始终先展示更新预览弹窗（含版本号、更新内容、「下次退出时更新」与「立即重启更新」）。
  - `vp run i18n:gen`、`vpx scripts/gen/i18n.ts check`、`vpx scripts/audit/ui-tokens.ts` 与 `vp run mac:check` 零报错。
- **端到端更新脚本兼容**：保留 `eprintln!("update: ...")` 逐行 JSON 输出、`wait_update` 就绪判定与 `on_app_quit` 自动替换语义，确保 [update-check.ts](scripts/release/update-check.ts) 升级回归链路不退化。
- **文档门禁**：`vp run notes:catalog` 与 `vp run docs:verify` 通过。

## Risks

- **服务端或 CDN 对 `Range` 请求的兼容性差异**：部分代理或静态文件托管在重定向后返回 `200 OK` 或缺失 `Content-Range`。缓解：仅当响应码为 `206` 且 `Content-Range` 起始字节与本地 `.part` 长度精确匹配时追加写入；遇到 `200` 截断重下、遇到 `416` 删除 `.part` 重试，且最终始终以 `build.size` + SHA-512 兜底校验，不会接受拼错的压缩包。
- **`swap.sh` 脱离父进程后写日志与标记的竞态**：若用户极短时间内连续退出重开，可能在前一次 `swap.sh` 尚未结束时读取 `swap-failed.txt`。缓解：`swap.sh` 先写临时文件再 `mv` 原子落盘 `swap-failed.txt`，且仅在 `mv` 替换失败回滚后写出；启动时比较记录的目标版本与当前运行版本，已成功升级时静默清除，避免误报。
- **高频下载进度推送导致 UI 重绘放大**：高速网络下每个 TCP chunk 推送一次 `update_state` 会压高桥接序列化开销。缓解：在 Rust 侧按约 `200 ms` 或整数百分比变化节流进度回调，并仅在序列化状态变化时广播；若后续仍需进一步降频，可调大节流窗口而不改动协议。
- **既有外部脚本与测试对 `UpdateState` 旧形态的依赖**：[update-check.ts](scripts/release/update-check.ts) 依赖 stderr 中的 `"_tag":"ready"`，UI 测试夹具构造最小 `UpdateState` 字面量。缓解：保留既有 `_tag` 名称（`idle`、`checking`、`downloading`、`ready`、`manual`、`failed`）及 `eprintln!("update: ...")` 格式，所有新增遥测与分类字段在 Zod 中设为可选，确保渐进兼容且不破坏发布回归脚本。
