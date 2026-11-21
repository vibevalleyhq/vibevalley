# 媒体与素材库

媒体任务管生图、单人语音（含 Flash 流式）、多人对白、音色设计、音色克隆、长音频转写和图片／视频理解，以及集中展示生成结果、用户上传与帮工取回文件的[素材库](#素材库)（表 `media_library_item`，页面 `/library`）。用户在[AI 服务](docs/subsystems/provider.md)绑定连接与模型；任务先落库，页面通过同一状态流观察进度；生成的表单收在 `/library` 的「生成」对话框里，完成的结果自动记入素材库。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 媒体任务去重、排队、生成与下载的独立状态、重启恢复，以及最近任务的核心状态投影 | 连接与密钥（[AI 服务](docs/subsystems/provider.md)、[设置和配置](docs/subsystems/setting.md)） |
| 本机输入暂存、配额回收，以及下载地址、公网目标、时间、字节和媒体格式校验 | 文件的字节、名字和类型存储（[附件](docs/subsystems/attachment.md)） |
| 素材库（`media_library_item`）：每个附件至多一条，记首次来路（任务生成、上传或聊天发出、帮工/助手交来），以及帮工网址公网下载 | 发到频道的消息存储与广播（[频道](docs/subsystems/channel.md)） |
| `/library` 页面：三栏筛选、按比例缩略图、详情栏、搜索排序、拖拽/粘贴上传、键盘导航、生成对话框 | |

没有图片编辑、局部重绘或视频生成。素材库不收录音、摄像头和屏幕的画面、头像、Artifact（有自己的页面）以及帮工改的代码。

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-server/src/modules/media/jobs.rs` | 所有种类共用的一台任务机：表 `media_job`、收任务（八个在途）、按种类的执行槽、跑断了记未知、下载结果存成附件、跟厂商任务、取消、重取、释放、重启接续；生图与语音（含流式）两种 |
| `crates/vibevalley-server/src/modules/media/audio.rs` | 多人对白、音色设计、音色克隆、转写：各自向厂商要什么、怎么看，转写流边收边存，结束后删厂商那份上传 |
| `crates/vibevalley-server/src/modules/media/understanding.rs` | 图片／视频理解：上传、问一次、删上传；用户给助手的授权、到期与启动 |
| `crates/vibevalley-server/src/modules/media/remote.rs` | 任务传给厂商的文件：发出前先记在任务上，只由原账号删除 |
| `crates/vibevalley-server/src/modules/media/vendor.rs` | MOSS 的调用：每个请求经 `Fetch` 发出（测试替身照 MOSS 回答），不跟随重定向 |
| `crates/vibevalley-server/src/modules/media/image_provider.rs`、`png.rs`、`validate.rs` | 生图请求的准备与可取消执行、PNG 校验、请求与格式校验 |
| `crates/vibevalley-server/src/modules/media/inputs.rs` | 输入预留、上传、任务保留与回收 |
| `crates/vibevalley-server/src/public_http.rs` | 下载与素材导入共用的公网 https 规则 |
| `crates/vibevalley-server/src/modules/library.rs` | 素材库：`list`、`add`、`remove`、`preview_remove`；听事实记下生成结果与聊天附件 |
| `crates/vibevalley-http/src/media.rs` | 本机二进制上传（`PUT /api/v1/media/input/:id/content`）与带范围的播放、语音流 |
| `crates/vibevalley-server/src/modules/tool/notes.rs` | 助手与帮工的 `media_*`、`library_item_*` 工具 |
| `crates/vibevalley-server/src/offline.rs` | 测试用的离线 MOSS 与下载 |
| `crates/vibevalley-protocol/src/contract/media.rs`、`packages/protocol/src/media/` | 媒体任务、输入与素材库的形状和接口（Rust 为源，TS 形状由它生成） |
| `apps/mac/ui/vv/web/features/media/` | `/library`：筛选栏、缩略图、详情栏、工具条、上传、键盘和「生成」对话框；排法、计数、筛选和键盘落点在 `items.ts` 纯函数 |

接口权限见[接口清单](docs/reference/capabilities.md)（`media.*`、`library.*`）。生图、语音及任务读取对 `user` 与 `orchestrator` 开放，帮工没有生成权限；助手只有承接用户输入的一轮才能生成，自主巡查不能生成。

## 模型和不变量

- **同一请求不重新生成**：调用者给出 1–80 位字母、数字、下划线或连字符的 ID。同一 ID、参数与调用来源返回原任务，参数或来源不同则拒绝。浏览器重试保持 ID 与参数；修改输入或再次生成须明确新建。
- **一个 id 是一个任务**：各种任务在同一张表 `media_job`，按 `kind` 分；同一个 id 已是别种任务就拒绝。各种代码读行时只认自己的种类和自己有的阶段，别的当不是自己的。
- **一台任务机，各种类只交不同的部分**（`jobs.rs`）：收任务（同 id 同参数是原任务，否则拒绝；八项在途上限）、改行（只从期望的阶段往下走，全在一把锁里）、一个执行槽、跑断了记未知、下载并存下结果、按三秒一次跟厂商任务（最长半小时，之后暂停）、取消、重取下载、接续、重启都只写一遍。各种类只说怎么生成（`generate`）、怎么取回（`download`）和怎么看（`Record::view`）；执行槽按种类分：生图一个，其余各八个。怎么向厂商发请求在 `vendor.rs`。
- **先落库再发出**：任务保存连接 ID、配置 revision、完整模型 ID、参数和阶段；Key 只留在排队任务的内存快照。直接发起的任务不因改连接而换账号；不因浏览器断开留下未启动的排队任务。
- **来源由服务端确认**：HTTP 入口记为用户；助手工具从执行上下文取档案、频道与用户委托，不接受模型自报身份。来源随任务落库并进入公共投影，重启保留；任务的来源频道不等于图片后来发布的目标频道。
- **只记录厂商报告的用量**：成功响应的图片数和输出尺寸随签名 URL 一起落库，下载失败、重试和重启保留。未收到用量时省略该字段，页面明确未知不代表未计费，不猜价格或填零。
- **有界并发**：所有种类共用八个在途名额（等助手启动的理解授权也占一个）；生图一次跑一个，其余种类各至多八个；数据库保留历史，状态流只带最近 100 条。
- **生成与下载分开**：取得签名 URL 后先存到任务私有字段，再下载。URL 不进入公共任务、帧或工具结果；保存完成后清掉 URL。失败时可单独重试下载，不再次提交生成。
- **未知不重做**：厂商响应不完整、超时或网络错误可能已经计费，记为 `unknown`。重启取消未发出的 `queued`；没有远端任务 ID 的生成及中断的流式请求记为未知。已保存远端任务 ID 的异步任务恢复状态查询，已取得 URL 的任务恢复下载，都不重新提交生成。
- **取消不承诺停计费**：取消改变本机状态并中断对应工作，不代表厂商停止。旧工作的取消不能中断之后明确重试的下载。
- **可用意味着落盘**：图片与音频经 `Attachments` 存成附件（[附件](docs/subsystems/attachment.md)）。内容以 SHA256 寻址，完整写临时文件后原子发布，取消或写失败不暴露半文件。
- **页面不折事实**：每次状态变化施加 `mediaChanged` 事实；`phaseText`、可取消和可重试下载均由服务端给出。页面不在本地猜任务是否完成。

**助手在频道里生的图自动发回。** 用户在频道里打 `/imagegen <描述>`，页面把这一行带 `to`（这里的助手）发出去，只交给这个助手；助手读自带的 `imagegen` skill（`crates/vibevalley-server/assets/orchestrator/skills/imagegen/SKILL.md`，编进服务端），调 `media.image.create`。来源是助手、带来源频道的生图任务下载完成后，以那个助手的名义在来源频道发一条带图的消息，`sendKey` 为 `media:<任务 id>`，重试与重启只发一次；用户在本页发起的任务不自动发。

发布沿用 Channel 接口与附件 ID。页面用命名空间、任务 ID、目标频道的 JSON 元组计算 SHA256，作为 64 字符的 `sendKey`；刷新后再次发布到同一频道不会多发一条，不同频道各有自己的发布。Artifact 引用同一个本机附件地址，不复制资产。

## 本机输入

`media.input.create` 校验名称、MIME、用途与声明大小，返回服务端生成的输入 ID；它只预留本机空间，不读取服务器上的任意路径、不联系厂商。用户随后 `PUT /api/v1/media/input/:id/content`，请求类型为 `application/octet-stream`，正文直接流式落盘，不经频道的 Base64 JSON。`media.input.adopt` 把一个已有的附件（素材库的一条）当作输入，字节照上传一样核对，落在同一个输入上。`media.input.get/list/delete` 查询、列出和删除输入；`media.input.previewDelete` 只预览，供命令行的 `--dry-run` 使用。这些接口与二进制上传都只给用户，agent 工具不开放上传。

图片上限为 30,000,000 字节，视频为 200,000,000 字节。支持 PNG、JPEG、WebP、GIF、BMP、TIFF，以及 MP4、M4V、MOV、AVI、WebM、MKV 的容器签名；音频接受 WAV、MP3、M4A、FLAC、Ogg 和 WebM，按用途核对格式与时长。容器签名不代表完整解码成功。上传核对声明与实际字节数，计算 SHA256；流式暂存限时 300 秒，最多同时八路。输入以 `0600` 权限写入附件存储下的暂存目录（`attachments/.staging/media/`），完整写完后才经 `keep_staged` 改名成为附件（[附件](docs/subsystems/attachment.md)），不把私有路径返回给页面；输入的 `hash` 就是附件的 id。相同内容共用一个附件，不共用输入 ID；再次上传已经就绪的 ID 返回原结果，不改内容。

PCM WAV 的元数据警告会转入 RIFF 结构校验：容器长度、chunk 边界与填充、`fmt` 与 `data` 的采样布局都需匹配；合法的附加元数据不构成拒绝理由。

所有输入预留（包括失败的和被任务保留的）最多 256 条、按每条声明大小保守计入 2 GiB 配额；相同内容也各占一条预留。未保留的预留和文件在 24 小时后回收，每分钟检查一次，接受新预留前也先回收。删除先落 `deleting` 标记，再清它的暂存文件，最后删记录；附件的字节不删，别处可能也在用。删除失败保留标记供下次检查恢复。断线、取消和失败会关闭写入并清理临时文件；未能清理的部分文件归原输入 ID，预留继续占配额，清理成功前不能再次接收文件或删掉预留。发布前先记录预期哈希，数据库拒绝提交且文件回滚也失败时，完整文件同样仍有所属预留。一个输入的回收失败不阻塞其余输入。本机上传可以明确重试，和可能计费的厂商调用不是同一种重试。

服务器用 SQLx 在同一笔 SQLite 写事务内核对请求 ID 和在途配额、保留输入并登记任务。提交失败时，输入保留自动回滚。sqlc 从[媒体查询](crates/vibevalley-server/src/modules/media/sql/queries.sql)生成 Rust 接口。被保留的输入不按期限删除，也不能由用户单独删除。只有对应的保留者可以读它，读取前流式核对大小和哈希。文件丢失或内容损坏时标失败；修复只接受原内容，新内容必须新建输入。重复内容的发布也检查已有文件，损坏时用已核对的完整临时文件原子替换，不覆盖仍然完整的文件。

重启把未结束的本机上传记为失败，清除暂存目录和没有记录引用的哈希文件；丢失文件的就绪记录改为失败。它不会自动重新读取用户的原始文件，更不会重传给厂商。

## 单人语音

单人语音使用独立 `speech` 绑定，支持 Flash 同步／流式与 Pro 同步／异步。请求固定 ID、文字、音色、连接与 revision；提交答复丢失时仍沿用原请求，不能用新账号或新 ID 偷偷重合成。音频输出格式是闭集：WAV、MP3、FLAC、AAC、Opus、PCM；具体模型和模式的组合由协议校验。结果的格式、MIME、时长、采样率、声道和厂商用量按实际回执与文件保存，不把请求的格式当成事实。例如请求 FLAC 而厂商报告 WAV 时，保存 WAV，不改后缀冒充 FLAC；缺失用量不记零。

Flash 流式由服务端请求厂商 SSE，从元数据与 PCM 分片生成有序音频事件；浏览器显式启动 WebAudio 播放，慢消费者的队列有界。单次流限时 5 分钟、音频不超过 128 MiB，完整帧保存成 WAV。失败或取消仍保留已收到的可保存音频，标明部分结果，不冒充完整成功；刷新读取保存的结果，不重开厂商流。停止、离开或设备故障会中断当前 Flash 流、取消原任务并释放播放资源；已保存音频的普通播放器停止不重新提交任务。

异步任务先保存厂商任务 ID，再查询状态。只有状态 GET 对暂时网络、超时、429 与 5xx 做有界退避；提交 POST 不重试。轮询暂停后，`media.speech.resume` 只恢复原任务查询，`media.job.download` 只重取已有结果。恢复、清理均核对原连接与凭据指纹；改绑用途不会切换旧任务账号，换 Key 后拒绝借新凭据接续。

## 多人对白、音色设计、克隆和转写

四种都显示成 `MediaAudioJob`，按 `kind` 分。多人对白（`media.dialogue.create`）和音色设计（`media.voiceDesign.create`）是厂商的异步任务：先存任务 ID 再查询，结果下载成附件；助手带着用户这一轮的话也能发起。30 秒、10 MB 以内的 WAV／MP3／FLAC 设计结果另存成一个本机输入（`previewInput`），可以直接拿去克隆。

克隆（`media.clone.create`）和转写（`media.transcription.create`）只有用户能发起，各读一个就绪的音频输入，任务保留这个输入。克隆的样本限 10 MB、30 秒、WAV／MP3／M4A／FLAC，一次同步请求；音色一旦建成就记下，哪怕任务这时已被取消。转写先把输入上传给厂商，再提交异步任务，或（`streaming`，仅 Pro 模型）读 SSE：每个分段、以及最多每 200 毫秒存一次，流断了保留已收到的文字，记为未知，不重新提交。

任务结束（`ready`、`failed`，或没有厂商任务的 `canceled`）后删掉厂商那份上传；没有结果的任务同时放开输入，有结果的保留到用户释放任务。删除失败时任务的 `problem` 说明清理待办，`canCleanup` 为真，`media.audio.cleanup` 只重试删除（`media.audio.previewCleanup` 预览）。`media.audio.resume` 只查询已知的厂商任务，流式转写和克隆不能接续。

## 图片和视频理解

`media.understanding.create` 由用户发起：1–5 张图片或一个视频、一段问题和输出上限。任务依次 `uploading`（输入逐个传给厂商）、`generating`（问一次）、`ready` 或 `incomplete`（被输出上限截断），随后删掉厂商那份上传并放开输入，`cleanup` 记为 `done`。删除失败记 `blocked`，上传结果不明的文件记 `unknown` 并在 `problem` 里列出文件名；`media.understanding.cleanup` 可以再试（`previewCleanup` 预览）。失败或未知的任务保留上传和输入，等用户清理。

`media.understanding.authorize` 是用户给某个频道里的助手的许可：任务停在 `authorized`，15 分钟内有效，不上传任何东西。助手带着用户这一轮的话调 `media_understanding_start`，频道对得上、连接与凭据没变才开始；到期（每分钟检查）、取消或重启都会结束这次许可并放开输入。

每个传给厂商的文件发出前先记在任务上（换成不含原文件名的名字），同一任务不重传；回执丢了就是未知，不再发一次。删除只用任务原来的连接和凭据，换过 Key 就拒绝。

## 下载边界

下载只接受 HTTPS、默认或 443 端口、无用户名密码的 URL，不带厂商认证头，不跟随重定向。专用 socket lookup 校验 DNS 返回的全部 IPv4 地址，并把已校验地址直接交给连接，不再次解析；本机、私网、链路本地、云元数据、共享地址、文档和保留地址段均拒绝。当前不支持 IPv6 结果下载。

代理或 DNS 将结果域名解析为 `198.18.0.0/15`（fake-IP／基准测试网段）时同样拒绝；`img.mosi.cn` 也没有例外。运维应在隔离验收环境关闭该域名的 fake-IP，或使用经过核实、返回真实公网地址的 DNS，再单独重试已有结果下载。不得放行保留地址、绕过全部地址校验或重新提交生成。

响应必须为 200 与 `image/png`，60 秒覆盖读取，最多 25 MiB。校验 PNG 签名、chunk CRC、IHDR 尺寸与格式、完整结尾、解压长度和行过滤字节；解压上限 32 MiB，当前拒绝隔行 PNG。下载或保存失败显示可单独重试，不把错误正文、认证头或签名 URL 展示给用户。

音频下载沿用相同公网边界，限时 300 秒、最多 512,000,000 字节，MIME 与厂商报告的实际格式匹配。按格式检查容器、帧与元数据；裸 PCM 不凭空猜采样率。结果存成附件。格式不符、截断或错误正文不能成为完整成功附件；浏览器是否支持该编码仍需实际解码与播放，不能只看后缀。

## 素材库

素材库（`crates/vibevalley-server/src/modules/library.rs`，页面 `/library`）把用户关心的文件放在一处：生成的、用户上传的、帮工和助手拿回来的。一份素材是一个[附件](docs/subsystems/attachment.md)加上它的来路。页面照 Eagle 那样分三栏：左边按来路和种类筛，中间是按比例排满一行的缩略图，右边是选中的那一份；生成的表单收在「生成」对话框里。

- **一份文件一张卡**：主键是附件的 id（内容的 SHA-256）。同一份字节再来只更新 `last_at`，来路照第一次的；生成的那条的时间不再变。
- **来路是封闭的联合**（`LibraryOrigin`，按 `kind`）：
  - `generated`：媒体任务的 id 和种类；任务 `ready` 拿到附件时记，开机时按核心状态里已有的任务补齐。
  - `uploaded`：用户在聊天里发出带附件的话（记频道和消息），或在这页上传（两样都没有）。这页的上传是 `attachment.create` 再 `library.item.add({ attachment })`。
  - `fetched`：哪个档案、哪个帮工（会话）、从哪个网址或工作目录里的哪个文件。
- **谁能给什么**：`library.item.add` 只收一种来源。经 HTTP 来的是用户，只能给已上传的附件；助手的工具只给网址，帮工的给网址或路径。网址只走公网 https（`public_http.rs`），最大 `attachmentMax`（25 MB），60 秒；路径解析了符号链接以后仍要在工作目录里。
- **拿掉只删这一条**：`library.item.delete` 不删附件，发过它的消息照样能打开。
- **进行中任务实时对齐**：在做的生成任务读核心状态的 `media`，排在最前（麦色的虚线格）；完成的任务数一变，页面重读列表。
- **搜和排在服务端，筛和数在页面**：`library.item.list` 的 `text` 按名字找（不分大小写），`sort` 是 `recent`（默认）、`name`、`size`；左栏的两组各按另一组选中的那项数（`countsOf`），来自频道、来自帮工两组照列表里出现的列出。
- **一页只有一条栏**：壳子的页头在 `/library` 不画（和聊天一样，`app/Shell.tsx`），工具条（搜索、排序、缩略图大小、上传、生成）就是页头，66px 高。连接 AI 的入口只在生成被挡住时出现（各表单自己的提示）。
- **缩略图按比例排满一行**（`justify`）：每行缩放到正好占满宽度，最后一行保持目标高度；比例夹在 1:2 到 3:1。缩略图的高度每个看的人自己记（`prefs` 的 `libraryTile`，96–280px）。每格按附件 id 绝对定位，排法变了格子不重建，图不会重载。图、视频的比例和像素、音频和视频的时长在它们加载后从元素上读。
- **选和键盘**：点一下选一个，⌘/Ctrl 点加减，Shift 点选一段；← → 按顺序走，↑ ↓ 去上下一行中间最近的那格（`neighbor`）；空格全屏看（`Lightbox`，← → 翻）；Delete 在详情栏里原地问一遍再拿掉；Esc 不选。文件拖到页面上或粘贴进来就上传。
- **手机宽**（40rem 以下）：工具条在最上，筛选栏变成两个选择框（来路、种类），详情栏是从底下出来的面板。

素材库按附件标识保存首次来源。后续再次收到同一附件时，只推进最近时间。生成任务标识与素材卡同时提交。列表先按选定的名称或大小排序，再按最近时间和附件标识排序。[素材库查询](crates/vibevalley-server/src/modules/library/sql/queries.sql)

**素材库流转**

1. 用户在「生成」对话框里生图或合成语音；任务完成，素材库记一条 `generated`，网格里出现这张卡。
2. 用户在聊天里发一张图，或在这页点「上传」；各记一条 `uploaded`。
3. 帮工做活时调 `library_item_add`，给一个网址或 `out/report.png`；服务端取到字节，记一条 `fetched`。

## 和谁打交道

- **核心状态（`core`）**：任务状态变化施加 `mediaChanged`；素材库听 `mediaChanged` 与 `messageChanged` 登记完成任务与聊天附件。
- **AI 服务（`provider`）**：取用途冻结的账号、模型与钥匙。
- **附件（`attachment`）**：经 `attach`、`keep_staged` 存任务结果、上传输入与帮工取回的字节。
- **频道（`channel`）**：助手触发的生图完成后发回来源频道。

## 为什么这样

- **一台共用任务机承载全部媒体种类**：排队去重、执行槽、阶段单向迁移、未知状态保护和独立下载重试在 `jobs.rs` 写一次，各种类只提供厂商请求与结果解析；加种类不再复制状态机。
- **频道 `/imagegen` 经 `SayRequest.to` 交助手，出图后直接发回**：保留助手 `imagegen` skill 的提示词扩写与比例选择；下载完成那一刻发回来源频道（`sendKey: media:<id>`），免去助手轮询等待。
- **一个附件加来路，而非给附件加字段**：同一份字节可以既是生成的又被人发过，附件只管「这是什么文件」，来路记在 `media_library_item`；从素材库拿掉一张卡不删附件字节。
- **帮工给网址或路径，不传字节**：在 MCP 里传大段 base64 费 token 且易截断，由服务端拉取或读工作目录更稳妥。

## 怎么验证

- `crates/vibevalley-server/tests/media_jobs.rs`：同一请求不重做、下载可单独重试且记进素材库、取消放出执行槽、在途上限、重启接续下载不重新生成、已知拒绝和未知结果分开、请求校验、助手的生图工具要用户的输入且只发回一次。
- `crates/vibevalley-server/tests/media_kinds.rs`：离线 MOSS 上的多人对白、音色设计、克隆、转写（任务与流）和理解：同一请求不重做、结果与释放、厂商失败与未知、下载单独重试、手动接续、重启后接续或记未知、厂商文件清理与重试、助手凭授权启动理解。
- `crates/vibevalley-server/tests/media_inputs.rs`：输入经暂存放进附件、删输入不删字节、伪装文件和不对的大小被拒、保留、准入回滚、过期与重启。
- `crates/vibevalley-server/tests/library.rs`：聊天附件和完成任务各记一次、拿掉不删文件、来源不唯一或不是公网、不是调用者能给的被拒。
- `apps/mac/ui/vv/app/scenarios.test.tsx`：素材库与多密度场景页面测试（`nsh/test`）。

真实厂商、真实播放的验收方法见[媒体验收](.agents/skills/vv-acceptance/references/media.md)。
