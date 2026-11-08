# 媒体任务与输入

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册。

## 什么时候用

用于 `media`、生图协议、下载与附件、管家媒体工具和 `/media` 页。模型列表能查、用途能绑定，不等于生成能用。

## 准备

- 先跑定点测试，再跑 `vp run server:check`、`vp run web:check`。
- 不使用主人的家目录、Key 或媒体。下面的 Playwright 自己起隔离服务端；`VIBEVALLEY_TEST_RUNTIMES=1` 下的 `apps/server/src/testing/network.ts` 只替换 MOSS 生图、理解、远端文件请求和结果下载，任务、数据库、文件、状态流、频道和稿子都走真的模块。不要手工拼成功帧。
- 区分三类证据：协议离线、隔离程序、真实厂商。这里的成功图片是确定的 PNG 样例，不证明账号权限、模型质量或实际费用。

## 步骤

1. 在 `apps/server` 跑 `vp test src/media/media.test.ts src/media/download.test.ts src/infra/publicHttp.test.ts src/infra/files.test.ts src/flows/media.test.ts`。核对来源与用量、断线、换 Key、取消竞争、磁盘失败、重启和脚本模型调用；下载重试不能再次生成。
2. 在根目录跑：

   ```bash
   vp run --filter @vibevalley/web e2e:integration 'test/media.spec.ts$'
   VIBEVALLEY_WEB_DEV=1 vp run --filter @vibevalley/web e2e:integration 'test/media.spec.ts$|test/providers.spec.ts$'
   vp run --filter @vibevalley/web e2e:audit 'test/a11y.spec.ts$' --grep 'image task results'
   ```

3. 核对文本和布局两条成功路径、任务 ID、来源与厂商用量、图片实际解码尺寸、下载 PNG 签名、刷新后重复发布只有一条消息、稿子读取到同一个附件地址。不要只等提交按钮变灰：那可能仍在发送，或请求已经失败。
4. 核对 `unknown` 不提供重新提交的捷径、取消只停止本机等待、失败后按钮只重试下载。开发版不应有 Solid 响应式警告；拒绝用例的 HTTP 409 与响应式诊断分开报告。
5. 读取 `apps/web/.screens/media-{ready,failed,unknown,canceled}-{light,dark}-{1280,390}.png`：文字与动作没有横向溢出，未知费用与取消含义清楚，图片能看见，截图主体没有被固定页头遮住。截图步骤见[页面分册](.agents/skills/vv-acceptance/references/page.md)。

## 本机大文件输入

1. 在 `apps/server` 跑 `vp test src/media/input.test.ts src/media/inputs.test.ts src/http/media.test.ts src/infra/db.test.ts`。核对 26 MiB 的二进制传输、真实 HTTP 断线、配额竞争、任务保留事务、期限、原内容修复和重启清理；容器头样例不是视频解码或理解验收。
2. 照[服务端分册](.agents/skills/vv-acceptance/references/server.md)用 `verify-server.ts -- <脚本>` 起隔离程序。脚本自行生成 PNG，不读取主人的文件；不配置供应商连接。
3. `POST /api/v1/media/input/create`，JSON 为 `{ "kind": "image", "name": "isolated.png", "mime": "image/png", "size": <PNG字节数> }`；用答复的 ID 向 `/api/v1/media/input/:id/content` 发 PUT，类型为 `application/octet-stream`，正文直接是 PNG。核对返回 `ready`、SHA256 与 `canDelete`，没有私有路径。带外站 Origin 的 PUT 应为 403，非二进制类型为 415。
4. 重复 PUT 同一就绪 ID 返回原输入；`media.input.get/list` 查询一致；`media.input.previewDelete` 不改变输入；删除后列表没有它。接收一次 `/api/v1/state`，确认没有新增生成任务。这里只上传到本机，没有厂商调用。
5. 保留 `command.stdout.log` 和 `result.json`；后者应为 `code: 0`、`stopped: true`、空 `cleanupErrors`。回收失败必须继续保留输入记录和配额，不能只看请求失败便认为文件已删除。

## 图片与视频理解

1. 在 `apps/server` 跑 `vp test src/media/understanding.test.ts src/media/remoteFiles.test.ts`；核对上传许可版本、输入保留、共享容量与 ID、实际用量、截断、取消、重启和删除重试。陌生上传状态不开始推理；失败但有文件 ID 的回执仍须真正删除。
2. 跑 `vp run --filter @vibevalley/web e2e:integration 'test/understanding.spec.ts$'`，再加 `VIBEVALLEY_WEB_DEV=1` 跑同一项。测试选择仓库中的合成 PNG 和可解码 MP4，不用主人的媒体；确认未勾选许可不能提交，选择后文件先落本机，结果进入 Core、显示并存为稿子。重试同一 ID 和刷新不新建任务；截断正文不丢，清理重试不重复理解。
3. 跑 `vp run --filter @vibevalley/web e2e:audit 'test/a11y.spec.ts$' --grep 'understanding results'`。读取 `.screens/understanding-{form,ready,incomplete,unknown,canceled}-{light,dark}-{1280,390}.png`，核对许可、截断、费用未知与清理含义；不要只看空状态。
4. 用 `verify-server.ts --scripted-helper -- <脚本>` 单独核对 JSON 接口与状态流：预留输入、二进制 PUT、带连接及 revision 的 `media.understanding.create`、查询至结果与清理完成、重试同一请求、保存稿子、删除已释放的本机输入后仍能读取结果。`media.understanding.previewCleanup` 不得修改文件或调用供应商。保留脚本输出与 `result.json`；测试 runtime 替换厂商传输，不是实际 MOSS 推理。

## 真实厂商

只有主人确认账号、模型、输入、上传范围和费用上限后，才能用专门的测试连接发起真实生成；不要把 Key 写进命令、日志或截图。每次用唯一请求 ID，记录模型完整 ID、任务状态、实际用量、附件与结果，不记录签名 URL。未知结果先停，不因没收到图片就重发。没有授权时明确写「真实厂商未验收」，继续做离线与本机验收。

## 证据

附命令、通过数、日志位置与已查看的截图；列出用的是网络替身还是真实账号，以及未覆盖项。真实厂商调用额外附授权范围、结果与实际用量，未知用量不记零。

## 出错时

- 任务一直排队：检查是否有 `[media:hold]` 样例还在生成；明确取消，不启动另一笔生成绕过队列。
- 发布返回 409：看响应原因。`sendKey` 上限是 64；按命名空间、任务与目标频道生成稳定键，不能改成每次随机值掩盖去重问题。发送成功为 204，不是 200。
- 协议替身没有被使用：`world()` 已组装 Media；定点测试覆盖服务时需新建对应 layer，不能误复用旧实例。真实程序的替身只在测试 runtime 模式启用。
- 下载失败：先分清厂商生成、HTTP 下载与落盘三段；检查 URL 已私有持久化，只重试后两段，不重新计费。

## 收拾

Playwright 停掉它起的进程并清理临时农场；截图不进 git。真实账号测试取得的厂商结果与本机资产，按授权范围保留或删除，不碰主人原有数据。
