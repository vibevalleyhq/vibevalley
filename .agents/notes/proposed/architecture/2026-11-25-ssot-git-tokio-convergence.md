# Agent Note: 跨端 SSOT、纯 Rust git 与全仓 Tokio 收敛

Status: proposed

## Problem

架构重构落地到 `9e47cb401` 后，全仓仍存在两类系统性结构债务：跨端单源事实（SSOT）接缝漂移，以及基础设施绕行与异步运行时碎片化。

### 1. 跨端 SSOT 接缝

| 编号 | 漂移面 | 现状证据（基于 `9e47cb401`） | 结构后果 |
|---|---|---|---|
| **S1** | 12 类 `ArtifactType` 元数据与词典 | 后端单源在 [manifest.rs](crates/core/src/artifact/manifest.rs#L58-L167)（`ALL_SPECS: [ArtifactTypeSpec; 12]`）；前端在 [html.ts](apps/mac/ui/features/artifact/html.ts#L9-L23) 另写 `ARTIFACT_TYPE_META` 并在 [html.ts](apps/mac/ui/features/artifact/html.ts#L38-L63) 另写 `inferArtifactFromName`；[ArtifactCard.tsx](apps/mac/ui/features/artifact/ArtifactCard.tsx#L50-L57) 对 `sheet`、`prototype`、`diagram`、`storyboard` 硬编码英文标签，对应 [zh/web.artifact.json](crates/i18n/locales/zh/web.artifact.json#L40-L52) 与 [en/web.artifact.json](crates/i18n/locales/en/web.artifact.json#L40-L52) 均缺失这 4 键；共 6 个前端文件独立枚举 12 类作品（`html.ts`、`ArtifactCard.tsx`、[ArtifactDirectoryView.tsx](apps/mac/ui/features/artifact/ArtifactDirectoryView.tsx)、[ContentSidebar.tsx](apps/mac/ui/features/content/ContentSidebar.tsx)、[templates.ts](apps/mac/ui/features/content/templates.ts)、[TemplateModal.tsx](apps/mac/ui/features/content/TemplateModal.tsx)） | 增删或调整作品类型时易漏改某一端；中文界面对新增 4 类作品展示英文退化名 |
| **S2** | HTTP Byte-Range 流响应、ID 校验与兜底 | [mod.rs](crates/server/src/gateway/http/mod.rs#L511-L574)（`attachment`）与 [media.rs](crates/server/src/gateway/http/media.rs#L73-L118)（`media::content`）各自拼接 Range 响应：`media::content` 输出 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、RFC 5987 `filename*=UTF-8''...`，且 0 字节文件返回 `416`；`attachment` 缺少这 3 项安全头与 `filename*` 编码，且 0 字节无 `Range` 时返回 `200`；[mod.rs](crates/server/src/gateway/http/mod.rs#L481-L483) 的 `is_artifact_id` 实际校验 36 字符带连字符 UUID（专供 `media_input`），与 `art_<32hex>` 命名冲突；[mod.rs](crates/server/src/gateway/http/mod.rs#L407-L428) `slice` 仍保留 `spawn_blocking_traced` 兜底路径 | 附件直连缺失沙箱与 MIME 嗅探防护，同源浏览器预览路径存在 XSS 风险；误用 `is_artifact_id` 会拒绝合法作品 ID |
| **S3** | 桌面连接配置、远程/桥接信封与兜底枚举 | [connection.rs](apps/mac/src/hosted/connection.rs#L154-L183) 定义 `DesktopConnectionSnapshot` 与 `ConnectionSaveRequest` 绕过 `crates/protocol`，在 [bridge.ts](apps/mac/ui/infra/bridge.ts#L246-L264)（`DesktopConnectionSnapshot`、`DesktopConnectionSaveInput`）与 [RemoteAccessPage.tsx](apps/mac/ui/features/setting/RemoteAccessPage.tsx#L26-L39)（`DesktopConnectionSnapshotSchema`）三处手写；`Envelope` 与 `sliceDecoders` 在 [transport.ts](packages/protocol/src/remote/transport.ts#L75-L110) 与 `apps/mac/ui/infra/{transport,bridged,bridge}.ts` 重复，且 [bridge.ts](apps/mac/ui/infra/bridge.ts#L77-L80) 跳过 Zod 校验直接使用 `as` 断言；[IssuesTab.tsx](apps/mobile/src/features/IssuesTab.tsx#L107-L111) 在 `issue.moves` 为空时硬编码 4 种状态兜底；[chatSession.ts](apps/mac/ui/workspace/chatSession.ts#L102-L106) 硬编码 `FALLBACK_RUNTIMES` 与 [chatSession.ts](apps/mac/ui/workspace/chatSession.ts#L172-L183) 手写 `runtimeDisplayName` | 字段改名或状态机收敛时跨端静默失步；移动端可绕过服务端下发的状态迁移表发起无效状态变更 |
| **S5** | 服务端函数体内 `serde_json::Value` 残留 | 除入口/边界与测试替身外，`crates/server/src` 非测试、非 `fake/` 函数体内部仍存 `34` 处 `from_value`、`15` 处 `to_value`、`323` 次 `Value` 引用（含 `fake/` 共 `337` 次），典型如 [channel/types.rs](crates/server/src/channel/types.rs#L81-L97)、[channel/types.rs](crates/server/src/channel/types.rs#L133-L147)、[issue/chat.rs](crates/server/src/issue/chat.rs#L509-L525) 与 [execution.rs](crates/server/src/agent/orchestrator/execution.rs#L41-L53) | 运行时枚举与载荷字段反序列化错误延迟到业务内部，绕开进门强类型解码边界 |
| **S6** | 产品裁决边界：`Orchestrator` 引擎锁定 | [profile.rs](crates/server/src/agent/profile/profile.rs#L177-L179) 与 [orchestrator/mod.rs](crates/server/src/agent/orchestrator/mod.rs#L616-L633) 将主助手（`Orchestrator`）显式锁定为 `ORCHESTRATOR_RUNTIME = "vibevalley"` 与 DeepSeek 模型族 | 此项为产品策略裁决而非结构漂移；本批保持服务端策略不变，仅清理 `chatSession.ts` 手写展示名映射与 `FALLBACK_RUNTIMES` |

### 2. 基础设施绕行与重复面（S8）

1. **9 处生产路径绕开 `crates/git` 直接调用 `Command::new("git")`**（另 `crates/server/src/fake/runtime.rs` 含 2 处测试替身用法）：
   - `crates/server`（6 处）：`crates/server/src/runtime/worktree/git.rs`（第 12 行，已删）、[worktree/mod.rs](crates/server/src/runtime/worktree/mod.rs#L167)、[issue/pull/mod.rs](crates/server/src/issue/pull/mod.rs#L271)、[issue/pull/publish.rs](crates/server/src/issue/pull/publish.rs#L122)、[repo.rs](crates/server/src/repo.rs#L932)、[agent/tool/issue.rs](crates/server/src/agent/tool/issue.rs#L565)。
   - `crates/cli`（1 处 4 调用点）：[machine_agent/worktree.rs](crates/cli/src/machine_agent/worktree.rs#L38)（及同文件第 `288`、`314`、`326` 行）。
   - `crates/runtime`（2 个子系统 6 调用点）：[engine.rs](crates/runtime/src/agent/core/engine.rs#L1539)、[grader.rs](crates/runtime/src/agent/eval/grader.rs#L367)（及同文件第 `376` 行）、[suite.rs](crates/runtime/src/agent/eval/suite.rs#L325)（及同文件第 `340`、`384` 行）。

   上述绕行同时失去 [cmd.rs](crates/git/src/cmd.rs#L12-L21) 与 [cmd.rs](crates/git/src/cmd.rs#L110-L121) 提供的 5 项保护：
   - 剥离 8 个会劫持仓库定位的环境变量（`REPO_OVERRIDES`：`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_COMMON_DIR`、`GIT_NAMESPACE`、`GIT_PREFIX`）；
   - 固定非交互与机读参数（`--no-pager -c core.quotepath=off -c color.ui=never` 与 `LC_ALL=C`）；
   - 禁用凭据弹窗防卡死（`GIT_TERMINAL_PROMPT=0`）；
   - 只读命令设置 `GIT_OPTIONAL_LOCKS=0`，避免与用户终端或并发会话争抢 `index.lock`；
   - 统一 `GitError` 分类报错（`GitNotFound` / `NotARepo` / `Command` / `Parse` / `Io`）。

2. **`.vibevalley/check` 双实现**：[worktree/check.rs](crates/server/src/runtime/worktree/check.rs#L11-L40) 使用 `std::process::Command` 同步执行（无超时且未补充 `node_modules/.bin` PATH），而 [publish.rs](crates/server/src/issue/pull/publish.rs#L418-L440) 使用 `tokio::process::Command` + `run_output_with_timeout` 异步执行。
3. **本机设备名探查重复**：`scutil --get ComputerName` / `hostname -s` 在 [remote/mod.rs](crates/server/src/gateway/remote/mod.rs#L125-L148)、[cli/src/auth.rs](crates/cli/src/auth.rs#L237-L252) 与 [connection.rs](apps/mac/src/hosted/connection.rs#L382-L396) 各写一份，尚未收敛进 [home.rs](crates/protocol/src/home.rs)。

## Proposal

围绕「跨端 SSOT 收口、纯 Rust `.git` 只读 + Tokio 异步 `crates/git`、全仓 Tokio 收敛与永久静态守卫」分 5 个互不冲突波次实施，完成后由 Stage 3 统一集成验收。

### 1. 跨端 SSOT 与 HTTP 响应收敛

- **S1 12 类 `ArtifactType` 单源生成与词典补齐**：
  - 将 `crates/core/src/artifact/manifest.rs` 中的 `ArtifactTypeSpec` 常量元数据上移或镜像映射至 `crates/protocol/src/artifact/`（作为线缆常量单源），由 `vp run protocol:ts` 自动生成 `ARTIFACT_TYPES` 与 `ARTIFACT_TYPE_SPECS`（含 `slug`、`entryPath`、`entryMime`、`defaultDirs`、`exportSuffix`、`supportsDesignSystem`）至 `packages/protocol/src/artifact/shapes.gen.ts`。
  - 删除 `apps/mac/ui/features/artifact/html.ts` 手写的 `ARTIFACT_TYPE_META`，改为消费 `@vibevalley/protocol` 导出的 `ARTIFACT_TYPE_SPECS`；`ArtifactCard.tsx`、`ContentSidebar.tsx`、`templates.ts`、`TemplateModal.tsx` 与 `ArtifactDirectoryView.tsx` 统一由 `ArtifactTypeValues` / `ARTIFACT_TYPE_SPECS` 驱动穷尽映射，不再各自维护类型清单。
  - 在 `crates/i18n/locales/{zh,en}/web.artifact.json` 的 `types` 下补齐 `sheet`、`prototype`、`diagram`、`storyboard` 4 键，删除 `ArtifactCard.tsx:50-57` 硬编码英文分支，并重跑 `vp run i18n:gen`。
- **S2 HTTP Byte-Range 统一助手、ID 校验修正与 `slice` 异步收口**：
  - 在 `crates/server/src/gateway/http/mod.rs` 提取统一的 `serve_file_range` 响应构建函数供 `attachment` 与 `media::content` 共用：强制输出 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、RFC 5987 `Content-Disposition: inline; filename*=UTF-8''...` 与 `Accept-Ranges: bytes`；统一 0 字节文件在无 `Range` 与有 `Range` 时的状态码契约（保留 `media::content` 严格安全基线，或通过显式 `EmptyPolicy` 枚举参数化 0 字节行为并覆盖单测）。
  - 将 `mod.rs:481` 的 `is_artifact_id` 更名为 `is_media_input_uuid`（明确校验 36 字符 UUID），若路由需要校验 `art_<32hex>` 则单独提供 `is_artifact_id` 校验函数。
  - 清理 `mod.rs:407-428` `http::slice` 的 `spawn_blocking_traced` 兜底路径：统一由 `SliceFeed` 订阅提供异步流，测试替身直接实现异步 `watch_slice` / `subscribe_slice` 接口。
- **S3 桌面连接契约、远程/桥接解码与移动端/工作区兜底清理**：
  - 将 `DesktopConnectionSnapshot`、`ConnectionSaveRequest`（含模式与来源枚举）迁入 `crates/protocol/src/host.rs`（或新建 `crates/protocol/src/connection.rs`），通过 `protocol:ts` 生成 TS 类型，并在 `packages/protocol/src/schema.ts` 导出 Zod Codec；删除 `apps/mac/ui/infra/bridge.ts` 与 `apps/mac/ui/features/setting/RemoteAccessPage.tsx` 中的重复类型与 Zod 副本。
  - 将 `EnvelopeSchema` 与 `sliceDecoders` 收口至 `@vibevalley/protocol/schema`（或 `@vibevalley/protocol/remote` 统一导出），`apps/mac/ui/infra/{transport,bridged,bridge}.ts` 共用同一份校验器，移除 `bridge.ts:77-80` 跳过 Zod 校验的 `as` 断言。
  - 清理 `apps/mobile/src/features/IssuesTab.tsx:107-111` 越权状态兜底：当 `issue.moves` 为空时不展示快捷迁移按钮。
  - 清理 `apps/mac/ui/workspace/chatSession.ts` 的 `FALLBACK_RUNTIMES` 与手写 `runtimeDisplayName`，统一使用服务端 `runtime.list` 返回的 `rt.preset.label`（列表未就绪时展示空列表/加载态，不伪造本地引擎）。
- **S5 服务端函数体内 `Value` 收敛**：
  - 为 `channel/types.rs`、`issue/chat.rs`、`agent/orchestrator/execution.rs` 等 34 处 `from_value` 与 15 处 `to_value` 补全强类型结构体和 `enum`（例如 `ChannelType` / `MessageKind` / `Notify` 实现 `FromStr` / `serde` 强类型映射，持久化载荷使用具名 `struct` 直接反序列化）。
- **S8 共用基础设施收口**：
  - 删除 `crates/server/src/runtime/worktree/check.rs` 的同步实现，将 `.vibevalley/check` 统一收口到异步共享函数（基于 `tokio::process::Command` + 超时控制 + `node_modules/.bin` PATH 前置）。
  - 在 `crates/protocol/src/home.rs` 新增统一的本机设备名解析函数（带进程级缓存），供 `crates/server/src/gateway/remote/mod.rs`、`crates/cli/src/auth.rs` 与 `apps/mac/src/hosted/connection.rs` 共用。

### 2. `crates/git` 升级方案（纯 Rust 只读无子进程 + 原生 Tokio 异步写/复杂操作）

#### 方案比选

| 维度 | 方案 A（采纳）：`crates/git/src/read.rs` 纯 Rust 只读 + `tokio::process::Command` | 方案 B（放弃）：引入 `gix`（gitoxide） |
|---|---|---|
| 依赖体积与编译时间 | 零新增第三方 crate，冷编译与二进制体积零膨胀 | 引入数十个传递 crate，明显拉长全量与增量编译 |
| 高频热路径性能 | 只读路径直接内存解析 `.git/HEAD`、`refs/heads/*`、`packed-refs`、`.git/config` 与 `worktrees/`，零 `fork/exec` 开销 | 同样零子进程，但为少数只读查询引入整套 packfile/index 状态机 |
| 语义一致性（写与复杂 diff） | 写操作、`status`、`diff`、hooks 与签名仍走系统 `git` 二进制，100% 匹配用户终端 git config、SSH 代理与 GPG 签名 | 需反复对齐 `gix` 与用户本地 `git` 在 hooks、filter、签名与 worktree 锁上的细微差异 |
| 复杂 revspec 兜底 | `commit_id_fast` 对复杂表达式（如 `HEAD~1`、`main^{tree}`）自动回退安全 `tokio::process::Command` 子进程 | 需在 Rust 内完整维护 git revspec 解析语法 |

#### `crates/git/src/read.rs` 纯 Rust 无子进程接口清单

在 `crates/git` 新增 `read.rs`（全部纯 Rust 文件读取与解析，不启动子进程）：

| 接口 | 读取来源与解析规则 | 复杂边界与回退 |
|---|---|---|
| `discover_root(path)` | 沿父目录向上扫描 `.git` 目录（普通仓库）或 `.git` 文件（`gitdir: <path>` worktree，经 `<gitdir>/commondir` 溯源工作区根） | 遇裸仓库或无工作区目录返回 `Ok(None)` |
| `git_dir(root)` | 解析 `<root>/.git`：目录直接返回，文件解析 `gitdir:` 行并规范化相对/绝对路径 | 非仓库返回 `GitError::NotARepo` |
| `git_common_dir(root)` | 基于 `git_dir(root)` 读取 `commondir` 文件；不存在则 `git_common_dir == git_dir` | 与 `git rev-parse --git-common-dir` 保持一致 |
| `git_path(root, rel)` | 依据 `git_common_dir` 与 `git_dir` 规则拼接仓库内部路径（`index`、`HEAD` 等走 `git_dir`；`refs`、`objects`、`worktrees` 走 `git_common_dir`） | 不触碰文件系统索引锁 |
| `head(root)` | 读取 `<git_dir>/HEAD`：`ref: refs/heads/<branch>`（附加符号引用解析）或分离 HEAD 40 位十六进制 SHA | 未提交的 unborn 分支返回 `Ok(None)` |
| `branch_exists(root, branch)` | 先查 `<common>/refs/heads/<branch>` 文件是否存在；未命中再扫描 `<common>/packed-refs` | 过滤 `#` 注释与 `^` peel 行 |
| `branches(root)` | 遍历 `<common>/refs/heads/**` loose 分支并与 `<common>/packed-refs` 中 `refs/heads/` 条目合并去重排序 | loose 引用覆盖同名 packed 引用 |
| `commit_id_fast(root, rev)` | 快路径纯 Rust 解析：40-hex SHA（直接校验存在或返回）、`HEAD`、`refs/...`、短分支名；不启动子进程 | 命中 `~`、`^`、`:`、`@{}` 等复杂 revspec 时标记回退，由 `Repo::commit_id_async` 调用安全 `git rev-parse` 子进程 |
| `remote_url(root, name)` | 解析 `<common>/config` INI 段 `[remote "<name>"]` 下的 `url = ...`（支持引号与转义空白） | 未配置返回 `Ok(None)` |
| `global_config_value(section, key)` | 按 git 优先级读取 `$GIT_CONFIG_GLOBAL`、`$XDG_CONFIG_HOME/git/config`、`~/.gitconfig` | 仅做只读配置查询（如 `user.email`） |
| `worktrees(root)` | 扫描 `<common>/worktrees/*/{gitdir,HEAD}`，还原各 linked worktree 的磁盘路径、关联分支与 HEAD SHA | 跳过已被清理但未 prune 的失效目录提示 |

- **Parity 单测策略**：在 `crates/git/tests`（或 `src/read.rs` 单测模块）对临时仓库（覆盖普通仓库、unborn HEAD、detached HEAD、packed-refs、`git worktree add`、`core.bare` 与多 remote 配置）逐项将 `read::*` 输出与真实 `git` CLI（`rev-parse`、`show-ref`、`for-each-ref`、`remote get-url`、`worktree list --porcelain`、`config --global`）断言字节级一致。

#### `crates/git/src/cmd.rs` 与 `repo.rs` Tokio 异步化

- [cmd.rs](crates/git/src/cmd.rs#L104-L150) 切换为 `tokio::process::Command` 并默认开启 `.kill_on_drop(true)`，保留全部 5 项环境安全保护（`REPO_OVERRIDES` 剥离、`--no-pager -c core.quotepath=off -c color.ui=never`、`LC_ALL=C`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`）。
- 彻底删除 `cmd.rs:144` 用于向子进程写 `stdin` 的 `std::thread::spawn`，改为异步写入 `AsyncWriteExt::write_all` + `drop(stdin)` 与 `child.wait_with_output().await` 并发 `tokio::join!`（防大 patch 写阻塞与 stdout 管道死锁）。
- 在 [repo.rs](crates/git/src/repo.rs) 提供全套原生异步方法 `*_async`（`discover_async`、`init_async`、`clone_async`、`status_async`、`diff_async`、`stage_async`、`unstage_async`、`commit_async`、`worktree_*_async` 等）以及 `crates/git/src/verified_merge.rs` 异步合并链路；同步 `Repo` 方法仅在迁移过渡期服务同步测试或完全下线（目标 `crates/server`、`crates/cli` 与 `crates/runtime` 零同步 `Command::new("git")`）。

### 3. 全仓 17 个 Rust Crate Tokio 收敛矩阵与合理豁免边界

下表覆盖根目录 [Cargo.toml](Cargo.toml#L3-L21) 声明的全部 17 个工作区 crate（数字来自对 `9e47cb401` 非测试代码的静态扫描）：

| Crate | 现状（非测试 `raw_git` / `std_cmd` / `reqwest::blocking` / `block_on` / `os_thread`） | 收敛目标 | 合理豁免与边界说明 |
|---|---|---|---|
| `crates/protocol` | `std_cmd: 1`（[home.rs](crates/protocol/src/home.rs#L199) `kill -0`） | 保持纯同步基础契约 crate；`home.rs` 统一封装本机设备名解析（`gethostname`/环境变量优先，`scutil` 回退） | 不引入 `tokio` 运行时依赖；短时进程探活豁免 |
| `crates/i18n` | `0 / 0 / 0 / 0 / 0` | 保持纯同步零阻塞 | 无 |
| `crates/core` | `0 / 0 / 0 / 0 / 0` | 保持纯状态机与纯投影内核 | `clock.rs` 仅单测含 `thread::spawn` |
| `crates/git` | `raw_git: 1`、`std_cmd: 1`、`os_thread: 1`（`cmd.rs:105,144`） | 只读接口收口到 `read.rs` 纯 Rust；子进程迁移至 `tokio::process::Command` + 异步 stdin，`os_thread` 清零 | `tests/` 造测试夹具可用标准命令，生产代码零 `std::process::Command` 与 `thread::spawn` |
| `crates/files` | `os_thread: 1`（`watch.rs:254`） | 保持现有同步文件遍历与监听接口 | **豁免**：CPU 密集型目录遍历与 `notify` 系统 FSEvents 监听线程 |
| `crates/runtime` | `raw_git: 6`、`std_cmd: 20`（含 `vv_test_fixture` 夹具）、`reqwest_blk: 1`（`oar/scripted.rs:397`）、`block_on: 2`（`rt.rs:100,104`）、`os_thread: 3`（`vv_test_fixture.rs`） | `engine.rs:1539`、`eval/grader.rs:367,376`、`eval/suite.rs:325,340,384` 的 6 处 `raw_git` 全部迁至 `crates/git`；清理 `oar/scripted.rs:397` 阻塞 HTTP | **豁免**：`rt.rs` 唯一 `block_on` 边界定义、`bin/vv_test_fixture.rs` 测试二进制、`#[cfg(loom)]` 模型与 `bash.rs`/`oar/process.rs` 执行器子进程 |
| `crates/server` | `raw_git: 8`（含 `fake/runtime.rs` 2 处）、`std_cmd: 15`、`block_on: 5`（`app.rs:123,384`、`main.rs:63`、`router.rs:322,333`） | 6 处生产 `raw_git` 与 9 处生产 `std_cmd`（`worktree/{git,check,mod}.rs`、`issue/pull/{mod,publish}.rs`、`repo.rs:932`、`gateway/remote/mod.rs:136`、`agent/tool/issue.rs:565`）全部迁至 `crates/git` 或 `tokio::process::Command`；`SERVER_BLOCK_ON_CEILING` 维持根入口最小上界 | **豁免**：`fake/` 测试替身（如 `fake/runtime.rs`）与根入口同步关闭桥接（已受 `ratchets.rs` 棘轮约束） |
| `crates/cli` | `raw_git: 4`（`machine_agent/worktree.rs`）、`std_cmd: 5`、`reqwest_blk: 4`（`client.rs:99,101,216,237`）、`block_on: 3`、`os_thread: 1`（`client.rs:482`） | `client.rs` 全面迁至异步 `reqwest::Client` 与 `tokio` SSE 流，清零 4 处 `reqwest::blocking` 与 1 处 `thread::spawn`；`machine_agent/worktree.rs` 4 处 `raw_git` 迁至 `crates/git`；全 CLI 在入口单一 `rt::block_on` 驱动异步命令，消除中途 `block_on` 嵌套（`domains/work/issue.rs:607` 等 2 处，仅保留二进制根入口） | CLI 二进制 `main` / `run` 根同步入口保留唯一 `rt::block_on` |
| `crates/rich` | `os_thread: 1`（`highlight.rs:44`） | 保持现有双模卸载架构 | **豁免**：`highlight.rs` 2 线程 `vv-rich-offload` 后台池（供非 Tokio GPUI 主线程卸载高亮与图谱排版） |
| `crates/engines/onig` | `0 / 0 / 0 / 0 / 0` | 保持纯 Rust 同步正则引擎 | 无 |
| `crates/engines/pele` | `0 / 0 / 0 / 0 / 0` | 保持纯 Rust 同步图谱引擎 | 无 |
| `crates/engines/shiki` | `0 / 0 / 0 / 0 / 0` | 保持纯 Rust 同步语法高亮引擎 | 无 |
| `apps/mac` | `std_cmd: 8`、`block_on: 7`、`os_thread: 4` | `update/fetch.rs`（`codesign`/`ditto` + 2 处 `block_on`）与 `update/mod.rs`（`ditto` + 1 处 `os_thread`）异步化；`hosted/connection.rs`（`hostname` + 1 处 `block_on`）与 `hosted/remote.rs`（3 处 `block_on`）异步化，压低 `MAC_BLOCK_ON_CEILING` 与 `MAC_OS_THREAD_CEILING` | **豁免**：`apps/mac/src/audio.rs` CoreAudio 独占音频命令线程、`build.rs` 构建脚本、`update/mod.rs` 自更新退出前 `/bin/sh` 独立进程组拉起、`island.rs` 灵动岛子进程拉起与 `hosted/late.rs` 嵌入式服务启动线程 |
| `apps/mac/crates/pixel` | `0 / 0 / 0 / 0 / 0` | 保持纯 CPU 帧渲染 | 无 |
| `apps/mac/crates/terminal` | `os_thread: 3`（`pty.rs:178`、`lib.rs:267,293`） | 保持现状不动 | **豁免**：PTY 主从设备阻塞 `read`/`write` 文件描述符与终端状态轮询线程 |
| `apps/mac/crates/workspace` | `0 / 0 / 0 / 0 / 0` | 保持纯工作区树缓存与状态管理 | 无 |
| `xtask` | `std_cmd: 4`、`block_on: 3` | 保持构建检查工具定位 | **豁免**：开发期 CLI 构建与静态审计工具（`changed.rs`、`main.rs`、`ratchets.rs`） |

### 4. 分析工具与永久守卫扩展（Red-First → Green-After 闭环）

每项收敛规则必须先将静态或运行期检查写入守卫并观察红灯（Red-First），再落地代码使守卫转绿（Green-After）：

1. **`xtask/src/arch_audit.rs` 新增 3 条硬规则**（全部默认天花板为 `0`）：
   - `no-raw-git-command`：禁止在 `crates/git/src/` 与测试/`fake/` 之外出现 `Command::new("git")`（覆盖 `std::process::Command` 与 `tokio::process::Command`）。
   - `no-sync-process-in-server`：禁止在 `crates/server/src/` 非测试、非 `fake/` 代码中使用 `std::process::Command`。
   - `no-blocking-reqwest`：禁止在工作区生产代码中使用 `reqwest::blocking`。
2. **`protocol:ts` 单源生成扩展**：
   - 将 `ARTIFACT_TYPES`、`ARTIFACT_TYPE_SPECS` 以及 `DesktopConnectionSnapshot`、`ConnectionSaveRequest` 纳入 `crates/protocol` 与 `vp run protocol:ts` 生成流，由 `vp run protocol:check` 校验生成产物同步。
3. **`scripts/gen/i18n.ts check` 中文纯英文残值守卫**：
   - 新增对 `zh` 词典条目的扫描：拒绝非白名单（允许单位/格式模板如 `{value} Hz` 经显式白名单登记，或要求格式模板补齐中文上下文/核查）的纯 ASCII 英文残值；首先捕获 [web.audio.json](crates/i18n/locales/zh/web.audio.json#L79) 的 `metadataRate`（`"{value} Hz"`）并明确白名单/规范处理策略。
   - 新增 12 类 `ArtifactType` 中英文词典全覆盖单元测试，确保 `web.artifact.types.*` 与 `ArtifactTypeValues` 长度及键集合严格一一对应、无兜底分支。
4. **HTTP Range 安全头与 0 字节回归测试**：
   - 在 `crates/server/src/gateway/http/` 测试套件补充针对 `attachment` 与 `media::content` 的统一校验：断言 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、RFC 5987 `filename*` 存在，并固定 0 字节文件在带 `Range` 与不带 `Range` 请求下的状态码与 `Content-Range` 行为。

### 5. 并行实施划分与验收标准

Stage 2 按严格互斥文件集合拆分为 5 个并行波次，所有波次基于本 Note 提交后的分支切分，严禁跨波次编辑同一文件：

| 波次 | 负责范围与核心交付 | 独占修改文件边界 |
|---|---|---|
| `w1-xtask-guards` | 先行落地 Red-First 静态守卫与审计基线（`no-raw-git-command`、`no-sync-process-in-server`、`no-blocking-reqwest`、i18n 纯英文残值检查预备） | `xtask/src/arch_audit.rs`、`xtask/src/ratchets.rs`（按需）与对应 `xtask` 单测 |
| `w2-git-pure-tokio` | `crates/git/src/read.rs` 11 个纯 Rust 只读接口与 parity 单测；`cmd.rs`/`repo.rs`/`verified_merge.rs` Tokio 异步化并去掉 `std::thread::spawn` | `crates/git/**` |
| `w3-cli-mac-tokio` | `crates/cli` 异步 `reqwest::Client` + `crates/git` 替换 + `auth.rs` 设备名收敛；`crates/runtime` 6 处 raw git 清理与 `scripted.rs` 阻塞 HTTP 清理；`apps/mac/src/{update,hosted}` 异步化与压低 `MAC_*` 天花板；`crates/protocol/src/home.rs` 本机设备名收口 | `crates/protocol/src/home.rs`、`crates/cli/**`、`crates/runtime/**`、`apps/mac/src/**` |
| `w4-ssot-proto-ui` | `crates/protocol` 导出 `ARTIFACT_TYPE_SPECS` 与 `DesktopConnectionSnapshot` / `ConnectionSaveRequest`；`crates/i18n/locales/{zh,en}/web.artifact.json` 补齐 4 键与 `scripts/gen/i18n.ts` 守卫；`packages/protocol/**`、`apps/mac/ui/**`、`apps/mobile/**` 收口 | `crates/protocol/src/{artifact,host,connection}*.rs`、`crates/core/src/artifact/manifest.rs`、`crates/i18n/**`、`packages/protocol/**`、`packages/i18n/**`、`apps/mac/ui/**`、`apps/mobile/**`、`scripts/gen/i18n.ts` |
| `w5-http-value-clean` | `crates/server` 内部 HTTP Range 安全头与 0 字节统一、`is_media_input_uuid` 更名、`http::slice` 异步收口、9 处服务端 raw git / 同步进程与 `.vibevalley/check` 异步合并、`channel/types.rs` 等 `Value` 强类型收敛 | `crates/server/**` |

### 6. Red-First → Green-After 实测收敛结果

Stage 3 整合后实测指标（基于 `cargo xtask arch-audit` 843 文件、`cargo xtask audit` 1004 文件与隔离 `vv-acceptance`）：

| 检查项 | Red-First 基线 | Green-After 结果 |
|---|---|---|
| `no-raw-git-command` | `16`（`cli` 4、`runtime` 6、`server` 6） | `0/0` |
| `no-sync-process-in-server` | `7`（`crates/server/src/`） | `0/0` |
| `no-blocking-reqwest` | `4`（`crates/cli/src/client.rs`） | `0/0` |
| `apps/mac/src` `block_on` / `os-thread` | `7` / `4` | `5/5` / `3/3`（`MAC_BLOCK_ON_CEILING=5`、`MAC_OS_THREAD_CEILING=3`） |
| 既有 `arch-audit` 11 项规则 & `ratchets` | `0`（`server block_on=5/5`） | `14` 条规则全 `0` 违规（279 边界文件、1004 棘轮文件全绿） |
| `i18n` 词典与 12 类 `ArtifactType` | 缺 4 键 + `zh` 无纯英文残值守卫 | `3564` 条目全通过、`web.artifact.types.*` 与 `ARTIFACT_TYPES` 一一对应 |
| `vv-acceptance` 隔离端到端 | — | `verify-server.ts --scripted-helper`（`code: 0, stopped: true`）通过工单合并与 `/api/v1/attachment`、`/api/v1/media/input/.../content` 的 `nosniff`/`sandbox`/RFC 5987/Byte-Range `206`；隔离 `vibevalley-mac --features shot` `/library` 浅深色双帧 12 类中文标签零英文退化 |

## Alternatives considered

**引入 `gix`（gitoxide）替代自研 `.git` 只读解析**：`gix` 会引入数十个新 crate 并拉长 CI 与本地增量编译时间，且写入、hooks 与 GPG 签名仍需兼容系统 `git` 行为。当前需求仅聚焦高频只读查询去子进程化，约数百行的 `crates/git/src/read.rs` 配合系统 `git` parity 测试足以覆盖全部热路径，复杂 revspec 回退 `tokio::process::Command`，复杂度与编译成本更低。

**只做人工规范评审而不扩展 `xtask/src/arch_audit.rs` 守卫**：既有 `ratchets.rs` 证明仅靠文档约束无法阻断后续提交重新引入 `Command::new("git")` 或 `reqwest::blocking`。将 3 条规则直接固化进 `arch-audit` 并设为 `0` 上限，才能在编译/CI 期彻底锁死回归。

**放开 `Orchestrator` 锁定 `ORCHESTRATOR_RUNTIME = "vibevalley"` 的限制**：主助手绑定 `vibevalley` / DeepSeek 属于产品策略裁决（**S6**），将其与跨端 SSOT 收敛混改会扩大测试矩阵与运行时语义范围；保持服务端锁定不动、仅清理前端 `chatSession.ts` 手写展示名映射与 `FALLBACK_RUNTIMES` 更可控。

## Acceptance criteria

Stage 3 整合合入后必须全部满足以下条件（禁止删改或跳过任何检查）：

1. **静态架构守卫全绿**：`cargo xtask arch-audit`（含新增 `no-raw-git-command = 0`、`no-sync-process-in-server = 0`、`no-blocking-reqwest = 0`）与 `cargo xtask verify` 全部通过；`MAC_BLOCK_ON_CEILING` 与 `MAC_OS_THREAD_CEILING` 随 `w3` 收敛下调至新基线。
2. **Rust 全量测试**：`cargo nextest run --workspace` 全绿（含 `crates/git` 纯 Rust 只读 vs 真实 `git` CLI parity 测试与 HTTP Range 安全头 / 0 字节回归测试）。
3. **契约、词典与前端检查**：`vp run protocol:check`、`vpx scripts/gen/i18n.ts check`（含 `zh` 非白名单纯英文检查与 12 类 `ArtifactType` 全覆盖）、`vp run mac:check`、`vp run mobile:check`、`vp run docs:verify`、`vp run deadcode` 与 `vp check` 全部退出 `0`。
4. **真机与沙箱验收**：按 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 启动隔离的 `vibevalley-server` 并跑通 `vpx scripts/release/verify-server.ts`；在真实桌面应用或隔离端到端环境打开 `/artifacts` 与附件/媒体预览路径截图核验 12 类作品中文标签与沙箱头生效，确保未触碰 `/Users/lucasay/orca/projects/vibevalley`、`~/.vibevalley*` 与 `/Applications/VibeValley*.app`。

## Risks

- **纯 Rust `.git` 解析遗漏边缘仓库形态**：例如 `extensions.objectFormat`、`core.bare`、多层符号引用或 Windows/macOS 路径大小写差异；通过 `crates/git/read.rs` 与真实 `git` CLI 的高覆盖 parity 单测对冲，复杂 revspec 直接回退安全子进程。
- **`crates/server` 清理 `Value` 引发存储历史数据兼容性边界问题**：旧字段缺失时依赖结构体的 `#[serde(default)]` 与显式迁移默认值；改前对 `channel/types.rs` 与 `issue/chat.rs` 现有持久化序列化单测逐一对齐。
- **`zh` 词典纯英文检查误伤合法技术缩写**：如 `{value} Hz`、模型名或协议缩写；通过最小显式白名单文件或规则精确匹配单位占位模式控制误报，同时拦住未翻译整句与孤立英文标签。
