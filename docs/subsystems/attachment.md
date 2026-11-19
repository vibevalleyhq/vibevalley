# 附件

农场留下的一份文件（`Attachments`，`crates/vibevalley-server/src/modules/attachment.rs`）：按内容的 SHA-256 存一次，有名字、媒体类型和大小。它不属于哪个用它的地方：消息带着附件的 id（界面叫「附件」），媒体任务的结果和输入是附件，网页 Artifact 的每一稿是一个附件，素材库的一条是一个附件加它的来路（界面叫「素材」）。农场只有这一处存文件的字节。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `server.db` 的表 `attachment` 记名字、类型、大小；字节以 SHA-256 为键写在家目录的 `attachments/` 下 | 消息怎么带它、怎么画（[频道](docs/subsystems/channel.md)） |
| 上传（`attachment.create`）：空的、超过上限的拒绝 | 生成和下载结果的任务（[媒体](docs/subsystems/media.md)） |
| 按 id 读回字节和类型，经 `GET /api/v1/attachment/<id>` 带沙箱返回 | 素材的来路和列表（[素材库](docs/subsystems/media.md#素材库)，`crates/vibevalley-server/src/modules/library.rs`） |

## 在哪

| 位置 | 职责 |
|---|---|
| [附件查询](crates/vibevalley-server/src/modules/attachment/sql/queries.sql) | sqlc 为 SQLx 生成按哈希读取和首次写入元数据的接口。相同哈希保留首次记录的名字和类型。 |
| `crates/vibevalley-server/src/modules/attachment.rs` | `Attachments`：`attach`（上传）、`keep`（这里做出来的字节）、`keep_staged`（媒体输入写在暂存目录、已算好哈希的大文件）、`of`（一组 id 的附件，缺一个就拒绝）、`file`、`path_of`；`open_sqlx_db` 打开各模块共用的 `server.db` |
| `crates/vibevalley-http/src/media.rs`、`crates/vibevalley-http/src/lib.rs` | `GET /api/v1/attachment/<id>`（经 `attachment.file` 取路径）；`attachment.create` 走通用的命令入口 |
| `packages/protocol/src/attachment/` | `Attachment`、`AttachmentUpload`、`attachmentPath`、`attachmentMax`（Rust 类型由它生成） |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`attachment.*`）。

## 模型和不变量

- **按内容存一次，写完才发布**：id 是字节的 SHA-256；同样的字节再来是同一个附件，名字和类型记第一次的。`write_once` 先在旁边写临时文件，写完才改名到键下，不留残缺文件。
- **上限**：经 `attachment.create` 上传的单个 25MB（`attachmentMax`），以 Base64 走请求体。用它的模块自己守自己的上限：网页 Artifact 一稿 5MB；媒体的输入写进 `attachments/.staging/media/`、记在媒体的配额里，最大 512MB，写完经 `keep_staged` 放进来。
- **放进来时核对**：`keep_staged` 遇到同名的文件先算它的哈希，对不上（磁盘上被改过）就用新写的替换，不信任坏掉的那份。
- **`path_of` 隔离本机路径假设**：HTTP 的文件响应、给帮工的信封、上传给厂商需要本机路径时统一调 `Attachments::path_of`；换存储后端只改 `attachment.rs`，上层模块不动。
- **读回带沙箱**：图、音频、视频和 PDF 在页面里显示，其余的下载；不是 PDF 的都带 `content-security-policy: sandbox`，不当农场自己的页面跑。按内容寻址，永久缓存。
- **只增不改**：附件不随消息、任务、Artifact 或素材删除而删。现在没有回收：没人引用的附件留在磁盘上，要回收得先数清所有引用它的地方（消息、媒体的输入和结果、Artifact 的稿、素材）。

## 和谁打交道

- **频道**：发消息时用 `of` 核对带的附件都在；给帮工的信封里附上 `path_of` 的路径。
- **媒体**：生图、语音、对白的结果用 `attach` 存成附件；为理解、克隆、转写上传的输入和生成的音频结果流式写进 `staging/media/`，经 `keep_staged` 成为附件，媒体只记它的使用（`media_input`：阶段、到期、哪些任务在用）。
- **Artifact**：网页的每一稿经 `keep` 存成附件，`artifact_version.attachment_id` 指向它。
- **素材库**：用户上传的、帮工拿回来的文件经 `attach` 存，按 id 认素材。

## 为什么这样

- **附件自成一个概念，字节实现收在模块内部**：媒体的结果、素材库、Artifact 都用 `Attachments`；磁盘读写只在 `attachment.rs` 里。
- **只有一处存字节**：Artifact 和媒体不各设一个按内容寻址的目录；各设一个时，同一份文件会存好几遍，删除时各数各的引用。各模块只记自己怎么用附件。

## 怎么验证

- `crates/vibevalley-server/tests/media_inputs.rs`：媒体输入经暂存放进附件、删输入不删还被引用的字节、伪装的文件和不对的大小被拒。
- `crates/vibevalley-http/src/tests.rs`：`GET /api/v1/attachment/<id>` 的类型、沙箱头和缓存头。
- `crates/vibevalley-server/tests/channel.rs`、`crates/vibevalley-server/tests/artifact.rs`、`crates/vibevalley-server/tests/library.rs`：带附件的消息、网页稿和素材经附件存取。
