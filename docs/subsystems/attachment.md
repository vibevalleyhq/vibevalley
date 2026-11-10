# 附件

农场留下的一份文件（`Attachment`，`apps/server/src/attachment/attachment.ts`）：按内容的 SHA-256 存一次，有名字、媒体类型和大小。它不属于哪个用它的地方：消息带着附件的 id（界面叫「附件」），媒体任务的结果和输入是附件，网页 Artifact 的每一稿是一个附件，素材库的一条是一个附件加它的来路（界面叫「素材」）。农场只有这一处存文件的字节。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 字节存在家目录的 `attachments/<sha256>`，表 `attachment` 记名字、类型、大小 | 消息怎么带它、怎么画（[频道](docs/subsystems/channel.md)） |
| 上传（`attachment.create`）：空的、超过上限的拒绝 | 生成和下载结果的任务（[媒体](docs/subsystems/media.md)） |
| 按 id 读回字节和类型，经 `GET /api/v1/attachment/<id>` 带沙箱返回 | 素材的来路和列表（素材库，`apps/server/src/library`） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/attachment/attachment.ts` | 服务 `Attachment`：`attach`（上传）、`keep`（这里做出来的字节）、`keepStaged`（写在 `staging` 下、写的人已算好哈希的大文件）、`get`、`of`（一组 id 的附件，缺一个就是 Missing）、`pathOf` |
| `apps/server/src/http/handlers/attachment.ts`、`apps/server/src/http/api.ts` | `attachment.create`；`GET /api/v1/attachment/<id>` |
| `packages/protocol/src/attachment/` | `Attachment`、`AttachmentUpload`、`attachmentPath`、`attachmentMax` |
| `apps/server/db/queries/attachment.sql` | 表 `attachment` 的查询 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`attachment.*`）。

## 模型和不变量

- **按内容存一次**：id 是字节的 SHA-256；同样的字节再来是同一个附件，名字和类型记第一次的。文件写完整再发布，不留半个。
- **上限**：经 `attachment.create` 上传的单个 25MB（`attachmentMax`），以 Base64 走请求体。用它的模块自己守自己的上限：网页 Artifact 一稿 5MB；媒体的输入流式写进 `attachments/staging/media/`、记在媒体的配额里，最大 512MB，写完经 `keepStaged` 改名进来。
- **放进来时核对**：`keepStaged` 遇到同名的文件先算它的哈希，对不上（磁盘上被改过）就用新写的替换，不信任坏掉的那份。
- **读回带沙箱**：图、音频、视频和 PDF 在页面里显示，其余的下载；不是 PDF 的都带 `content-security-policy: sandbox`，不当农场自己的页面跑。按内容寻址，永久缓存。
- **只增不改**：附件不随消息、任务、Artifact 或素材删除而删。现在没有回收：没人引用的附件留在磁盘上，要回收得先数清所有引用它的地方（消息、媒体的输入和结果、Artifact 的稿、素材）。

## 和谁打交道

- **频道**：发消息时用 `of` 核对带的附件都在；给帮工的信封里附上 `pathOf` 的路径。
- **媒体**：生图、语音、对白的结果用 `attach` 存成附件；为理解、克隆、转写上传的输入和生成的音频结果流式写进 `staging/media/`，经 `keepStaged` 成为附件，媒体只记它的使用（`media_input`：阶段、到期、哪些任务在用）。
- **Artifact**：网页的每一稿经 `keep` 存成附件，`artifact_version.attachment_id` 指向它。
- **素材库**：用户上传的、帮工拿回来的文件经 `attach` 存，按 id 认素材。
- **门（`Lan`）**：配对来的设备能 `GET` 附件。

## 为什么这样

- **附件自成一个概念，不归频道**：媒体的结果、素材库、Artifact 都用它；放在频道下，它们就得为了存一个文件去依赖频道。它在 Platform，谁都能用。
- **只有一处存字节**：Artifact 和媒体不各设一个按内容寻址的目录；各设一个时，同一份文件会存好几遍，删除时各数各的引用。各模块只记自己怎么用附件。

## 怎么验证

- `apps/server/src/http/attachment.test.ts`：读回的类型、`inline` 与下载、沙箱头、不存在和越界的 id、超限拒绝。
- `apps/server/src/channel/channel.test.ts`：带附件的消息、同一字节去重、存不下时说文件系统的原话。
