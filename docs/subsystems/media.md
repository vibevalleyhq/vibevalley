# 媒体与素材库

`Media` 服务管理生图、图片／视频理解、单人语音、多人对白、音色设计与克隆、长音频转写，以及集中展示生成结果、用户上传与帮工取回文件的[素材库](#素材库)（表 `media_library_item`，页面 `/library`）。用户在[AI 服务](docs/subsystems/provider.md)分别绑定连接与模型；任务先落库，页面通过同一状态流观察进度；生成的表单收在 `/library` 的「生成」对话框里，完成的结果自动记入素材库，`library.*` 接口和 `library_item_*` 工具由 `Media` 的 `libraryItems`、`addLibraryItem`、`removeLibraryItem`、`previewRemoveLibraryItem` 回答。结果保留实际格式、元数据与厂商用量；实时 Live 与独立 Vision 的设备和会话归[语音](docs/subsystems/voice.md)。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 媒体任务去重、排队、生成与下载的独立状态、重启恢复，以及最近任务的核心状态投影 | 连接与密钥（[AI 服务](docs/subsystems/provider.md)、[设置和配置](docs/subsystems/setting.md)） |
| 本机输入暂存、配额回收、远端文件记录，以及下载地址、公网目标、时间、字节和媒体格式校验 | 厂商媒体协议与参数（`packages/provider`） |
| 素材库（`media_library_item`）：每个附件至多一条，记首次来路（任务生成、上传或聊天发出、帮工/助手交来），以及帮工网址公网下载 | 文件的字节、名字和类型存储（[附件](docs/subsystems/attachment.md)）；帮工工作目录路径边界检查（`Session.workFile`，[帮工](docs/subsystems/session.md)） |
| `/library` 页面：三栏筛选、按比例缩略图、详情栏、搜索排序、拖拽/粘贴上传、键盘导航、生成与理解对话框 | 发到频道的消息存储与广播（[频道](docs/subsystems/channel.md)） |

任务共用 `MediaJob` 联合类型与最近任务投影。多人对白的接口为 `media.dialogue.create`，助手工具为 `media_dialogue_create`，内部绑定与任务种类为 `speakers`。没有图片编辑、局部重绘或视频生成。素材库不收通话和听写的录音、摄像头和屏幕的画面、头像、Artifact（有自己的页面）以及帮工改的代码。

## 在哪

| 位置 | 职责 |
|---|---|
| `packages/provider/src/moss/image.ts` | 固定端点、参数与布局校验、URL 响应、安全错误 |
| `packages/protocol/src/media/`、`packages/protocol/src/library/` | 媒体任务、输入与素材库（`LibraryItem`、`LibraryOrigin`、`LibraryListRequest`、`LibraryAddRequest`）形状、Schema 与接口权限 |
| `apps/server/src/modules/media/` | `Media` 服务：任务、下载、文件校验与素材库 |
| `apps/server/src/modules/media/library.ts`、`apps/server/db/queries/media_library_item.sql` | `Media` 的 `libraryItems`、`addLibraryItem`、`removeLibraryItem`、`previewRemoveLibraryItem`；听核心状态变化记下生成结果与聊天附件；表 `media_library_item` 查询 |
| `apps/server/src/gateway/http/handlers/library.ts`、`apps/server/src/modules/tool/library.ts` | `library.item.*` 接口；助手和帮工的 `library_item_add`、`library_item_list` 工具 |
| `apps/server/src/infra/publicHttp.ts` | 只拨号已校验公网 IPv4 的独立 HTTP 客户端 |
| `apps/server/src/modules/media/machine.ts`、`job.ts`、`apps/server/db/queries/media_job.sql` | 所有种类共用的一台任务机：表 `media_job`（按 `kind` 分）、收任务、锁、执行槽、跑断了记未知、下载结果存成附件、跟厂商任务、取消、重取、接续、重启；查询除音频的远端清理外都是共用的 |
| `apps/server/src/modules/media/image.ts` | 生图：请求、出图后存成附件、发回请它画图的频道 |
| `apps/server/src/modules/media/understanding.ts` | 理解的授权核对、输入保留、持久化、恢复与清理 |
| `apps/server/src/modules/media/speech.ts`、`speechStream.ts`、`audioResult.ts` | 单人语音、Flash 流式、构建期注入依赖端口的音频下载与落盘 |
| `apps/server/src/modules/media/audio.ts`、`transcriptionStream.ts` | 多人对白、音色设计／克隆、长转写与异步恢复 |
| `apps/server/src/modules/media/input.ts`、`inputs.ts` | 流式输入校验、上传中的槽位与生成配额预留（暂存文件是 `AsyncDisposable`，`await using` 释放）、任务保留与本机回收 |
| `apps/server/db/queries/media_input.sql`、`media_input_pin.sql` | 输入、删除标记与任务保留记录 |
| `apps/server/src/gateway/http/media.ts` | 本机专用的二进制上传入口 |
| `apps/server/src/modules/tool/media.ts` | 助手调用同一 `Media` 服务 |
| `apps/web/src/features/library/` | `/library`：`Rail.tsx` 筛选栏、`Tiles.tsx` 缩略图、`Inspector.tsx` 详情栏、`LibraryPage.tsx` 工具条、上传、键盘和对话框（`?make=` 生成，`?understand=<附件 id>` 理解）；排法、计数、筛选和键盘落点在 `items.ts` 纯函数 |
| `apps/web/src/features/media/` | 素材库「生成」对话框里的表单（生图、单人语音、音频工作台）与理解面板：任务、预览、保存与频道发布 |

Media 在 Collaboration 中、Channel 之后组装；启动时在频道恢复后恢复任务。HTTP handler 只转发，接口权限见[接口清单](docs/reference/capabilities.md)（`media.*`、`library.*`）。生图、语音及任务读取对 `user` 与 `orchestrator` 开放，remote 和帮工没有生成权限；助手只有承接用户输入的一轮才能生成，自主巡查不能生成。理解的直接发起、授权登记及清理仅对 `user` 开放；助手只能按已授权任务 ID 执行，模型不能自报上传许可或文件路径。

## 模型和不变量

- **同一请求不重新生成**：调用者给出 1–80 位字母、数字、下划线或连字符的 ID。同一 ID、参数与调用来源返回原任务，参数或来源不同则拒绝。浏览器重试保持 ID 与参数；修改输入或再次生成须明确新建。
- **一个 id 是一个任务**：各种任务在同一张表 `media_job`，按 `kind` 分；同一个 id 已是别种任务就拒绝。各种代码读行时只认自己的种类和自己有的阶段，别的当不是自己的。
- **一台任务机，各种类只交不同的部分**（`machine.ts` 的 `JobKind`）：收任务（同 id 同参数是原任务，否则拒绝；八项在途上限）、改行（只从期望的阶段往下走，全在一把锁里）、一个执行槽、跑断了记未知、下载并存下结果、按三秒一次跟厂商任务（最长半小时，之后暂停）、取消、重取下载、接续、重启都只写一遍。各种类交的是：怎么看（`view`）、怎么存下厂商做出的东西（`keep`）、厂商任务完成后变成什么（`task`）、自己的话（`words`），以及几处钩子：生图下载后发回频道、音频每轮之后和取消后清理上传到厂商的文件、理解取消或重启时放掉未开始任务的输入。每种怎么向厂商发请求（生图、同步／异步／流式语音、克隆、流式转写、理解的上传和授权）仍在各自的文件里。
- **先落库再发出**：任务保存连接 ID、配置 revision、完整模型 ID、参数和阶段；Key 只留在排队任务的内存快照。直接发起的任务不因改连接而换账号；委托理解在执行及排队后上传前再次核对授权。任务登记与本机工作任务注册在同一临界区内，不因浏览器断开留下未启动的排队任务。
- **来源由服务端确认**：HTTP 入口记为用户；助手工具从执行上下文取档案、频道与用户委托，不接受模型自报身份。来源随任务落库并进入公共投影，重启保留；任务的来源频道不等于图片后来发布的目标频道。
- **只记录厂商报告的用量**：成功响应的图片数和输出尺寸随签名 URL 一起落库，下载失败、重试和重启保留。未收到用量时省略该字段，页面明确未知不代表未计费，不猜价格或填零。
- **有界并发**：媒体任务共用一个执行槽和八个在途名额；等待助手执行的授权也占名额。数据库保留历史，状态流只带最近 100 条。
- **生成与下载分开**：取得签名 URL 后先存到任务私有字段，再下载。URL 不进入公共任务、帧或工具结果；保存完成后清掉 URL。失败时可单独重试下载，不再次提交生成。
- **未知不重做**：厂商响应不完整、超时或网络错误可能已经计费，记为 `unknown`。重启取消未发出的 `queued`；没有远端任务 ID 的生成及中断的流式请求记为未知。已保存远端任务 ID 的异步任务恢复状态查询，已取得 URL 的任务恢复下载，都不重新提交生成。
- **取消不承诺停计费**：取消改变本机状态并中断对应工作，不代表厂商停止。旧工作的取消不能中断之后明确重试的下载。
- **可用意味着落盘**：小音频与图片经 `Attachment.attach` 存成附件；超过附件上限的音频由 Media 输入存储持有，不强塞 Base64 附件。内容以 SHA256 寻址，完整写临时文件后原子发布，取消或写失败不暴露半文件。
- **页面不折事实**：每次状态变化由 `Core.apply(mediaChanged)` 投影；`phaseText`、可取消和可重试下载均由服务端给出。页面不在本地猜任务是否完成。

**助手在频道里生的图自动发回。** 用户在频道里打 `/imagegen <描述>`，页面把这一行带 `to`（这里的助手）发出去，只交给这个助手；助手读自带的 `imagegen` skill（`apps/server/src/modules/orchestrator/skills/imagegen/SKILL.md`，随服务端打包），调 `media.image.create`。来源是助手、带来源频道的生图任务下载完成后，Media 以那个助手的名义用 `channel.post({ _tag: "Announce" })` 在来源频道发一条带图的消息，`sendKey` 为 `media:<任务 id>`，重试与重启只发一次；用户在本页发起的任务不自动发。

发布沿用 Channel 接口与附件 ID。页面用命名空间、任务 ID、目标频道的 JSON 元组计算 SHA256，作为 64 字符的 `sendKey`；刷新后再次发布到同一频道不会多发一条，不同频道各有自己的发布。Artifact 引用同一个本机附件地址，不复制资产。

## 本机输入

`media.input.create` 校验名称、MIME、用途与声明大小，返回服务端生成的输入 ID；它只预留本机空间，不读取服务器上的任意路径、不联系厂商。用户随后 `PUT /api/v1/media/input/:id/content`，请求类型为 `application/octet-stream`，正文直接流式落盘，不经频道的 Base64 JSON。`media.input.adopt` 把一个已有的附件（素材库的一条）当作输入，字节照上传一样核对，落在同一个输入上。`media.input.get/list/delete` 查询、列出和删除输入；`media.input.previewDelete` 只预览，供 CLI 的 `--dry-run` 使用。这些 JSON 接口与二进制上传都只给本机用户，LAN 和 agent 工具不开放上传。

图片上限为 30,000,000 字节，视频为 200,000,000 字节。支持 PNG、JPEG、WebP、GIF、BMP、TIFF，以及 MP4、M4V、MOV、AVI、WebM、MKV 的容器签名；音频接受 WAV、MP3、M4A、FLAC、Ogg 和 WebM，按用途核对格式与时长。容器签名不代表完整解码成功。上传核对声明与实际字节数，计算 SHA256；流式暂存限时 300 秒，最多同时八路。输入以 `0600` 权限写入附件存储下的暂存目录（`attachments/staging/media/`），完整写完后才经 `Attachment.keepStaged` 改名成为附件（[附件](docs/subsystems/attachment.md)），不把私有路径返回给页面；输入的 `hash` 就是附件的 id。相同内容共用一个附件，不共用输入 ID；再次上传已经就绪的 ID 返回原结果，不改内容。

PCM WAV 的元数据警告会转入 RIFF 结构校验：容器长度、chunk 边界与填充、`fmt` 与 `data` 的采样布局都需匹配；合法的附加元数据不构成拒绝理由。

所有输入预留（包括失败的和被任务保留的）最多 256 条、按每条声明大小保守计入 2 GiB 配额；相同内容也各占一条预留。未保留的预留和文件在 24 小时后回收，每分钟检查一次，接受新预留前也先回收。删除先落 `deleting` 标记，再清它的暂存文件，最后删记录；附件的字节不删，别处可能也在用。删除失败保留标记供下次检查恢复。断线、取消和失败会关闭写入并清理临时文件；未能清理的部分文件归原输入 ID，预留继续占配额，清理成功前不能再次接收文件或删掉预留。发布前先记录预期哈希，数据库拒绝提交且文件回滚也失败时，完整文件同样仍有所属预留。一个输入的回收失败不阻塞其余输入。本机上传可以明确重试，和可能计费的厂商调用不是同一种重试。

任务保留输入与任务登记可以在同一事务内完成；被保留的输入不按期限删除，也不能由用户单独删除。只有对应的保留者可以取得磁盘支持的 Blob，读取前流式核对大小和哈希，不把大文件转为 ArrayBuffer。文件丢失或内容损坏时标失败；修复只接受原内容，新内容必须新建输入。重复内容的发布也检查已有文件，损坏时用已核对的完整临时文件原子替换，不覆盖仍然完整的文件。

重启把未结束的本机上传记为失败，清除暂存目录和没有记录引用的哈希文件；丢失文件的就绪记录改为失败。它不会自动重新读取用户的原始文件，更不会重传给厂商。理解任务登记与输入保留在同一个事务中完成。

### 远端文件记录

`media/remoteFiles.ts` 管上传与删除记录，不直接对用户开放接口。调用方必须已保留本机输入；上传前取得经过完整性核对的磁盘 Blob，并先把意图写入 `media_remote_file`，再发出一次上传请求。文件名用服务端随机 ID 加格式后缀，不把用户的原始文件名发给厂商。同一任务最多五份输入，重复请求只返回已记录的文件 ID，不重复上传；拒绝、未知和已结束的上传也不能用同一个任务重新提交。

记录包括连接 ID、配置版本、凭据的 SHA256 等值指纹、内容哈希和厂商文件 ID，不保存第二份明文 Key，也不进入公共任务或 Core。恢复时经 `Provider.account` 按原连接 ID 重新绑定仍启用的账号（交出凭据指纹和封着 Key 的调用，不交出 Key），不跟随当前用途的默认连接；连接或指纹不一致则在请求前拒绝。其他配置导致版本递增、但原连接和 Key 都没有变化时，可以继续清理。

取消、超时或重启中的上传记为未知，不自动重传。删除先记 `deleting`，成功回执或同一账号下的 404 才记已删除；失败保留记录，允许明确重试。重启不自行联系厂商。没有取得文件 ID 的未知上传不能盲目删除账号中的其他文件。远端记录独立于本机输入的寿命，删本机输入不会顺带抹掉远端清理依据。上传回执只有 `processed` 或 `active` 才允许随后推理；`failed` 拒绝，未识别的状态保守记为未知。即使状态不适合推理，已取得的文件 ID 仍保留，清理时必须真的删除，不把失败回执当成没有文件。

### 理解任务

`media.understanding.create` 只接受本机输入 ID、问题、输出上限和明确的上传许可，不接受服务器路径或任意远端文件 ID。许可携带页面显示的连接 ID 与配置 revision，服务端在登记前核对当前绑定；页面的勾选也绑定这份快照，连接变化不沿用旧许可。只允许最多五张图片或一个视频，不混传；不合规则不登记任务、不发厂商请求。

媒体任务共用 ID 空间、八项在途上限和一个执行槽。理解把问题、输入名称与哈希快照、连接、模型和 revision 落库，再顺序上传已保留的输入；排队时的 Key 只在内存中冻结。同一 ID 与参数只返回原任务，参数不同或与其他任务 ID 冲突则拒绝。

阶段为等待助手执行、排队、上传、理解、完成、截断、失败、未知或取消。收到结果后先保存正文、供应商回报的模型和 token 用量，再清理已知远端文件并释放输入保留。`incomplete` 保留正文，不改写成成功，不自动追加请求补完。重启取消授权中及未发出的排队任务并释放其输入；上传或理解中的任务记为未知，不重传或重新推理；清理中断则保留结果并标为需要处理。

取消先记录本机状态，再中断对应工作；它不承诺供应商停止。尚未发出的授权或排队任务立即释放本机保留；已经发出后的失败、未知和取消保留文件，直到用户明确执行 `media.understanding.cleanup`，`previewCleanup` 仅列出影响、供 `--dry-run` 使用。清理只按原账号与凭据指纹操作，换 Key 后不借用新账号；失败可再点清理，只重试删除，不重做理解。没有 ID 的上传不盲删：释放本机保留，显示无法确认的随机文件名，供用户在供应商后台核对。页面切换会中止尚未完成的本机传输，已登记的服务端任务不因此重发。

### 委托助手理解

页面可选择直接执行，或选择授权频道后登记 `media.understanding.authorize`。登记冻结输入哈希、问题、输出上限、账号、revision、模型与 Key 的等值指纹，保留输入但不联系厂商；有效期为 15 分钟。公共任务只暴露频道与到期时间，不暴露指纹。用户再点「发送给助手」，向该频道发送带稳定 `sendKey` 的请求；登记本身不自动唤醒助手。

`media.understanding.start` 只收任务 ID。服务端从工具上下文核对承接用户请求、频道及助手档案，开始后记录真实来源；HTTP 用户入口和自主巡查均不能绕过它。账号、模型、revision 或凭据变动、授权过期会阻止上传；排队取得执行槽后再检查一次。重复执行只返回同一任务，其他档案不能借同一个 ID 改写来源。撤销、过期及重启使尚未执行的授权失效并释放输入，过期扫描每分钟运行。

## 音频任务

单人语音使用独立 `speech` 绑定，支持 Flash 同步／流式与 Pro 同步／异步。请求固定 ID、文字、音色、连接与 revision；提交答复丢失时仍沿用原请求，不能用新账号或新 ID 偷偷重合成。音频输出格式是闭集：WAV、MP3、FLAC、AAC、Opus、PCM；具体模型和模式的组合由协议校验。结果的格式、MIME、时长、采样率、声道和厂商用量按实际回执与文件保存，不把请求的格式当成事实。例如请求 FLAC 而厂商报告 WAV 时，保存 WAV，不改后缀冒充 FLAC；缺失用量不记零。

Flash 流式由服务端请求厂商 SSE，从元数据与 PCM 分片生成有序音频事件；浏览器显式启动 WebAudio 播放，慢消费者的队列有界。单次流限时 5 分钟、音频不超过 128 MiB，完整帧保存成 WAV。失败或取消仍保留已收到的可保存音频，标明部分结果，不冒充完整成功；刷新读取保存的结果，不重开厂商流。停止、离开或设备故障会中断当前 Flash 流、取消原任务并释放播放资源；已保存音频的普通播放器停止不重新提交任务。

异步任务先保存厂商任务 ID，再查询状态。只有状态 GET 对暂时网络、超时、429 与 5xx 做有界退避；提交 POST 不重试。轮询暂停后，`media.speech.resume`／`media.audio.resume` 只恢复原任务查询，`retryDownload` 只重取已有结果。恢复、清理均核对原连接与凭据指纹；改绑用途不会切换旧任务账号，换 Key 后拒绝借新凭据接续。

### 多人对白与音色

多人对白接受结构化说话人表（ID 与音色）及有序台词段（说话人 ID 与文本），拒绝重复 ID、缺失引用等无效组合，不从自由文本猜角色。结果沿用音频下载、播放、保存和发布路径。

音色设计使用独立 `voiceDesign` 绑定，输入描述与试听文字，异步生成预览。符合克隆输入限制的预览保留为本机输入；「保存为音色」是另一次明确的克隆请求，不在试听完成后自动创建音色。克隆按请求指定的连接与 revision 执行，必须显式 `consent: true`，核对本机样本为 WAV／MP3／M4A／FLAC、最多 10,000,000 字节、30 秒。页面的许可随输入与账号变化失效；列表和创建结果不能跨账号复用。MOSS 没有官方音色 DELETE 接口，本机资产释放不代表删除厂商音色。

### 长音频转写

`transcription` 独立绑定长转写模型，与输入框听写分开。用户上传本机音频、确认上传，选择支持的说话人区分与热词；服务端核对音频最长 3600 秒，再上传并发起异步任务。Diarize Pro 可用 SSE，逐步保存文本、带说话人与起止时间的分段及实际用量；正文上限 1,000,000 字符、分段上限 10,000。中断保留检查点，不自动续流或补写。页面显示分段，点击时间定位原音频，可把转写另存为 Artifact。

### 资源所有权

音频结果、设计预览和转写原音频由任务保留；任务完成不等于释放本机文件。用户通过 `media.job.previewRelease` 预览、`media.job.release` 明确释放，释放后不能继续下载恢复或用旧预览创建音色。任务文字、用量和已保存频道附件保留，其他任务仍引用的输入不能误删。远端文件删除独立记账，失败可只重试清理；本机释放不抹掉远端清理记录，也不承诺终止厂商计费。

## 下载边界

下载只接受 HTTPS、默认或 443 端口、无用户名密码的 URL，不带厂商认证头，不跟随重定向。专用 socket lookup 校验 DNS 返回的全部 IPv4 地址，并把已校验地址直接交给连接，不再次解析；本机、私网、链路本地、云元数据、共享地址、文档和保留地址段均拒绝。当前不支持 IPv6 结果下载。

代理或 DNS 将结果域名解析为 `198.18.0.0/15`（fake-IP／基准测试网段）时同样拒绝；`img.mosi.cn` 也没有例外。运维应在隔离验收环境关闭该域名的 fake-IP，或使用经过核实、返回真实公网地址的 DNS，再单独重试已有结果下载。不得放行保留地址、绕过全部地址校验或重新提交生成。

响应必须为 200 与 `image/png`，60 秒覆盖读取，最多 25 MiB。校验 PNG 签名、chunk CRC、IHDR 尺寸与格式、完整结尾、解压长度和行过滤字节；解压上限 32 MiB，当前拒绝隔行 PNG。下载或保存失败显示可单独重试，不把错误正文、认证头或签名 URL 展示给用户。

音频下载沿用相同公网边界，限时 300 秒、最多 512,000,000 字节，MIME 与厂商报告的实际格式匹配。按格式检查容器、帧与元数据；裸 PCM 不凭空猜采样率。小结果成为频道附件，大结果留在 Media 输入存储。格式不符、截断或错误正文不能成为完整成功附件；浏览器是否支持该编码仍需实际解码与播放，不能只看后缀。

## 素材库

素材库（`apps/server/src/modules/media/library.ts`，页面 `/library`）把用户关心的文件放在一处：生成的、用户上传的、帮工和助手拿回来的。一份素材是一个[附件](docs/subsystems/attachment.md)加上它的来路。页面照 Eagle 那样分三栏：左边按来路和种类筛，中间是按比例排满一行的缩略图，右边是选中的那一份；生成的表单收在「生成」对话框里，理解从选中的那一份发起。

- **一份文件一张卡**：主键是附件的 id（内容的 SHA-256）。同一份字节再来只更新 `last_at`，来路照第一次的；生成的那条的时间不再变。
- **来路是封闭的联合**（`LibraryOrigin`，按 `kind`）：
  - `generated`：媒体任务的 id 和种类；任务 `ready` 拿到附件时记，开机时按核心状态里已有的任务补齐。
  - `uploaded`：用户在聊天里发出带附件的话（记频道和消息），或在这页上传（两样都没有）。这页的上传是 `attachment.create` 再 `library.item.add({ attachment })`。
  - `fetched`：哪个档案、哪个帮工（会话）、从哪个网址或工作目录里的哪个文件。
- **谁能给什么**：`library.item.add` 只收一种来源。经 HTTP 来的是用户，只能给已上传的附件；助手的工具只给网址，帮工的给网址或路径。网址只走公网 https（`PublicHttp`），最大 `attachmentMax`（25 MB），60 秒；路径解析了符号链接以后仍要在工作目录里（`Session.workFile`）。
- **拿掉只删这一条**：`library.item.delete` 不删附件，发过它的消息照样能打开。
- **进行中任务与理解结果实时对齐**：在做的生成任务读核心状态的 `media`，排在最前（麦色的虚线格）；完成的任务数一变，页面重读列表。详情栏显示这份文件最新一次理解的结果（任务的输入哈希就是附件 id）。
- **搜和排在服务端，筛和数在页面**：`library.item.list` 的 `text` 按名字找（不分大小写），`sort` 是 `recent`（默认）、`name`、`size`；左栏的两组各按另一组选中的那项数（`countsOf`），来自频道、来自帮工两组照列表里出现的列出。
- **一页只有一条栏**：壳子的页头在 `/library` 不画（和聊天一样，`app/Shell.tsx`），工具条（搜索、排序、缩略图大小、上传、生成）就是页头，66px 高。连接 AI 的入口只在生成被挡住时出现（各表单自己的提示）。
- **缩略图按比例排满一行**（`justify`）：每行缩放到正好占满宽度，最后一行保持目标高度；比例夹在 1:2 到 3:1。缩略图的高度每个看的人自己记（`prefs` 的 `libraryTile`，96–280px）。每格按附件 id 绝对定位，排法变了格子不重建，图不会重载。图、视频的比例和像素、音频和视频的时长在它们加载后从元素上读。
- **选和键盘**：点一下选一个，⌘/Ctrl 点加减，Shift 点选一段；← → 按顺序走，↑ ↓ 去上下一行中间最近的那格（`neighbor`）；空格全屏看（`Lightbox`，← → 翻）；Delete 在详情栏里原地问一遍再拿掉；Esc 不选。文件拖到页面上或粘贴进来就上传。
- **手机宽**（40rem 以下）：工具条在最上，筛选栏变成两个选择框（来路、种类），详情栏是从底下出来的面板。

**素材库流转**

1. 用户在「生成」对话框里生图或合成语音；任务完成，`Media` 记一条 `generated`，网格里出现这张卡。
2. 用户在聊天里发一张图，或在这页点「上传」；各记一条 `uploaded`。
3. 帮工做活时调 `library_item_add`，给一个网址或 `out/report.png`；服务端取到字节，记一条 `fetched`。
4. 用户选中一张图或视频，在详情栏点「理解」：`media.input.adopt` 把附件当作输入（照上传一样检查），再发起理解；结果挂在卡上。

## 和谁打交道

- **核心状态（`core`）**：任务状态变化经 `Core.apply(mediaChanged)` 发布；素材库监听 `Core.transitions` 的 `mediaChanged` 与 `messageChanged` 自动登记完成任务与聊天附件。
- **AI 服务（`provider`）**：取各用途冻结的账号快照、模型与封着 Key 的调用。
- **附件（`attachment`）**：经 `attach`、`keepStaged` 存任务结果、上传输入与帮工取回的字节，按 id 读回附件信息。
- **频道与帮工（`channel`、`session`）**：助手触发的生图完成后经 `Channel.post({ _tag: "Announce" })` 发回来源频道；帮工按路径交素材时经 `Session.workFile` 读取工作目录内文件。

## 为什么这样

- **一台共用任务机承载全部媒体种类**：排队去重、单执行槽、阶段单向迁移、未知状态保护和独立下载重试在 `media/machine.ts` 写一次，各媒体种类只提供厂商请求与结果解析，避免生图、语音、理解和转写各自维护状态机。
- **频道 `/imagegen` 经 `SayRequest.to` 交助手，出图后由 Media 直接发回**：页面不直接调 `media.image.create`（保留助手 `imagegen` skill 的提示词扩写与比例选择），服务端也不解析正文里的斜杠技能名；下载完成那一刻在 Media 内经 `channel.post({ _tag: "Announce" })`（`sendKey: media:<id>`）发回来源频道，免去助手轮询等待。
- **素材库与媒体合在一个模块，一个附件加来路而非给附件加字段**：素材库是媒体产出与外部收进文件的同一份目录，合在 `Media` 内省去薄透传模块；同时同一份字节可以既是生成的又被人发过，附件只管「这是什么文件」，来路记在 `media_library_item`。
- **不直接列所有附件，删卡片不删附件**：生成结果和素材页直接上传都没有消息可推来路；从素材库拿掉一张卡也不应删掉附件字节或破坏发过它的消息。
- **帮工给网址或路径，不传字节；页面以素材为主、工具收进对话框**：在 MCP 里传大段 base64 费 token 且易截断，由服务端拉取或读工作目录更稳妥；平时在聊天里让助手生成，页面聚焦浏览与复用素材。

## 怎么验证

- `packages/provider/src/moss/image.test.ts`：固定端点、模型与参数、布局、响应、未知结果和安全错误。
- `apps/server/src/modules/media/media.test.ts`、`library.test.ts`：去重、来源与用量的持久化和投影、磁盘失败后的独立下载、提交者断线、取消与重试竞争、排队后换 Key、容量、未知结果与重启恢复；素材库三种来路、去重、筛选、拿掉不删附件，以及内网/`file:` 地址与越权来源拒绝。
- `apps/server/src/flows/media.test.ts`、`apps/server/src/gateway/mcp/mcp.test.ts`：脚本模型经真实工具生成图片、执行限时理解授权、合成语音并读取同一任务结果，自主巡查被拒绝；帮工经工具按路径放文件进素材库，工作目录外路径与逃逸符号链接被拒。
- `apps/server/src/modules/media/download.test.ts`、`infra/publicHttp.test.ts`、`infra/files.test.ts`：PNG 校验、不跟随跳转、无凭据下载、超时、地址与实际拨号检查；中断写入不暴露半文件，并发发布和已有文件不覆盖。
- `apps/server/src/modules/media/input.test.ts`、`inputs.test.ts`：分块签名、字节上限、磁盘失败、取消、配额竞争、引用事务、过期回收、删除恢复、真实数据库拒绝提交后的文件回滚、缺失或损坏输入的核对和修复，以及把素材库附件当作理解输入时拦截非图/视频/音频类型。
- `apps/server/src/gateway/http/media.test.ts`：真实本机 HTTP 上的输入预留、跨来源拒绝、二进制上传、26 MiB 流式容器传输与断线重试；大文件样例只验证传输和容器头，不代表视频解码或理解验收。
- `apps/web/src/features/library/items.test.ts`、`apps/web/test/library.spec.ts`、`narrow.spec.ts`：种类、筛选和两组计数、按比例排满一行、方向键落点、Shift 选一段、扩展名和时长、在做的任务与理解结果；选文件和拖拽上传、按来路和种类筛、发到频道、Delete 原地确认拿掉（带一次 axe）及 400px 窄屏不出界。
- `apps/web/test/media.spec.ts`：真实隔离服务端上的文本与布局生成、状态流、PNG 预览和下载、频道去重发布、Artifact 引用、未知结果、取消、独立下载重试与表单拒绝。只由 `apps/server/src/testing/network.ts` 替换厂商请求与结果下载，任务、数据库、附件和 Core 都是真的；测试程序不读取用户的 Key、不访问厂商。
- `apps/server/src/modules/media/understanding.test.ts`、`apps/web/test/understanding.spec.ts`：授权版本、跨类型 ID 冲突、上传状态、结果与用量、共享容量、取消、清理预览与重试、换 Key、清理断线、重启恢复及委托理解边界；合成 PNG 与可解码 MP4 的真实本机上传、从素材库详情栏发起理解并写回结果、Artifact 保存、刷新、截断、未知与取消。厂商传输仍是替身，不验证实际识别质量。
- `apps/server/src/modules/media/speech.test.ts`、`audio.test.ts`、`audioResult.test.ts`、`release.test.ts`：同步／异步、实际格式与用量、流式部分结果、账号隔离、恢复、下载与显式资源释放。
- `apps/web/test/speech.spec.ts`、`flash.spec.ts`、`audio.spec.ts`：音频解码播放、流式播放、结构化对白、设计预览与克隆许可、转写分段定位与 Artifact 保存，以及刷新和播放器释放。
- `apps/web/test/a11y.spec.ts`：表单及成功、失败、截断、未知、取消状态的浅深主题、桌面与窄屏检查。开发版同时检查响应式诊断；共享浮层只在打开时读取选中项的快照，值后来变化不抢焦点，`packages/base-ui/test/select.test.tsx` 覆盖这个回归。

`apps/server/src/modules/media/remoteFiles.test.ts` 验证真实磁盘 Blob 经厂商协议替身上传、并发去重、凭据隔离、未知结果、重启及显式删除重试；它不代表真实厂商文件操作已经验收。

真实厂商、真实播放与宿主权限的验收方法见[媒体验收](.agents/skills/vv-acceptance/references/media.md)。协议替身通过不代表真实账号、音色克隆或设备已验收。
