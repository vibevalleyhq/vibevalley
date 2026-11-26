# Agent Note: 服务端插件化存储后端（StorageBackend）

Status: proposed

## Problem

服务端原本的 `crates/server/src/storage/`（[mod.rs](crates/server/src/storage/mod.rs)）将附件 CAS、暂存媒体输入与作品目录直接写死在本地 `<home>` 文件系统路径上。单机桌面模式工作正常，但缺少统一的对象存储抽象层，导致：

1. **云端/多机部署无法对接对象存储**：无法将大附件或作品资产落到 AWS S3、Cloudflare R2、MinIO 或 RustFS。
2. **单元测试强依赖临时磁盘目录**：测试附件、媒体与作品持久化缺少零磁盘开销的确定性内存后端。
3. **路径与密钥校验分散**：缺乏单一键规范化入口，远程存储凭据也需严格走 `Secret` 包装防止日志泄漏。

## Proposal

参考 Django Storage 的可插拔抽象，在 `crates/server/src/storage/backend/` 下引入窄异步 `StorageBackend` trait 与三种内置后端，并以零回归方式接入现有 `Storage`：

1. **核心 trait 与键规范化（[backend/mod.rs](crates/server/src/storage/backend/mod.rs)）**：
   - 定义 `StorageBackend: Send + Sync`（`kind`、`put`、`get`、`head`、`delete`、`list`、`exists`、`local_path`、`signed_url`），复用仓库统一的 `BoxFuture<'a, _>`，零新增 Cargo 依赖。
   - `normalize_key` / `normalize_prefix` 作为全后端唯一真源，统一拒绝 `..`、`.`、绝对路径、反斜杠、空段、NUL 与控制字符。
2. **三种内置后端**：
   - **`LocalFsBackend`（[local.rs](crates/server/src/storage/backend/local.rs)）**：默认后端，原子临时文件 + `rename` 落盘，直接返回 `local_path() == Some(...)`，保持 `<home>/attachments/...` 与 `<home>/artifact/...` 布局 100% 兼容。
   - **`S3Backend`（[s3.rs](crates/server/src/storage/backend/s3.rs)）**：基于 `reqwest` 与 `sha2::Sha256` 纯实现 RFC 2104 HMAC-SHA256、AWS SigV4 请求签名、SigV4 预签名 GET URL 与 `ListObjectsV2` 分页 XML 解析，支持自定义 `endpoint`、`region`、`prefix` 与 `path_style`；`secret_access_key` 使用 [Secret](crates/server/src/setting.rs) 包装，绝不出现在 `Debug` 或日志中。
   - **`MemoryBackend`（[memory.rs](crates/server/src/storage/backend/memory.rs)）**：基于 `parking_lot::RwLock<BTreeMap<..>>`，`local_path()` 返回 `None`，测试可直接覆盖远程读穿缓存路径。
3. **启动配置与读穿缓存（[config.rs](crates/server/src/storage/backend/config.rs)、[attachment.rs](crates/server/src/storage/attachment.rs)、[artifact.rs](crates/server/src/storage/artifact.rs)）**：
   - 通过 `VIBEVALLEY_STORAGE_URL` 或 `--storage-url` 解析强类型 `StorageConfig`（`file://`、`s3://bucket/prefix?endpoint=...&region=...&path_style=true`、`memory://`），未设置时默认 `LocalFs { root: home }`；拒绝将密钥拼在 URL 中，改由 `VIBEVALLEY_S3_ACCESS_KEY_ID` / `VIBEVALLEY_S3_SECRET_ACCESS_KEY` 注入。
   - 当 `backend.local_path()` 返回 `None` 时，`AttachmentStorage::materialize_local_async` 与 `file_async` 透明读穿并原子缓存至 `<home>/.cache/storage/attachments/<sha256>`，确保桌面 GPUI `<Image>` 与 `MediaInputStorage` 无缝拿到本地文件路径；`ArtifactStorage` 在非本地后端下自动镜像文件与版本快照并支持按需 `restore_from_backend_async`。

## Alternatives considered

**引入 `object_store` 或 `aws-sdk-s3` 外部大依赖**：会显著拉长编译时间并引入数百个传递 crate，而 VibeValley 服务端只需要 6 个窄对象原语与标准 SigV4 签名，直接复用已有的 `reqwest` + `sha2` + `jiff` 可在零新增依赖下完全掌控边界、错误类型与 `Secret` 脱敏。

**让上层调用方各自按后端类型分支**：会把 S3/本地差异扩散到 `channel`、`issue`、`media` 与 `gateway`，违背深模块边界；将读穿缓存与 `local_path` 差异收敛在 `Storage` / `AttachmentStorage` 内部，上层只调既有接口。

## Acceptance criteria

- `LocalFsBackend`、`MemoryBackend`、`S3Backend` 通过共享契约与路径穿越测试；SigV4 请求签名与预签名 URL 精确通过 AWS 官方测试向量。
- 进程内 `axum` Mock S3 服务端验证 `S3Backend` 端到端 CRUD、分页 `ListObjectsV2`、预签名 GET 下载、403 签名拒绝，以及 `AttachmentStorage` / `MediaInputStorage` / `ArtifactStorage` 读穿缓存与远端恢复。
- `cargo fmt --all --check`、`cargo clippy -p vibevalley-server --all-targets -- -D warnings`、`cargo test -p vibevalley-server storage` 与 `cargo xtask audit` 全绿，且本地默认 `LocalFs` 零回归。

## Risks

- **远端读穿缓存容量增长**：长跑进程在 S3 模式下持续读取大量附件时，`<home>/.cache/storage/attachments` 需在后续迭代补充按 LRU / 配额清理策略。
- **单请求上传大小**：当前 `S3Backend::put` 使用单次 `PUT Object`，已满足 `ATTACHMENT_MAX = 25 MB` 与普通作品文件；若后续开放超百兆媒体直传，需要扩展 S3 Multipart Upload。
