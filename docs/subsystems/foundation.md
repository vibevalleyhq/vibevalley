# 地基

服务端、命令行、原生应用和脚本共用的工程骨架：Cargo 工作区与 pnpm 工作区、深模块、边界一次解码的类型、契约的生成、SQLite 存储与测试分层。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| Cargo 工作区（`crates/*`、`apps/mac`）、pnpm 工作区（剩下的 TS 包与页面）、依赖版本、构建与检查 | 各 crate、各包的对外约定（各自的 `README.md` 或 `lib.rs` 开头） |
| 服务端模块的划分与启动顺序 | 各模块的业务行为（对应子系统文档） |
| 契约（`packages/protocol` 的 zod）与生成的 Rust 类型（`vibevalley-protocol`） | 核心状态折叠与接口路由（[核心状态](docs/subsystems/core.md)） |
| SQLite 存储、表在哪个模块 | 业务表含义（各子系统）与家目录文件（[架构](docs/architecture.md#存了什么)） |
| 测试分层、测试用的替身农机 | 页面分层与宿主打包（[客户端](docs/subsystems/app.md)） |
| 词典（`packages/i18n`，Rust 经 `vibevalley-i18n` 编进二进制）与模型提示（`assets/`）分工 | 界面用词标准（[用语表](docs/README.md#用语)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `Cargo.toml`、`rust-toolchain.toml`、`rustfmt.toml` | Rust 工作区成员、工具链与格式 |
| `pnpm-workspace.yaml`、`vite.config.ts` | TS 工作区包列表、依赖版本 catalog、oxfmt 与 oxlint 配置、检查任务（`rust:check`、`docs:verify`…） |
| `scripts/{gen,audit,docs,release}/` | 工程脚本：`gen/`（生成物写出）、`audit/`（lint 插件、死代码、注释审查）、`docs/`（Note、链接、术语与旧名检查）、`release/`（发版、回归与验收沙箱） |
| `crates/vibevalley-server/src/lib.rs`、`crates/vibevalley-server/src/start.rs` | `Hub`（状态、端点表、事实）与按序打开各模块的 `start` |
| `crates/vibevalley-server/src/modules/` | 按概念的模块：每个对外一个类型（`Chat`、`Agents`、`Repos`、`Memories`…），在 `Hub` 上注册自己的端点 |
| `crates/vibevalley-protocol/src/contract/`、`crates/vibevalley-protocol/tests/typescript.rs` | 线上类型：手写的 Rust 是源头，`ts-rs` 写出 `packages/protocol` 的 `*.gen.ts`（`vp run protocol:ts`），`vp run protocol:check` 查最新 |
| `crates/vibevalley-core/src/` | 双端都跑的规则的 Rust 版：`reduce`、出帧、状态派生、收件箱、依赖 |
| `crates/vibevalley-store/src/lib.rs` | `state.db`（SQLite）：工单板的工单、会话与布局 |
| `crates/vibevalley-home/src/lib.rs` | 家目录约定：在哪、`server.json`、语言；服务端、命令行、原生应用共用 |
| `crates/vibevalley-i18n/src/lib.rs`、`crates/vibevalley-i18n/locales/` | 消息格式与词典；词典构建时编进去 |
| `crates/vibevalley-server/src/testing.rs` | 测试和验收沙箱用的替身农机 `pi`（`VIBEVALLEY_TEST_RUNTIMES=1`） |
| `packages/protocol/src/<概念>/` | 页面用的契约：生成的 `shapes.gen.ts`，手写的 `schema.ts`（Zod）和 `api.ts`；`src/rules/` 是页面用的纯函数规则；`src/client.ts` 是生成的 `VibeValleyApi` |

## 模型和不变量

### 仓库和包

- **Rust 为准**：服务端（`vibevalley-server`）、命令行（`vibevalley-cli`）、原生应用（`apps/mac`）都是 Rust；TS 只剩原生应用的页面（`apps/mac/ui`）和它用的包（`packages/`）、官网（`apps/site`）与脚本（[原生的 VibeValley](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)）。
- **一个 Cargo 工作区**：成员是 `crates/*` 与 `apps/mac`，版本与 edition 写在根 `Cargo.toml` 的 `[workspace.package]`，依赖各 crate 自己写；`vp run rust:check` 跑 `cargo fmt --check`、`cargo clippy -D warnings` 与 `cargo test`。
- **TS 依赖版本集中**：版本在 `pnpm-workspace.yaml` 的 catalog，各包写 `catalog:`（`scripts/audit/catalog.test.ts` 查）。
- **跨包走包名**：TS 跨包写 `@vibevalley/*`（`no-cross-package-path` 查）；`apps/mac/ui` 经 `nsh.json` 的别名解析它们；`packages/*` 的类型导出指向 `dist/*.d.ts`（`vp run packages:build`）。

### 模块和服务

架构、边界与测试如何共同设计，见[模块设计](docs/style/module-design.md)。

- **深模块**：每个模块对外一个类型和它的几个方法，里面的表、锁和线程不露出去；不靠一个带 `kind` 的入口复用多种操作。
- **按序启动**：`start`（`crates/vibevalley-server/src/start.rs`）按依赖顺序打开模块，后打开的拿到先打开的（`Arc`）；状态只经 `Hub::apply` 改，模块之间的上行反应经 hub 的 `Watcher`（每条 `Transition`）。
- **操作与发言主体统一用 `Actor`**：`kind` 是 `user`、`agent`、`system`，`agent` 带 `role` 与 `forUser`；HTTP 来的是 `user`，助手的工具是 `agent`（`orchestrator`），`/mcp` 是 `agent`（`worker`），定时任务是 `system`。
- **同一个家目录只有一个工单板**：工单板在它的数据旁放一个锁文件，别的进程只能读快照（`Board::snapshot`）。

### 异步、资源与错误

- **边界解码一次，门内全是类型**：HTTP 的入参经 `decode`（`crates/vibevalley-server/src/lib.rs`，serde）按端点的类型解成结构体，解不开当场拒绝；文件、厂商响应、模型给的工具参数各在进门处解成结构体和 enum。门内不传 `serde_json::Value`，不按字符串分支（还有存量，见 Note 的 R2、R4）。
- **钥匙是 `Secret`**：`settings.json` 里的钥匙读成 `Secret`（`crates/vibevalley-server/src/modules/setting.rs`），打印只出提示。
- **拒绝带 `BizCode`**：对调用方的拒绝是 `ApiError`（带 `bizCode` 与 `next`），网关写成全信封；模块内部可分辨的失败是 `thiserror` 的 enum；预期的结果（合进去或冲突）返回 enum，不当错误。
- **普通线程，不进异步运行时**：模块的方法都是阻塞的，后台的活是 `std::thread` 加 `flume` 通道；只有 HTTP（axum）在 tokio 上，经 `vibevalley-server-api` 的 `Server` trait 调进来。

### 契约、规则和数据库

- **契约以 Rust 为源，生成 TS**：`crates/vibevalley-protocol/src/contract/` 的类型是数据源，`vp run protocol:ts` 写出 `packages/protocol` 的 `shapes.gen.ts` 与 `endpoints.gen.ts`，`cargo test` 里的 `tests/typescript.rs` 查最新；页面在边界解码用的 Zod Schema 与 `api.ts` 手写，由 `schema.test.ts`、`api.test.ts` 对着生成物查。词典在 `crates/vibevalley-i18n/locales/`，`vp run i18n:gen` 写出 TS 目录。
- **生成文件不手改**：`packages/protocol` 的 `*.gen.ts`、`packages/protocol/src/client.ts`、`packages/i18n/src/catalogs.ts`、[capabilities.md](docs/reference/capabilities.md) 由脚本生成并有检查。
- **SQLite，两个库**：工单板的 `state.db` 在 `vibevalley-store`；频道、记性、笔记、Artifact、媒体等各模块的表在 `server.db`，每个模块在自己的 `db.rs` 或模块文件里 `create table if not exists`。时间存整数毫秒。
- **内部不留兼容**：改表直接改建表语句，不写迁移。

### 测试金字塔

一个行为在能发现它出错的最低层测；高一层只验证新增的接线。

| 层 | 入口 | 位置 |
|---|---|---|
| 规则 | 纯函数 | 各 crate 的 `#[cfg(test)]` 与 `src/tests.rs`（如 `crates/vibevalley-core/src/tests.rs`） |
| 模块 | 模块的类型、真 git、脚本农机（`vibevalley-oar` 的 `scripted`）、脚本模型 | `crates/vibevalley-server/tests/issue_board.rs`、`crates/vibevalley-server/tests/*.rs` |
| 服务端整体 | 起真的 `vibevalley-server`、经 HTTP | `crates/vibevalley-server/tests/start.rs`、`crates/vibevalley-cli/tests/cli.rs` |
| 页面 | `nsh/test`，样例的 `Transport` | `apps/mac/ui/vv/app/*.test.tsx`、`apps/mac/ui/components/*.test.tsx` |
| 像素场景 | 真的素材、样例帧，在 CPU 上画 | `apps/mac/src/pixel/tests.rs` |

- **不靠睡眠等待**：Rust 测试用 `until` 轮询条件；TS 测试禁止写死 `setTimeout` 或 `waitForTimeout`（`vibevalley/no-test-sleep` 查）。
- **对照 golden**：`reduce` 与出帧、artifact 与 pkm 的规则对着 golden；artifact 与 pkm 的由 TS 的引擎写出（`vp run goldens`）（`crates/vibevalley-core/tests/projection.rs`、`crates/vibevalley-artifact/tests/golden.rs`）。

### 话放在哪

- **对用户的话进词典**：`crates/vibevalley-i18n/locales/{zh,en}/<命名空间>.json`；TS 调 `t("key")`（`vibevalley/no-cjk-literal` 拦硬编码中文），Rust 调 `vibevalley_i18n::t`。
- **对模型的话在 `assets/`**：助手的提示在 `crates/vibevalley-server/assets/orchestrator/prompts.json`，工具说明在 `crates/vibevalley-server/assets/tools/`，以 Rust 为准；中文编写，要求模型按用户的语言回答。
- **语言**：存于家目录 `settings.json` 的 `locale`（`vibevalley-home`）。

## 怎么走

**新增或修改表**：改模块里的建表语句和查询，跑 `cargo test -p vibevalley-server`。

**新增或修改接口**

1. 改 `crates/vibevalley-protocol/src/contract/<概念>.rs`，跑 `vp run protocol:ts` 重写 TS 类型；页面要用的同改 `packages/protocol/src/<概念>/` 的 `schema.ts`、`api.ts`。
2. 在 `crates/vibevalley-server/src/modules/<概念>` 用 `Hub::on` 注册处理函数。
3. 跑 `vp run api:client`、`vp run capabilities` 更新生成的客户端与能力表。

## 为什么这样

- **只有一个服务端，Rust 的**：原生应用和命令行直接用它的类型；用户选了激进重构、速度优先（[原生的 VibeValley](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)）。
- **SQLite，不是 Postgres**：一台电脑一个人，SQLite 开箱即用、不带 WASM；多机与外部库不在当前计划里。
- **阻塞线程而非 async**：模块里大多是子进程、文件和 SQLite，阻塞写法最直白；异步只留在 HTTP 那层。
- **对模型的话保持中文、不进词典**：避免双份提示调优与评测漂移。

## 怎么验证

- `vp run rust:check`：格式、clippy 与全部 Rust 测试。
- `vp run protocol:check`：生成的线上类型与 golden 是最新的。
- `vp check`、`vp run packages:check`、`vp run mac:check`：TS。
- `vp run docs:verify`：生成物、词典、旧名字与文档链接。
