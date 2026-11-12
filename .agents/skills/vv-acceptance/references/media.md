# 媒体任务与输入

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册。行为、不变量和边界写在 [媒体](docs/subsystems/media.md)；这里只列要跑的命令、要交的证据和真实厂商的规矩。

## 什么时候用

改了 `apps/server/src/modules/media`、音频协议、下载与附件、理解授权、助手的媒体工具、素材库 `/library` 页（生成 `?make=`、理解 `?understand=<附件 id>`），或 MOSS Live／Vision 的实时视觉、播放与资源回收。模型列表能查、用途能绑定，不等于生成能用。

## 准备

- 不使用用户的家目录、钥匙或媒体。下面的 Playwright 自己起隔离的服务端；`VIBEVALLEY_TEST_RUNTIMES=1` 下 `apps/server/src/testing/network.ts` 只替换 MOSS 的厂商请求和结果下载，任务、库、文件、状态流、频道和 Artifact 都走真的模块。不手工拼成功帧。
- 证据分三类：协议离线、隔离程序、真实厂商。替身给的是确定的 PNG 和合成音调，不证明账号权限、模型质量或实际费用。

## 步骤

1. 在 `apps/server` 跑定点测试：

   ```bash
   vp test src/modules/media src/gateway/http/media.test.ts src/infra/publicHttp.test.ts src/infra/files.test.ts src/infra/db.test.ts src/flows/media.test.ts
   ```

2. 跑 `vp run server:check`、`vp run web:check`。
3. 在根目录跑浏览器用例，开发版再跑一遍（不应有 Solid 响应式警告）：

   ```bash
   vp run --filter @vibevalley/web e2e:integration 'test/(media|understanding|speech|providers|audio|flash|moss|vision).spec.ts$'
   VIBEVALLEY_WEB_DEV=1 vp run --filter @vibevalley/web e2e:integration 'test/(media|understanding|speech|providers).spec.ts$'
   vp run --filter @vibevalley/web e2e:audit 'test/a11y.spec.ts$' --grep 'image task results|understanding results'
   ```

4. 读截图 `apps/web/.screens/{media,understanding,speech}-*-{light,dark}-{1280,390}.png`：没有横向溢出，费用未知、取消、截断的含义看得清，结果和动作都在图里，没被页头遮住（截图步骤见[页面分册](.agents/skills/vv-acceptance/references/page.md)）。
5. 改了接口时，照[服务端分册](.agents/skills/vv-acceptance/references/server.md)用 `verify-server.ts -- <脚本>`（理解和语音加 `--scripted-helper`）在隔离程序上走一遍：脚本自己生成 PNG，`media.input.create` 后向 `/api/v1/media/input/:id/content` PUT 二进制，再走要验的那条接口到 `ready`，接一次 `/api/v1/state` 核对状态流里没有钥匙和签名 URL。
6. 改了 Live／Vision 或宿主：`moss.spec.ts` 的虚拟生命周期用例禁用 Worker，只证明替身协议；真实 Worker／Worklet 播放、摄像头／屏幕、Electron 和手机的入口要在真的宿主上看（[宿主边界](docs/subsystems/voice.md)），没走通的列为未验收。

## 真实厂商

警告：只有用户确认账号、模型、输入、上传范围和费用上限后，才可使用专门的测试连接。只用合成的图片、音调和视频，不上传用户的文件，不录真实人物的声音。不然会花用户的钱、泄露用户的媒体。

1. 调用前照官方价格预估并留余量；确认不了价格或余额就停下说明。未知费用不记零。
2. 钥匙不写进命令参数、日志、截图或证据 JSON；不开会存认证头、厂商原文或签名 URL 的网络录制。
3. 每笔生成用唯一的请求 ID，记下完整模型 ID、任务 ID 和预算台账。结果未知时立即停，先查原任务和账单，不再发 POST。
4. 克隆音色（`POST /v1/audio/voices`，含设计预览的「保存为音色」）要单独授权，不从目录查询或预览推断。MOSS 没有删除音色的接口，不臆造，也不把本机释放记成厂商删除。
5. `img.mosi.cn` 被解析到 `198.18.0.0/15` 时，保留拒绝的证据，在隔离环境修 DNS 后只重试下载（[下载边界](docs/subsystems/media.md)），不改 SSRF 校验，不重新生成。
6. 下载的音频要在真的应用里播放，记下时长、解码状态和播放位置；只收到厂商音频、字幕或 `response.done` 不算播放验收，`playback_timeout` 不记成功。

## 证据

- 第 1、3 步的命令和通过数，第 4 步看过的截图。
- 第 5 步的 `command.stdout.log` 和 `result.json`（`code: 0`、`stopped: true`、空的 `cleanupErrors`）。
- 逐项写明是离线协议、隔离程序、真实 Worker、真实账号还是真实宿主；没覆盖的写「未验收」和阻碍，不用替身的结果顶。
- 真实调用另附授权范围、预算台账、实际用量和播放回执；播放超时、部分结果、清理失败和 DNS 拒绝照实写。

## 出错时

- **任务一直排队**：看是不是有 `[media:hold]` 的样例还在生成；明确取消它，不另起一笔生成绕过队列。
- **发布返回 409**：看响应的原因。`sendKey` 上限 64，照命名空间、任务和目标频道生成稳定的键，不改成每次随机。发送成功是 204。
- **替身没被用上**：真实程序只在测试 runtime 模式（`VIBEVALLEY_TEST_RUNTIMES=1`）启用替身。
- **下载失败**：分清厂商生成、HTTP 下载、落盘三段；URL 已经存下时只重试后两段，不重新计费。

## 收拾

Playwright 自己停掉进程、删临时农场；截图不进 git。手动会话关掉媒体轨道、AudioContext、Worker 和 WebSocket，再停隔离的服务端。真实调用照授权范围清理合成的输入和已知的远端文件。不碰用户原有的数据。
