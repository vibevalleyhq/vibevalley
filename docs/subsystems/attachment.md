# 附件

农场留下的一份文件（`Attachment`，`internal/domain/attachment/attachment.go`）：按内容的 SHA-256 存一次，有名字、媒体类型和大小。它不属于哪个用它的地方：消息带着附件的 id（界面叫「附件」），媒体任务的结果和输入是附件，网页 Artifact 的每一稿是一个附件，素材库的一条是一个附件加它的来路（界面叫「素材」）。农场只有这一处存文件的字节。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 元数据记名字、类型、大小；本机对象存储（`internal/domain/attachment/attachment.go`）以 SHA-256 为键写入 `attachments/` 与 `staging/` 目录 | 消息怎么带它、怎么画（[频道](docs/subsystems/channel.md)） |
| 上传（`attachment.create`）：空的、超过上限的拒绝 | 生成和下载结果的任务（[媒体](docs/subsystems/media.md)） |
| 按 id 读回字节和类型，经 `GET /api/v1/attachment/<id>` 带沙箱返回 | 素材的来路和列表（[素材库](docs/subsystems/media.md#素材库)，`internal/domain/media/store.go`） |

## 在哪

| 位置 | 职责 |
|---|---|
| `internal/domain/attachment/attachment.go` | `Attachment` 服务与本机内容寻址存储：写入、读取、批量校验与本机路径获取 |
| `internal/domain/gateway/handlers_media.go`、`gateway.go` | `attachment.create`；`GET /api/v1/attachment/<id>` |
| `packages/protocol/src/attachment/` | `Attachment`、`AttachmentUpload`、`attachmentPath`、`attachmentMax` |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`attachment.*`）。

## 模型和不变量

- **按内容存一次，写完才发布**：id 是字节的 SHA-256；同样的字节再来是同一个附件，名字和类型记第一次的。流式写入先写进暂存目录，全部写完才原子落地到键下，取消或失败时删掉临时文件，不留残缺文件。
- **上限**：经 `attachment.create` 上传的单个 25MB（`attachmentMax`），以 Base64 走请求体。用它的模块自己守自己的上限：网页 Artifact 一稿 5MB；媒体的输入流式写进暂存目录、记在媒体的配额里，写完按内容纳入附件存储。
- **放进来时核对**：遇到同名文件先校验哈希，不信任损坏副本。
- **本机路径接口隔离多机假设**：HTTP 文件响应、帮工工作上下文和外部上传统一向附件服务取路径或流；切换存储后端时上层领域包不动。
- **读回带沙箱**：图、音频、视频和 PDF 在页面里显示，其余的下载；非 PDF 响应带严格 CSP 沙箱头，按内容寻址缓存。
- **只增不改**：附件不随消息、任务、Artifact 或素材删除而删。

## 和谁打交道

- **频道**：发消息时核对带的附件都在，并对消息参与者暴露路径或附件引用。
- **媒体**：生图、语音与对白的结果及输入存为附件，媒体只记使用状态与配额。
- **Artifact**：网页的每一稿存成附件，版本记录指向其附件 ID。
- **素材库**：用户上传的、帮工拿回来的文件存成附件，按 id 认素材。
- **门（`Lan`）**：配对来的设备能 `GET` 附件。

## 为什么这样

- **附件自成一个概念，字节实现收在领域包内部**：媒体的结果、素材库、Artifact 都复用同一套内容寻址附件存储。
- **只有一处存字节**：Artifact 和媒体不各设一个按内容寻址的目录，避免同一份文件重复落盘或删除时引用计数失步。

## 怎么验证

- `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./internal/domain/attachment/... ./internal/domain/gateway/...`：同键去重、流式落盘与失败清理、`GET /api/v1/attachment/<id>` 的类型、沙箱头与超限拒绝。
- `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./internal/domain/media/... ./internal/domain/artifact/...`：经附件接入的媒体输入与网页 Artifact 稿件测试。
