# 附件

农场留下的一份文件（`Attachment`，`apps/server/src/modules/attachment/attachment.ts`）：按内容的 SHA-256 存一次，有名字、媒体类型和大小。它不属于哪个用它的地方：消息带着附件的 id（界面叫「附件」），媒体任务的结果和输入是附件，网页 Artifact 的每一稿是一个附件，素材库的一条是一个附件加它的来路（界面叫「素材」）。农场只有这一处存文件的字节。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 表 `attachment` 记名字、类型、大小；内部存储实现（`attachment/storage.ts`）以 SHA-256 为键写入本机 `attachments/` 与 `scratch` 暂存目录 | 消息怎么带它、怎么画（[频道](docs/subsystems/channel.md)） |
| 上传（`attachment.create`）：空的、超过上限的拒绝 | 生成和下载结果的任务（[媒体](docs/subsystems/media.md)） |
| 按 id 读回字节和类型，经 `GET /api/v1/attachment/<id>` 带沙箱返回 | 素材的来路和列表（[素材库](docs/subsystems/media.md#素材库)，`apps/server/src/modules/media/library.ts`） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/modules/attachment/attachment.ts` | 服务 `Attachment`：`attach`（上传）、`keep`（这里做出来的字节）、`keepStaged`（写在 `staging` 下、写的人已算好哈希的大文件）、`get`、`of`（一组 id 的附件，缺一个就是 Missing）、`pathOf` |
| `apps/server/src/modules/attachment/storage.ts` | 模块内部的本机字节存储（`makeStorage`）：按键原子写入（`put`、`putStream`）、`scratch` 暂存与 `adopt` 收纳、流与本机路径读取 |
| `apps/server/src/gateway/http/handlers/attachment.ts`、`apps/server/src/gateway/http/api.ts` | `attachment.create`；`GET /api/v1/attachment/<id>` |
| `packages/protocol/src/attachment/` | `Attachment`、`AttachmentUpload`、`attachmentPath`、`attachmentMax` |
| `apps/server/db/queries/attachment.sql` | 表 `attachment` 的查询 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`attachment.*`）。

## 模型和不变量

- **按内容存一次，写完才发布**：id 是字节的 SHA-256；同样的字节再来是同一个附件，名字和类型记第一次的。`put` 经 `infra/files.ts` 的 `writeOnce` 落盘；流式写入先写进 `scratch` 下的临时目录，全部写完才改名到键下，取消或失败时删掉临时文件，不留残缺文件。
- **上限**：经 `attachment.create` 上传的单个 25MB（`attachmentMax`），以 Base64 走请求体。用它的模块自己守自己的上限：网页 Artifact 一稿 5MB；媒体的输入流式写进暂存目录 `staging`（即 `storage.scratch`）下的 `media/`、记在媒体的配额里，最大 512MB，写完经 `keepStaged`（`storage.adopt`）放进来。
- **放进来时核对**：`keepStaged` 遇到同名的文件先算它的哈希，对不上（磁盘上被改过）就用新写的替换，不信任坏掉的那份。
- **`pathOf` 隔离本机路径假设**：HTTP 的文件响应、给帮工的信封、上传给厂商需要本机路径时统一调 `Attachment.pathOf`；未来多机拆出对象存储实现时（[一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)），只需在 `attachment/storage.ts` 内切换后端并按需拉取到本机，上层模块不动。
- **读回带沙箱**：图、音频、视频和 PDF 在页面里显示，其余的下载；不是 PDF 的都带 `content-security-policy: sandbox`，不当农场自己的页面跑。按内容寻址，永久缓存。
- **只增不改**：附件不随消息、任务、Artifact 或素材删除而删。现在没有回收：没人引用的附件留在磁盘上，要回收得先数清所有引用它的地方（消息、媒体的输入和结果、Artifact 的稿、素材）。

## 和谁打交道

- **频道**：发消息时用 `of` 核对带的附件都在；给帮工的信封里附上 `pathOf` 的路径。
- **媒体**：生图、语音、对白的结果用 `attach` 存成附件；为理解、克隆、转写上传的输入和生成的音频结果流式写进 `staging/media/`，经 `keepStaged` 成为附件，媒体只记它的使用（`media_input`：阶段、到期、哪些任务在用）。
- **Artifact**：网页的每一稿经 `keep` 存成附件，`artifact_version.attachment_id` 指向它。
- **素材库**：用户上传的、帮工拿回来的文件经 `attach` 存，按 id 认素材。
- **门（`Lan`）**：配对来的设备能 `GET` 附件。

## 为什么这样

- **附件自成一个概念，字节实现收在模块内部**：媒体的结果、素材库、Artifact 都用 `Attachment`；底层磁盘存储只有 `Attachment` 一个调用方，直接作为 `attachment/storage.ts` 内聚在模块内，省去单调用方的顶层服务透传。
- **只有一处存字节**：Artifact 和媒体不各设一个按内容寻址的目录；各设一个时，同一份文件会存好几遍，删除时各数各的引用。各模块只记自己怎么用附件。

## 怎么验证

- `apps/server/src/modules/attachment/storage.test.ts`：同一个键写两次只有一份，读回的字节和类型，删除，流式写入整份发布，取消的写入在键下和暂存里都不留东西。
- `apps/server/src/gateway/http/attachment.test.ts`：读回的类型、`inline` 与下载、沙箱头、不存在和越界的 id、超限拒绝。
- `apps/server/src/modules/channel/channel.test.ts`、`apps/server/src/modules/media/inputs.test.ts`、`apps/server/src/modules/artifact/artifact.test.ts`：带附件的消息、同一字节去重、经附件写进存储的媒体输入和网页稿。
