# 媒体任务与输入

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册。

## 什么时候用

用于 `media`、音频协议、下载与附件、理解授权、助手媒体工具、素材库 `/library` 页（生成对话框 `?make=`、理解对话框 `?understand=<附件 id>`），以及 MOSS Live／Vision 的实时视觉、播放与资源生命周期。模型列表能查、用途能绑定，不等于生成能用。

## 准备

- 先跑定点测试，再跑 `vp run server:check`、`vp run web:check`。
- 不使用用户的家目录、Key 或媒体。下面的 Playwright 自己起隔离服务端；`VIBEVALLEY_TEST_RUNTIMES=1` 下的 `apps/server/src/testing/network.ts` 只替换 MOSS 生图、理解、语音、音色、远端文件请求和结果下载，任务、数据库、文件、状态流、频道和 Artifact 都走真的模块。不要手工拼成功帧。
- 区分三类证据：协议离线、隔离程序、真实厂商。这里的成功图片是确定的 PNG，音频是合成音调的 WAV／MP3，不证明账号权限、模型质量或实际费用。

## 步骤

1. 在 `apps/server` 跑 `vp test src/media/media.test.ts src/media/download.test.ts src/infra/publicHttp.test.ts src/infra/files.test.ts src/flows/media.test.ts`。核对来源与用量、断线、换 Key、取消竞争、磁盘失败、重启和脚本模型调用；下载重试不能再次生成。
2. 在根目录跑：

   ```bash
   vp run --filter @vibevalley/web e2e:integration 'test/media.spec.ts$'
   VIBEVALLEY_WEB_DEV=1 vp run --filter @vibevalley/web e2e:integration 'test/media.spec.ts$|test/providers.spec.ts$'
   vp run --filter @vibevalley/web e2e:audit 'test/a11y.spec.ts$' --grep 'image task results'
   ```

3. 核对文本和布局两条成功路径、任务 ID、来源与厂商用量、图片实际解码尺寸、下载 PNG 签名、刷新后重复发布只有一条消息、Artifact 读取到同一个附件地址。不要只等提交按钮变灰：那可能仍在发送，或请求已经失败。
4. 核对 `unknown` 不提供重新提交的捷径、取消只停止本机等待、失败后按钮只重试下载。开发版不应有 Solid 响应式警告；拒绝用例的 HTTP 409 与响应式诊断分开报告。
5. 读取 `apps/web/.screens/media-{ready,failed,unknown,canceled}-{light,dark}-{1280,390}.png`：文字与动作没有横向溢出，未知费用与取消含义清楚，图片能看见，截图主体没有被固定页头遮住。截图步骤见[页面分册](.agents/skills/vv-acceptance/references/page.md)。

## 本机大文件输入

1. 在 `apps/server` 跑 `vp test src/media/input.test.ts src/media/inputs.test.ts src/http/media.test.ts src/infra/db.test.ts`。核对 26 MiB 的二进制传输、真实 HTTP 断线、配额竞争、任务保留事务、期限、原内容修复和重启清理；容器头样例不是视频解码或理解验收。
2. 照[服务端分册](.agents/skills/vv-acceptance/references/server.md)用 `verify-server.ts -- <脚本>` 起隔离程序。脚本自行生成 PNG，不读取用户的文件；不配置供应商连接。
3. `POST /api/v1/media/input/create`，JSON 为 `{ "kind": "image", "name": "isolated.png", "mime": "image/png", "size": <PNG字节数> }`；用答复的 ID 向 `/api/v1/media/input/:id/content` 发 PUT，类型为 `application/octet-stream`，正文直接是 PNG。核对返回 `ready`、SHA256 与 `canDelete`，没有私有路径。带外站 Origin 的 PUT 应为 403，非二进制类型为 415。
4. 重复 PUT 同一就绪 ID 返回原输入；`media.input.get/list` 查询一致；`media.input.previewDelete` 不改变输入；删除后列表没有它。接收一次 `/api/v1/state`，确认没有新增生成任务。这里只上传到本机，没有厂商调用。
5. 保留 `command.stdout.log` 和 `result.json`；后者应为 `code: 0`、`stopped: true`、空 `cleanupErrors`。回收失败必须继续保留输入记录和配额，不能只看请求失败便认为文件已删除。

## 图片与视频理解

1. 在 `apps/server` 跑 `vp test src/media/understanding.test.ts src/media/remoteFiles.test.ts`；核对上传许可版本、输入保留、共享容量与 ID、实际用量、截断、取消、重启和删除重试。陌生上传状态不开始推理；失败但有文件 ID 的回执仍须真正删除。
2. 跑 `vp run --filter @vibevalley/web e2e:integration 'test/understanding.spec.ts$'`，再加 `VIBEVALLEY_WEB_DEV=1` 跑同一项。测试选择仓库中的合成 PNG 和可解码 MP4，不用用户的媒体；确认未勾选许可不能提交，选择后文件先落本机，结果进入 Core、显示并存为 Artifact。重试同一 ID 和刷新不新建任务；截断正文不丢，清理重试不重复理解。
3. 跑 `vp run --filter @vibevalley/web e2e:audit 'test/a11y.spec.ts$' --grep 'understanding results'`。读取 `.screens/understanding-{form,ready,incomplete,unknown,canceled}-{light,dark}-{1280,390}.png`，核对许可、截断、费用未知与清理含义；不要只看空状态。
4. 用 `verify-server.ts --scripted-helper -- <脚本>` 单独核对 JSON 接口与状态流：预留输入、二进制 PUT、带连接及 revision 的 `media.understanding.create`、查询至结果与清理完成、重试同一请求、保存 Artifact、删除已释放的本机输入后仍能读取结果。`media.understanding.previewCleanup` 不得修改文件或调用供应商。保留脚本输出与 `result.json`；测试 runtime 替换厂商传输，不是实际 MOSS 推理。
5. 委托路径还需跑 `src/flows/media.test.ts`：用户登记 `media.understanding.authorize` 后应为 `authorized`、输入保留且没有厂商请求；可信助手只传 ID，必须在授权频道承接用户输入。错误频道、自主巡查、HTTP 用户绕过、过期、换 Key、改参数及其他档案重用均拒绝；并发重复开始只上传一次。排队期间换 Key 也必须在上传前拒绝。取消、过期与重启释放尚未执行的输入。
6. 在真实页面选授权频道，刷新后授权仍在；「发送给助手」只发一条去重的用户消息，撤销后按钮和输入保留按服务端状态改变。用隔离程序核对 `authorize → start 被 HTTP 拒绝 → cancel` 及状态流；脚本模型的可信执行证明与 HTTP 拒绝证明分开保留。

## 单人语音

1. 在 `apps/server` 跑 `vp test src/media/speech.test.ts src/media/audio.test.ts src/media/audioResult.test.ts src/media/release.test.ts src/flows/media.test.ts`。核对 Flash／Pro、格式闭集与实际格式、用量、凭据快照、共享 ID 和容量、可信来源、下载独立重试、磁盘失败、取消竞争和重启；未知结果不重合成。
2. 跑 `vp run --filter @vibevalley/web e2e:integration 'test/speech.spec.ts$'`，再加 `VIBEVALLEY_WEB_DEV=1` 跑同一项。确认从 AI 服务页进入语音、账号音色分页、明确提交后保存；两种格式都要检查浏览器时长与解码状态、播放推进、下载字节及频道去重。离开面板后旧播放器停止并清空来源。
3. 模拟丢失提交答复，再改变 Provider 配置：重试必须仍提交原请求 ID、文字、账号版本、音色和格式；开始新请求才采用新配置。下载失败只重试下载；未知和取消如实显示，不能据按钮恢复猜测未计费。
4. 查看 `apps/web/.screens/speech-ready-{light,dark}-{1280,390}.png`，再在实际 `/library?make=speech` 页面做 axe 检查。播放器、保存链接与长任务 ID 不横向溢出，截图应包含结果和动作，不只看表单。
5. `verify-server.ts --scripted-helper -- <脚本>` 中绑定假凭据，创建语音至 `ready`，GET 本机附件并校验音频，重复请求不新建任务，状态流不含 Key 或签名 URL。保存 `command.stdout.log` 与 `result.json`，确认 code 0、stopped true、无清理错误。整段音频通过不代表 Flash 流式或异步轮询通过。

## 流式、异步与长转写

1. 在根目录运行已有浏览器用例：

   ```bash
   vp run --filter @vibevalley/web e2e:integration 'test/audio.spec.ts$|test/flash.spec.ts$|test/moss.spec.ts$|test/vision.spec.ts$'
   ```

2. 核对 Flash 在完成前已有实际播放样本（`flash-player` 的 `data-played` 大于零），缓冲不超过页面上限，完成后 WAV 可解码。截断保留部分结果；停止、离开、设备故障关闭 AudioContext 并取消原任务，不重新连接厂商流。
3. 核对多人对白使用结构化说话人和台词，设计预览可播放；保存音色必须另行确认克隆许可。更换输入、账号或 Key 后旧许可与音色列表不能继续使用。此步骤使用替身，不调用真实克隆接口。
4. 核对异步任务刷新后仍读取同一任务；已保存任务 ID 的恢复只发状态 GET，已有 URL 的重试只下载。重启、超时、取消和换 Key 的证据应能区分「继续查询」「下载」「新提交」，不把三者混成重试。
5. 核对长转写的增量正文与说话人分段在任务结束前出现，刷新后仍在；点击时间定位原音频，另存 Artifact 保留正文。截断／取消的结果明确标为部分结果，不启用流式重连；普通转写不能误开 Diarize Pro 的 SSE。
6. 预览再确认释放任务资产，核对大音频、设计预览和转写原音频不再占用该任务的保留；刷新后状态一致，其他任务引用及已发布附件仍可读取。远端清理失败保留依据，不用本机释放冒充厂商删除。

## Live、Vision 与宿主

1. 将替身协议、实际 Worker 与真实厂商证据分开记录。`moss.spec.ts` 的虚拟生命周期用例会禁用 Worker；仅这些用例通过不能证明真实 Worker／Worklet 播放。
2. 在本机安全上下文打开 `/settings/moss`，分别核对独立 Vision 和 Live 视觉的明确开启、摄像头／屏幕来源、帧背压、最终问题和中断结果。独立 Vision 不应依赖 Live 绑定。
3. 核对停止、权限拒绝、迟到权限回执、设备丢失、断线、后台与离开页面后的轨道、定时器、WebSocket、Worker、Worklet、AudioContext。旧采集不得在新会话开始后复活；不能仅凭按钮回到空闲断言资源已释放。
4. 用真实 Worker／Worklet 播放记录完成和打断回执：chunk／run／turn 与实际播放样本对应，打断后不再继续播放旧音频。只收到厂商音频、字幕或 `response.done` 不算真实播放验收，`playback_timeout` 不能记为成功。
5. 按[宿主边界](docs/subsystems/voice.md)分别核对浏览器摄像头／屏幕、Electron 摄像头／麦克风与禁用的屏幕入口、配对／手机禁用的实时视觉入口。虚拟设备与注入宿主标志不证明真实设备授权；尚未走通的真实宿主项应明确列为未验收。

## 真实厂商

警告：只有用户确认账号、模型、输入、上传范围和费用上限后，才能使用专门测试连接。只用合成图片、音调／合成语音与合成视频，不上传用户文件或录入真实人物声音。调用前按官方价格预估并保留余量；无法确认价格或余额时先停止并说明风险。用户明确授权某次未知单价调用时，记录该授权与限定次数，未知费用不填零，也不宣称累计费用已核实在预算内。克隆 `POST /v1/audio/voices`（包括设计预览的「保存为音色」）的授权不能从目录查询或设计预览推断。

1. 用入口的隔离沙箱，按[服务端分册](.agents/skills/vv-acceptance/references/server.md)配置授权测试连接；不把 Key 写进命令参数、日志、截图或证据 JSON。不要开启会保存认证头、原始厂商正文或签名 URL 的网络录制。
2. 每笔生成使用唯一请求 ID，记录完整模型 ID、任务 ID、请求用途与预算台账；重复读取使用原 ID。未知结果立即停止，先查原任务与账单，不因没收到文件而再发 POST。
3. 对照请求格式与实际回执，记录实际 MIME、文件格式、可取得的时长／采样率／声道、厂商用量与附件哈希。请求 FLAC 返回 WAV 时应如实记录 WAV；未知用量不记零。
4. 在真实应用播放已下载音频，记录时长、解码状态与播放位置推进；Flash 另记录完成前的实际播放，Live 另记录实际播放完成／打断回执。原始协议探针成功不能替代这些应用证据。
5. 检查结果域名的 DNS。若 `img.mosi.cn` 被解析到 `198.18.0.0/15`，保留拒绝证据，按[下载边界](docs/subsystems/media.md)在隔离环境修复 DNS 后只重试下载；不改生产 SSRF 校验，不重生成。
6. 验收真实克隆时，在 `/library?make=audio` 选择授权账号和合成样本，勾选许可后仅提交一次。核对任务 `ready` 与返回的音色 ID，再通过同账号 `provider.voice.list` 和单人语音选择器确认可用；用该 ID 合成一句短文本，实际播放、下载、刷新后再播放。保留两个请求 ID、原样本哈希、WAV 元数据与下载哈希，核对任务没有因刷新增加。只创建成功而没有取得可播放结果，不算完整验收。

真实克隆、真实 Live 播放或真实宿主步骤未走通时，应逐项写「未验收」及阻碍，不用离线、替身或裸协议结果填补。

## 证据

附命令、通过数、日志位置与已查看的截图；逐项区分离线协议、隔离程序、实际 Worker、真实账号和真实宿主，列出未覆盖项。真实调用额外附授权范围、预算台账、实际用量及播放回执；播放超时、部分结果、清理失败和 DNS 拒绝如实记录，不记录 Key、签名 URL 或原始敏感响应。

## 出错时

- 任务一直排队：检查是否有 `[media:hold]` 样例还在生成；明确取消，不启动另一笔生成绕过队列。
- 发布返回 409：看响应原因。`sendKey` 上限是 64；按命名空间、任务与目标频道生成稳定键，不能改成每次随机值掩盖去重问题。发送成功为 204，不是 200。
- 协议替身没有被使用：`world()` 已组装 Media；定点测试覆盖服务时需新建对应 layer，不能误复用旧实例。真实程序的替身只在测试 runtime 模式启用。
- 下载失败：先分清厂商生成、HTTP 下载与落盘三段；检查 URL 已私有持久化，只重试后两段，不重新计费。

## 收拾

Playwright 停掉它起的进程并清理临时农场；截图不进 git。手动会话关闭媒体轨道、播放上下文、Worker 与 WebSocket，再停止隔离服务。按授权范围清理合成输入、任务保留和已知远端文件，核对清理回执；MOSS 没有官方音色 DELETE，不臆造删除请求，也不把本机释放记成删除厂商音色。不碰用户原有数据。
