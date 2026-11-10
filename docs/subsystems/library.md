# 素材库

「素材库」（`Library`，`apps/server/src/library/library.ts`，页面 `/library`）把用户关心的文件放在一处：生成的、用户上传的、帮工和助手拿回来的。一份素材是一个[附件](docs/subsystems/attachment.md)加上它的来路；生成的表单收在页面的「生成」对话框里，理解从一张卡发起。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 表 `library_item`：每个附件至多一条，记第一次的来路、加入和最近一次的时间 | 文件的字节、名字和类型（[附件](docs/subsystems/attachment.md)、[存储](docs/subsystems/storage.md)） |
| 记下三种来路：任务做完的结果、用户在聊天里发的和在这页上传的、帮工和助手经 `library.item.add` 交来的 | 生成、理解任务本身（[媒体](docs/subsystems/media.md)） |
| 帮工给的网址经公网下载、给的路径只认它工作目录里的文件 | 读帮工工作目录的检查（`Session.workFile`，[帮工](docs/subsystems/session.md)） |
| 页面：网格、按来路和种类筛、下载、发到频道、拿掉、生成对话框、理解对话框 | 发到频道的消息（[频道](docs/subsystems/channel.md)） |

不收：通话和听写的录音、摄像头和屏幕的画面、头像、Artifact（有自己的页面）、帮工改的代码。

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/library/library.ts` | 服务 `Library`：`list`、`add`、`delete`；听核心状态的变化记下生成的和聊天里发的 |
| `apps/server/src/http/handlers/library.ts`、`apps/server/src/tool/library.ts` | `library.item.*` 接口；助手和帮工的 `library_item_add`、`library_item_list` 工具 |
| `packages/protocol/src/library/` | `LibraryItem`、`LibraryOrigin`、`LibraryListRequest`、`LibraryAddRequest` |
| `apps/server/db/queries/library_item.sql` | 表 `library_item` 的查询 |
| `apps/web/src/features/library/` | `/library`：网格与卡片、筛选（`items.ts` 的纯函数）、上传、`?make=` 的生成对话框、`?understand=<附件 id>` 的理解对话框 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`library.*`）。

## 模型和不变量

- **一份文件一张卡**：主键是附件的 id（内容的 SHA-256）。同一份字节再来只更新 `last_at`，来路照第一次的；生成的那条的时间不再变。
- **来路是封闭的联合**（`LibraryOrigin`，按 `kind`）：
  - `generated`：媒体任务的 id 和种类；任务 `ready` 拿到附件时记，开机时按核心状态里已有的任务补齐。
  - `uploaded`：用户在聊天里发出带附件的话（记频道和消息），或在这页上传（两样都没有）。这页的上传是 `attachment.create` 再 `library.item.add({ attachment })`。
  - `fetched`：哪个档案、哪个帮工（会话）、从哪个网址或工作目录里的哪个文件。
- **谁能给什么**：`library.item.add` 只收一种来源。经 HTTP 来的是用户，只能给已上传的附件；助手的工具只给网址，帮工的给网址或路径。网址只走公网 https（`PublicHttp`），最大 `attachmentMax`（25 MB），60 秒；路径解析了符号链接以后仍要在工作目录里。
- **拿掉只删这一条**：`library.item.delete` 不删附件，发过它的消息照样能打开。
- **页面不折事实**：在做的生成任务读核心状态的 `media`，排在网格最前；完成的任务数一变，页面重读列表。卡上显示这份文件最新一次理解的结果（任务的输入哈希就是附件 id）。

## 怎么走

1. 用户在「生成」对话框里生图或合成语音；任务完成，Library 记一条 `generated`，网格里出现这张卡。
2. 用户在聊天里发一张图，或在这页点「上传」；各记一条 `uploaded`。
3. 帮工做活时调 `library_item_add`，给一个网址或 `out/report.png`；服务端取到字节，记一条 `fetched`。
4. 用户在一张图或视频的卡上点「理解」：`media.input.adopt` 把附件当作输入（照上传一样检查），再发起理解；结果挂在卡上。

## 和谁打交道

- **核心状态（`Core.transitions`）**：`mediaChanged` 带着完成的任务，`messageChanged` 带着用户发的附件。
- **附件（`Attachment`）**：存帮工交来的字节，按 id 读回附件的信息。
- **帮工（`Session.workFile`）**：读帮工工作目录里的文件。
- **媒体**：`media.input.adopt` 从附件建理解的输入；页面的生成对话框用媒体的表单。

## 为什么这样

- **一个附件加来路，而不是给附件加字段**：同一份字节可以既是生成的又被人发过；附件只管「这是什么文件」，来路是素材库的事。
- **不直接列所有附件**：生成的结果和这页的上传都没有消息可推来路；拿掉一张卡也不该删附件或改消息。
- **帮工给网址或路径，不传字节**：在 MCP 里传大段 base64 费 token、容易截断；由服务端去取，也更好查。
- **页面以素材为主，工具收进对话框**：用户关心生成的和拿回来的东西本身；平时让助手在聊天里生成。

## 怎么验证

- `apps/server/src/library/library.test.ts`：三种来路、去重、筛选、拿掉不删附件；没有来源、两个来源、用户给网址、帮工给附件、内网和 `file:` 地址被拒。
- `apps/server/src/mcp/mcp.test.ts`：帮工经工具按路径放一个文件，工作目录外的路径和逃出去的符号链接被拒。
- `apps/server/src/media/inputs.test.ts`：附件当作理解的输入，不是图、视频、音频的被拒。
- `apps/web/src/features/library/items.test.ts`：种类、筛选、来路的说法、在做的任务、卡上的理解结果。
- `apps/web/test/library.spec.ts`：上传出现一张卡、按来路和种类筛、发到频道、拿掉，带一次 axe；`understanding.spec.ts` 从卡上发起理解，结果回到卡上。
