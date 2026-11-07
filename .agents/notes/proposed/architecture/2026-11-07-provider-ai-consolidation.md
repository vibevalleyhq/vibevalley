# Agent Note: Provider 与 AI 收敛现有模型和语音库

Status: proposed

## Problem

工单 #16 要求删除独立 voice workspace，保留听写、MOSS、Agora、播放与手机宿主行为。基线是 `410d8d15dafaf515172d14c38a7da1805d1ee513`，工作区干净。#15 的最终 v2（讨论串 msg=14、16）取代保留 voice 的旧提案。

基线检查：voice 的 20 项、ai 的 8 项和 server voice 的 28 项测试通过。根目录 `vp test --project server` 无匹配项目；服务测试应在 `apps/server` 执行 `vp test run src/voice/voice.test.ts`。

## Proposal

Provider 管显式连接和厂商 wire 协议；AI 管能力调用与无框架运行；应用管通话授权、宿主设备、设置和 UI。每种能力保持一个网络实现，不变更 Core、HTTP 持久化格式或 agent 消息契约。不新增供应商设置、生图产品、预算账本，不调用付费服务。

先迁移有现成行为证据的路径。转写使用真实消费的 `ai` Core 与 `@ai-sdk/provider` 模型接口；按现有 multipart、响应容错、错误、120 秒请求超时和取消约束选择适配器，不能为了复用官方 OpenAI 模型而静默改变 `response_format=json` 或丢弃已有错误细节。SDK 默认重试显式设为 0，模型对象显式注入，不用字符串/Gateway。DeepSeek 的现有 Llm/ModelClient 契约及请求黄金数据不改变；语言桥独立核对，不凭目录移动宣称已切换 SDK。

### File destinations

以下路径相对于原 `packages/voice/src`；每行迁完删除原实现与聚合导出。

| 文件 | 目标 | 判定 |
| --- | --- | --- |
| `core/contract.ts` | web voice 会话契约；RMS 和泛型轮次归 ai 音频/实时子路径 | 拆；应用说话人与设备接口不上移 |
| `transcribe/transcribe.ts` 网络 | provider 转写模型 + ai/transcription | 拆；唯一网络客户端，Core 调用与验证在 AI |
| 同文件 WAV/RMS | ai/audio | 迁；浏览器纯函数，不导入 Node/服务端工厂 |
| 同文件 Worklet/插入文字 | web voice | 迁；设备线程与输入框插入属于应用 |
| `moss/protocol.ts` wire/帧 | provider/moss | 拆；纯浏览器入口 |
| 同文件 ask_orchestrator | server voice | 迁；工具授权不属于厂商模型 |
| 同文件字幕/显示/QoS | ai/realtime/moss 或 web voice | 按运行/呈现职责拆 |
| `moss/server.ts` 连接/握手 | provider/moss/server | 拆；显式 key，无本机配置 |
| 同文件页面 relay/hooks | server voice | 迁；保留作用域、清理和帧次序 |
| `moss/engine.ts`、`moss/playback.ts` | ai/realtime/moss | 迁；暂保留 tagged-v1 与样本级完成/打断对账，未证明 SDK 等价前不删 |
| `moss/line.ts`、`worker.ts`、`worklets.ts` | web voice | 迁；设备拥有者唯一，PCM 仍绕开 UI 主线程 |
| `agora/server.ts` token/client/低层错误 | provider/agora/server | 拆；不依赖 protocol 的 VoiceSettings/ApiError |
| 同文件 vendors/agent/分句/应用错误 | server voice | 迁；托管编排不是模型工厂 |
| `agora/captions.ts` 解码/分片 | provider/agora/captions | 拆；纯协议 |
| 同文件展示轮次/linger/VoiceTurn | web voice | 迁；不复制字幕历史 |
| `moss.test.ts`、`captions.test.ts` | 各接缝最低测试层 | 拆；名称和断言保留，应用工具测试归 server |
| `index.ts`、`core.ts`、`transcribe.ts`、`moss.ts`、`moss-server.ts`、`agora.ts`、`captions.ts` | 删除 | 不兼容重导出、不改名空包 |
| package/构建/README | provider、ai 与 apps 的真实归属 | 更新 workspace、lockfile、静态依赖规则、任务与文档 |

`packages/ai` 的消息、工具、测试模型和 agent 策略留原位。`models.ts`、`request.ts`、`response.ts` 与 `llm.ts` 的厂商部分在语言桥建立时逐项分离；在此之前只有现有 DeepSeek 请求路径，不新增另一条。

### Execution and verification

1. 固定基线与矩阵，先跑现有最窄测试。
2. 以听写为首个可运行切片，测试明确模型、单请求、格式、取消、错误与元数据，再迁 MOSS/Agora 的运行/协议/应用边界。
3. 顺序更新依赖、声明、任务和静态检查；生成器不与正式检查并行。
4. 串行运行 packages:build、vp check、server:check、web:check、Effect、docs、deadcode、health 和 pack/desktop；原有失败单独记录。
5. 独立临时家目录、端口与本地转写 fixture，在真实页面走插入/取消/失败、双主题、窄屏和 Solid 开发诊断。模拟音频不当真实识别服务通过。
6. 审注释，沉淀 README/子系统；完成后删除本 Note。提交检查点不代表整体验收。

### Checkpoint and remaining work

voice workspace 已删除；矩阵中的语音路径已接到 provider、ai 与 apps。听写实际经 `ai@7.0.164` Core 调用 `@ai-sdk/provider@4.0.36` 的显式模型，未引入闲置 SDK。Core 的 `TranscriptionResult` 缺少 usage，AI 从本地 onEnd 回调保留它；该回调覆盖全局遥测集成，不记录输入/输出。未知 usage 不影响已有 text 响应，原始响应仍保留。

基线 voice 的 20 项行为测试全部迁移：provider 握手 3 项、AI MOSS/播放 11 项、web 字幕 5 项、server 工具提取 1 项。web 原有字幕测试与 voice 副本相同，合并时补上 VoiceTurn 断言，不保留重复测试文件。server voice 原有 28 项继续通过；另补模型单请求、元数据、六种音频格式与未知 usage 回归。

真实隔离页面已有录音上传插入、Escape 取消和本地 503 失败保持草稿证据。失败场景覆盖 light/dark、390×844；Solid 开发版只报预期 503 网络错误，无响应式警告。桌面 3 项、server pack 3 项通过；实际打出的 `dist/main.mjs` 在独立家目录启动，健康接口返回 200，随后停止并删除临时数据。以上不是实际识别/MOSS/Agora/手机锁屏验收。

本检查点**不是整单完成**：DeepSeek 的语言请求、响应与模型目录仍在 AI，尚未完成其厂商协议与现有 Llm/ModelClient 桥的分离，也未做上游实时内核的行为等价实验。下一轮应先核对官方 DeepSeek 适配器对现有黄金数据、reasoning/tool 分片和错误/取消的差异，再迁移并删除被替代实现；不直接把 agent 消息契约下放 provider。完成这些后才能沉淀并删除本 Note。

只读核对 #14 的 `57faf46c`：其 `DictationButton.tsx` 将 `useDictation` 扩展为 `{ insert(words) }`，`features/channel/CommentEditor.tsx` 持有 Lexical 插入接缝；本次未改这两个文件和 voice `index.ts`。后续整合应保留该 insert 分支及编辑器选区/撤销/IME 保护，继续用本次 `dictation.ts` 的 `encodeWavBase64`/`dictation-input.ts`，并将这里的 textarea E2E 断言换成新版编辑器目标，不另写一份录音或插入逻辑。

## Alternatives considered

**保留 voice 或改名 audio workspace**：违背主人最新边界，也保留了协议与应用的混杂。

**把整个 voice 移进 ai**：会把农场工具、protocol 配置、设备与长期密钥一起拖入运行层；必须按文件内职责拆。

**立即用 SDK 实时内核替换 MOSS/Agora**：公开抽象存在不证明 tagged-v1、播放完成回执、样本级 cut、RTC 与手机锁屏等价。未获得行为证据的专有实现保留，但不保留旧库边界。

**一次替换 agent 全循环/所有语言协议**：范围和风险超过本批。保留消息与工具契约，语言桥需独立黄金数据与流错误证据。

## Acceptance criteria

- 删除 voice workspace 与旧生产引用，无循环、兼容别名或重复请求路径。
- 原有听写、协议、播放打断、字幕和声网配置测试在新归属下通过。
- 隔离页面真实接线验收与构建/pack 留证；未用真实设备/厂商的项目明确列出。
- 依赖/任务/静态检查与文档同步，提交保留分支，不 push、不建 PR。

## Risks

SDK 对格式、重试、错误包装和超时的默认值可能改变既有行为，需 fixture 逐项证明。浏览器纯入口不能夹带长期 key、Node 或服务端工厂。实际麦克风、MOSS/Agora 与手机锁屏依赖设备和已授权服务，本轮不借其他家目录凭据验证。

#14 的 `57faf46c` 不在本分支；迁移只能保持现有 dictation API/插入接缝，后续需在其共享 composer 接回目标/选区、取消和迟到回执，不能在本分支补第二份编辑器。
