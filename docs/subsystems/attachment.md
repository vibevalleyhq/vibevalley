# 附件

农场留下的一份文件与统一后端抽象（`Storage` / `StorageBackend`，`crates/server/src/storage/`）：附件按内容 SHA-256 存一次，有名字、媒体类型和大小。消息带着附件的 id（界面叫「附件」），媒体任务的结果和输入、素材库条目及作品目录均通过 `storage/` 统一读写底层存储后端。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `server.db` 的表 `attachment` 记名字、类型、大小；`StorageBackend` 读写对象字节与本地读穿缓存 | 消息怎么带它、怎么画（[频道](docs/subsystems/channel.md)） |
| 上传（`attachment.create`）：空的、超过上限的拒绝 | 生成和下载结果的任务（[媒体](docs/subsystems/media.md)） |
| 按 id 读回字节和类型，经 `GET /api/v1/attachment/<id>` 走统一 `serve_file_range` 带沙箱返回 | 素材的来路和列表（[素材库](docs/subsystems/media.md#素材库)，`crates/server/src/artifact/library.rs`） |

## 在哪

| 位置 | 职责 |
|---|---|
| [附件实体](crates/server/src/db/entity/attachment.rs) | SeaORM 实体按哈希读取和首次写入元数据。相同哈希保留首次记录的名字和类型。 |
| `crates/server/src/storage/`、`crates/server/src/storage/backend/` | 统一 `Storage` 与可插拔异步 `StorageBackend` trait（[backend/mod.rs](crates/server/src/storage/backend/mod.rs) 含 `normalize_key` / `normalize_prefix` 路径校验）：`LocalFsBackend`（[local.rs](crates/server/src/storage/backend/local.rs)）、`S3Backend`（[s3.rs](crates/server/src/storage/backend/s3.rs)）、`MemoryBackend`（[memory.rs](crates/server/src/storage/backend/memory.rs)）与 [config.rs](crates/server/src/storage/backend/config.rs)；`attachment.rs` 提供 `attach`、`keep`、`keep_staged`、`of`、`file_async`、`materialize_local_async` 与 `path_of` |
| `crates/server/src/gateway/http/shared.rs`、`media.rs`、`mod.rs` | `serve_file_range`（`shared.rs`）供 `GET /api/v1/attachment/<id>` 与 `media::content` 共用，透传 `CallerContext` 经 `attachment.file` 鉴权，支持 `Authorization: Bearer` 与 `?token=` 及 HTTP `Range` 分块流式返回 |
| `crates/protocol/src/contract/attachment.rs`、`packages/protocol/src/attachment/` | `Attachment`、`AttachmentUpload`、`attachmentPath`、`attachmentMax`（Rust 为源，TS 形状由它生成） |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`attachment.*`）。

## 模型和不变量

- **按内容存一次，写完才发布**：id 是字节的 SHA-256；同样的字节再来是同一个附件，名字和类型记第一次的。本地写入先写临时文件再 `rename` 落盘，不留残缺文件。
- **可插拔 `StorageBackend` 与零本地假设**：
  - 启动由 `VIBEVALLEY_STORAGE_URL` 或 `--storage-url` 解析 `StorageConfig`（`file://` 默认为 `LocalFsBackend`，`s3://bucket/prefix?endpoint=...&region=...&path_style=true` 对应 `S3Backend`，`memory://` 对应 `MemoryBackend`）；拒绝在 URL 中拼接密钥，S3 凭据通过 `VIBEVALLEY_S3_ACCESS_KEY_ID` 与 `VIBEVALLEY_S3_SECRET_ACCESS_KEY`（包装为 `Secret`）注入。
  - `normalize_key` / `normalize_prefix` 统一拦截 `..`、`.`、绝对路径、反斜杠、空段、NUL 与控制字符。
  - `S3Backend` 基于既有 `reqwest` + `sha2` + `jiff` 纯实现 AWS SigV4 请求签名、预签名 GET URL 与 `ListObjectsV2` 分页 XML 解析。
  - 当 `backend.local_path()` 返回 `None` 时，`materialize_local_async` 与 `file_async` 透明读穿并原子缓存至 `<home>/.cache/storage/attachments/<sha256>`，上层无需感知远端差异。
- **上限**：经 `attachment.create` 上传的单个 25MB（`attachmentMax`），以 Base64 走请求体；媒体的输入写进 `attachments/.staging/media/`、记在媒体的配额里，最大 512MB，写完经 `keep_staged` 放进来。
- **放进来时核对**：`keep_staged` 遇到同名的文件先算它的哈希，对不上（磁盘上被改过）就用新写的替换，不信任坏掉的那份。
- **鉴权、统一 `serve_file_range` 与读回沙箱**：`GET /api/v1/attachment/<id>` 经 `Router` 校验 `CallerContext`（允许本机 `Caller::User` 与已认证 `Caller::Remote`，支持 `Authorization: Bearer` 头或 `?token=` 查询参数），与 `media::content` 共用 `serve_file_range` 流式响应：`Accept-Ranges: bytes`、`206 Partial Content`、`Content-Range`、0 字节文件在带 `Range` 时返回 `416`（`bytes */0`）否则返回 `200`（`content-length: 0`）、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、RFC 5987 `Content-Disposition: inline; filename*=UTF-8''...` 与不可变长期缓存。
- **只增不改**：附件不随消息、任务、Artifact 或素材删除而删。现在没有回收：没人引用的附件留在存储上，要回收得先数清所有引用它的地方。

## 和谁打交道

- **频道**：发消息时用 `of` 核对带的附件都在；给帮工的信封里附上本地或读穿缓存路径。
- **媒体**：生图、语音、对白的结果用 `attach` 存成附件；为理解、克隆、转写上传的输入和生成的音频结果流式写进 `staging/media/`，经 `keep_staged` 成为附件，媒体只记它的使用（`media_input`：阶段、到期、哪些任务在用）。
- **Artifact**：作品目录 `<storage>/artifact/<id>/` 与版本快照通过同一 `Storage` / `StorageBackend` 持久化（[Artifact](docs/subsystems/artifact.md)）。
- **素材库**：用户上传的、帮工拿回来的文件经 `attach` 存，按 id 认素材。

## 为什么这样

- **附件与后端实现收在 `storage/` 内部，不引入 `object_store` / `aws-sdk-s3`**：服务端只需 6 个窄对象原语与标准 SigV4，复用既有 `reqwest` + `sha2` + `jiff` 可在零新增 Cargo 依赖下完整掌控 `Secret` 脱敏与错误边界；通过读穿缓存隔离 `local_path()` 差异，避免上层 `channel` / `issue` / `media` / `gateway` 按存储后端类型分支。
- **只有一处存字节、统一响应安全头**：Artifact、媒体与素材库共用 `Storage`；`attachment` 与 `media::content` 共用 `serve_file_range`，避免重复拼接 HTTP `Range` 时遗漏 `nosniff` 与 `sandbox` 防护。

## 怎么验证

- `crates/server/tests/media_inputs.rs`：媒体输入经暂存放进附件、删输入不删还被引用的字节、伪装的文件和不对的大小被拒。
- `crates/server/src/storage/` 单测与 Mock S3 集成测试：`LocalFsBackend`、`MemoryBackend`、`S3Backend`（SigV4 测试向量、分页 `ListObjectsV2`、读穿缓存与远端恢复）。
- `crates/server/src/gateway/http/tests.rs`：`serve_file_range` 的 `nosniff`/`sandbox`/RFC 5987 安全头、Byte-Range `206` 与 0 字节回归测试。
- `crates/server/tests/channel.rs`、`crates/server/tests/artifact.rs`、`crates/server/tests/library.rs`：带附件的消息、作品目录与素材经存储存取。
