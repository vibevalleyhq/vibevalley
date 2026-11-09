# 语音

主人通过电话、听写与实时模型体验使用语音：
- **电话（`Voice` 通话）**：经声网 ConvoAI 与管家实时双向通话，支持打断、实时字幕与来电播报。
- **听写（`dictate`）**：按输入框旁的麦克风录音，经服务端转给 MOSS 转写或自定义接口，转成文字填入输入框。
- **MOSS Live 与独立 Vision**：在体验页建立本机中继会话，Live 接收麦克风及可选视觉帧、播放回答；Vision 独立接收视觉帧与问题并返回文本。长音频转写和生成音频归[媒体任务](docs/subsystems/media.md)。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| RTC 令牌签发、认领、续期与撤销（`AgoraGrant`），请语音 agent 进出频道 | 管家的思考、工具调用与回复生成（[管家](docs/subsystems/orchestrator.md)） |
| 语音线路（默认端口 `8788`）：单接口回环监听、每通电话独立 Bearer 钥匙与隧道管理 | OpenAI `chat/completions` 协议转换与进程内 `Caller` 端口（[管家](docs/subsystems/orchestrator.md)） |
| 通话内主动播报队列（`Voice.speak`）与双模式字幕分流（管家直答 vs 快嘴模型） | 通话记录写入默认频道且不重复唤醒（[频道](docs/subsystems/channel.md) 的 `spoken`） |
| 听写音频转发（MOSS / 自建地址）与 MOSS Live 实时线路转发 | 语音设置在 `settings.json` 中的持久化与脱敏（[设置和配置](docs/subsystems/setting.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| [`packages/provider/`](packages/provider/README.md) | 显式转写模型、MOSS 帧与鉴权连接、Agora SDK/RTC token、字幕分片；无应用设置、业务工具或 UI |
| [`packages/ai/`](packages/ai/README.md) | Core 转写调用、WAV/RMS、MOSS 会话与 `Playback` 样本级打断对账；浏览器入口不加载服务端模型工厂 |
| `apps/server/src/voice/voice.ts` | 农场侧薄消费层：绑定 `Setting`、`Orchestrator`、`Channel`、`Inbox`、`Ingress`、`Core`，管理 RTC 授予与通话内 `speak` |
| `apps/server/src/voice/line.ts` | 语音线路（`8788` 回环监听）与 `cloudflared` 隧道管理 |
| `apps/server/src/setting/voice.ts` | 语音默认配置 `defaultVoice`、校验 `voiceProblem` 与差异提取 `voiceOverrides` |
| `apps/web/src/features/voice/` | `call.ts`、`dictation.ts`、`moss-line.ts` 管设备与宿主，`moss-worker.ts`/`moss-worklets.ts` 保持 PCM 绕开 UI 主线程；`captions.ts` 管展示轮次，`contract.ts` 定义应用会话接口；表单与 playground 留在此处 |
| `apps/mobile/src/rtc.ts` | 手机壳原生声网 RTC 适配（锁屏不断线） |

接口见 [capabilities.md](docs/reference/capabilities.md)（`voice.*` 及 `GET /api/v1/voice/moss/line`）。

## 模型和不变量

- **声网 SDK 严格收敛在三处**：
  - 服务端仅经 `packages/provider/src/agora/server.ts` 调 `agora-token` 与 `agora-agents`；应用 voice 管授予和通话编排。
  - Web 端仅在 `features/voice/call.ts` 动态加载 `agora-rtc-sdk-ng`；手机端仅在 `apps/mobile/src/rtc.ts` 调 `react-native-agora`。
- **授予（`AgoraGrant`）绑定凭据快照与单次认领**：`voice.grant.create` 生成 `channel + uid`、签发 3600 秒令牌并快照当时的 Agora 凭据。同一份授予只能被 `voice.call.start` 认领一次，续期与挂断均使用该快照。
- **一通电话固定建立时的接听模式**：
  - **管家直答模式（默认）**：启动独立回环监听 `8788` 和公网隧道（优先用 `voice.line.url`，未配则拉起临时 `cloudflared tunnel`），向声网提供只开放 `POST /llm/<通话>/chat/completions` 且校验单次 Bearer 钥匙的地址。
  - **快嘴模式（`quick`）**：声网直连托管模型、DeepSeek 或自定 LLM 先答，页面将主人字幕交 `voice.call.hear` 供管家后台派活，将快嘴回答交 `voice.call.say` 记入默认频道。
- **挂断立即终止字幕资格**：调用 `voice.call.stop` 先撤销授予并将通话标为 `ending`，后续迟到的 `hear` / `say` 一律拒绝。
- **管家来电与通话内播报串行排队**：
  - 通话中若 `Inbox.news` 出现新事项，先等 3 秒合并同批事项，经 `Orchestrator.brief` 生成口语摘要，再调声网 `session.say`（`APPEND` 排在当前话音后，按句切分为 480 字节以内）播报。
  - 未通话时手机按 Inbox 响铃；主人接听时带该事项启动通话，跳过开场白直接由管家播报该事项。
- **一段听写绑定唯一输入框目标**：录音开始时锁定发起的输入框；切换焦点或在别处点停止不会写错目标，组件卸载时自动取消在途转写。
- **MOSS Live 经服务端隐藏密钥中继**：页面连 `/api/v1/voice/moss/line`（校验同源 `Origin` 与回环 `Host`），服务端从 Provider 取 MOSS Live 绑定连接的 Key，握手时注入并双向透传帧。

## 怎么走

**拨通与挂断电话**

1. 页面获取麦克风权限，调 `voice.grant.create` 拿到 `AgoraGrant`，经 `host.rtc` 或 Web SDK 加入频道。
2. 调 `voice.call.start`：服务端认领授予、准备语音线路与隧道、启动声网 ConvoAI agent，并施加 `callChanged(live)` 事实。
3. 通话中页面从 data stream 拼接实时字幕（`captions.ts`），句子定稿并落入频道后自动替换。
4. 挂断时调 `voice.call.stop`，撤销授予、销毁线路钥匙并请声网 agent 离开频道。

**语音听写**

1. 点击或按住听写键录制 16kHz 单声道 WAV，松开后将 base64 音频交 `POST /api/v1/voice/dictate`（上限 25MB）。
2. Voice 向 Provider 要解析后的调用配置：MOSS 使用「AI 服务」中绑定的连接与模型，自建使用听写设置；经唯一 `/audio/transcriptions` 实现调用（限时 2 分钟），返回文本插入原输入框光标处。

### Live 与独立 Vision

Live 与 Vision 使用[AI 服务](docs/subsystems/provider.md)各自的连接及完整模型 ID。服务端同源、回环中继隐藏 Key，不让页面直连厂商认证端点。选择视觉来源不自动上传；主人明确开启后才采集。独立 Vision 发送问题或最终问题、显示增量文本；Live 将视觉帧交给同一实时 Worker，不把图片作为另一条静态理解任务提交。

视觉采集按帧间隔编码 JPEG，限制尺寸、字节数与 WebSocket 积压；握手未就绪或背压时跳过帧，不无限排队。停止、拒绝权限、设备丢失、断线、页面离开都应结束相应采集；采集代次阻止迟到的权限回执重新启动旧流。Live 的 PCM 由 Worker／Worklet 驱动，播放完成与打断按 chunk／run／turn、实际播放样本对账，收到音频不等于已经播放。

每个 Live 中继持有自己的播报缓冲和通话引用。中继结束会取消所属通话并撤销授予；迟到的旧通话停止请求不能关闭或清空替代它的新中继。

| 宿主 | 实时视觉边界 |
|---|---|
| 本机安全上下文浏览器 | 支持摄像头与浏览器屏幕选择器，仍需主人授权和可用设备 |
| Electron 桌面壳 | 支持摄像头／麦克风权限；没有屏幕选择器，屏幕来源禁用 |
| 配对页面、手机壳 | 不支持实时视觉，本机地址与宿主能力检查禁用入口，不借配对线路绕过中继限制 |

停止会话释放媒体轨道、采集定时器、WebSocket、Worker、Worklet 与 AudioContext；清掉回调和页面监听，下一次开始使用新会话。宿主支持表描述代码边界，不代表真实浏览器、桌面或手机权限已逐项验收。

## 和谁打交道

- **管家与频道（`orchestrator`、`channel`）**：管家经 `response.ts` 处理流式回答与 `brief` 播报；定稿文字经 `Channel.spoken` 写默认频道。
- **通知与设置（`inbox`、`setting`）**：订阅 `Inbox.news` 驱动通话内主动播报；从 `Setting` 实时读取声网凭据与语音配置。
- **[AI 服务](docs/subsystems/provider.md)**：Provider 解析听写连接与默认模型、提供 MOSS Live 绑定凭据；语音页不再保存独立的 MOSS Key。

## 为什么这样

- **复用声网 ConvoAI 实时链路，仅将大脑换为农场管家**：回声消除与打断由声网处理；服务端通过单接口带单次钥匙的语音线路接入管家，不将主服务端口暴露到公网隧道。
- **语音线路只取最新一句 `user` 输入，历史以管家会话为准**：避免声网侧因插话截断或缺失频道文字而产生第二份不一致历史。
- **听写走轻量 HTTP 转写，不走实时 RTC**：单次录音转文字无需双向流；服务端转发既保护 API Key，又让配对手机能复用本机运行的本地识别服务。

- **SDK 实时会话不替代专有媒体运行**：`ai@7.0.164` 的框架无关 session 可以托管自定义 transport，但其 `stopPlayback()` 只是转调，播放结束不产生 MOSS 的 chunk/run/turn 回执，也不能提供 Worklet 的样本级 cut。SDK 内置播放只记录 AudioContext 时间，连续 PCM 的 `audio-chunk` 没有 run/chunk 字段；放进 raw 也不会触发这些对账。保留 AI 的 `moss-session`、`Playback` 和应用 Worklet，不再包一层没有接管职责的 session。
- **声网托管通话不等于通用 WebRTC**：SDK transport 扩展仍需应用的声网 RTC 实现；其实时 session 明确拒绝 `session-started` 的 `delegationMode: provider`。保留 Provider 的声网协议/客户端、应用的通话编排与宿主媒体，不将托管模式改为客户端工具执行。`packages/ai/src/realtime/sdk.test.ts` 用安装的 SDK 与假 transport 验证这两个边界；不把该测试当作真实厂商或设备互通验收。

## 还没做的

- 本机 WebSocket 直连实时语音模型，免除公网隧道：[自己的实时模型经本机 WebSocket 接电话](.agents/notes/proposed/feature/2026-10-27-realtime-calls-over-websocket.md)。
- 帮工专属音色、频道朗读与直拨帮工：[帮工各自的音色](.agents/notes/proposed/feature/2026-10-13-helper-voices.md)。

## 怎么验证

- `packages/provider/src/moss.test.ts`、`packages/ai/src/realtime/moss.test.ts`、`sdk.test.ts`：握手、tagged-v1、完成回执、样本级打断与 SDK 替代边界。
- `apps/server/src/voice/voice.test.ts`、`moss.test.ts`、`http/moss.test.ts`：授予认领、多事项合并播报、512 字节切段、挂断拒收字幕与 MOSS 中继测试。
- `apps/web/src/features/voice/captions.test.ts`、`apps/web/test/voice.spec.ts`、`farm-phone.spec.ts`：分块字幕拼接、缺钥匙提示、听写与来电接听测试。
