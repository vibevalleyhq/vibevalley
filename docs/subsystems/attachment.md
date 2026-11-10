# 附件

农场留下的一份文件（`Attachment`，`apps/server/src/attachment/attachment.ts`）：按内容的 SHA-256 存一次，有名字、媒体类型和大小。它不属于哪个用它的地方：消息带着附件的 id（界面叫「附件」），媒体任务的结果是一个附件，素材库的一条是一个附件加它的来路（界面叫「素材」）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 字节存在家目录的 `attachments/<sha256>`，表 `attachment` 记名字、类型、大小 | 消息怎么带它、怎么画（[频道](docs/subsystems/channel.md)） |
| 上传（`attachment.create`）：空的、超过上限的拒绝 | 生成和下载结果的任务（[媒体](docs/subsystems/media.md)） |
| 按 id 读回字节和类型，经 `GET /api/v1/attachment/<id>` 带沙箱返回 | 素材的来路和列表（素材库，`apps/server/src/library`） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/attachment/attachment.ts` | 服务 `Attachment`：`attach`、`get`、`of`（一组 id 的附件，缺一个就是 Missing）、`pathOf` |
| `apps/server/src/http/handlers/attachment.ts`、`apps/server/src/http/api.ts` | `attachment.create`；`GET /api/v1/attachment/<id>` |
| `packages/protocol/src/attachment/` | `Attachment`、`AttachmentUpload`、`attachmentPath`、`attachmentMax` |
| `apps/server/db/queries/attachment.sql` | 表 `attachment` 的查询 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`attachment.*`）。

## 模型和不变量

- **按内容存一次**：id 是字节的 SHA-256；同样的字节再来是同一个附件，名字和类型记第一次的。文件写完整再发布，不留半个。
- **上限**：单个 25MB（`attachmentMax`），上传以 Base64 走请求体；更大的音频结果由媒体自己的输入存储持有。
- **读回带沙箱**：图、音频、视频和 PDF 在页面里显示，其余的下载；不是 PDF 的都带 `content-security-policy: sandbox`，不当农场自己的页面跑。按内容寻址，永久缓存。
- **只增不改**：附件不随消息、任务或素材删除而删。

## 和谁打交道

- **频道**：发消息时用 `of` 核对带的附件都在；给帮工的信封里附上 `pathOf` 的路径。
- **媒体**：生图、语音、对白的结果用 `attach` 存成附件。
- **素材库**：用户上传的、帮工拿回来的文件经 `attach` 存，按 id 认素材。
- **门（`Lan`）**：配对来的设备能 `GET` 附件。

## 为什么这样

- **附件自成一个概念，不归频道**：媒体的结果、素材库、以后 Artifact 里的图都用它；放在频道下，它们就得为了存一个文件去依赖频道。它在 Platform，谁都能用。

## 怎么验证

- `apps/server/src/http/attachment.test.ts`：读回的类型、`inline` 与下载、沙箱头、不存在和越界的 id、超限拒绝。
- `apps/server/src/channel/channel.test.ts`：带附件的消息、同一字节去重、存不下时说文件系统的原话。
