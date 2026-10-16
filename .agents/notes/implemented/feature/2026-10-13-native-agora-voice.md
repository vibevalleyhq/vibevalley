# Agent Note: MyGo 的 Agora 原生语音

Status: implemented

> 已被取代：MyGo（连同它的 Swift 语音助手）随 [一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md) 删掉了。原生语音现在在 Flutter 应用里，用 Agora 的 Flutter SDK，macOS 上字幕走 RTC 的 data stream（[客户端迁到 Flutter](../architecture/2026-10-13-flutter-client-over-ts-server.md)）；云端管家的请求仍由 Go 服务端按农场的设置拼（`server/internal/channels/voice_agora.go`）。下面是 MyGo 当时的决策。

## Problem

用户将 MyGo 后续迁移的优先级明确为 Agora 原生语音。WebView 通话依赖浏览器采集、播放与 WebRTC 行为，需要用真正的 macOS 音频链路验证。

## Decision

Go 用 Agora Agents Go SDK v2.12.0 签发 RTC/RTM 令牌并启停云端管家。随包的 Swift `vibevalley-voice` 子进程使用 macOS RTC 4.7.0 和 RTM 2.3.0：负责麦克风、播放、音量、远端用户和 RTM 消息，通过 stdin/stdout JSON 管道与 Go 通信。App Certificate 仅留在 Go；子进程收到的只有 App ID、短期令牌与频道，不经命令行传递。

`VoiceSignal`、`VoiceTurn` 和 `AgentMood` 的形状放在 protocol，core 继续拥有通话生命周期。桌面桥 `nativeVoice` 选择原生 VoiceLink，普通网页和 Electron 仍用已有 Web 适配器。页面通过同源控制接口与 SSE 接收经过校验的事件，不调用浏览器麦克风 API。

原型桥曾带 `voiceDispatch: false`：转写只参与通话，不送到当时还没移植的编码管家，免得每句话触发未实现的 `/api/dispatch`。Go 服务端有了真的管家以后（[服务端用 Go 重写](../architecture/2026-10-13-go-server-on-smith.md)），MyGo 改回 `voiceDispatch: true`，和 Electron 一样派工。

配置与入口当时写在 `apps/mygo/README.md`（已删，见 git 历史）。

## Alternatives considered

**继续用 Web RTC。** 能复用现有代码，但没有验证用户指定的原生音频架构。

**Agora Golang Server SDK 直接做 Mac 客户端。** 其公开说明将 macOS 限于开发用途；本次使用正式 macOS 原生 RTC SDK。

**把所有 native 调用做进 Go 进程。** 需要维护 Objective-C 回调与生命周期桥；独立 Swift helper 使用 SDK 的直接接口，更容易限定资源与退出边界。代价是应用不再是纯 Go 单文件产物。

## Consequences

SDK 归档固定版本与 SHA-256，保留 framework 结构，只分发 arm64，并对框架和应用重新做临时签名。需要 Xcode/Swift 构建链，但运行时不需要 Node。

云端管家的识别、模型和音色照农场的语音设置（设置页能改，默认 Ares、Agora 托管 gpt-4.1-mini 和 MiniMax 中文音色）。单通话上限 15 分钟；连接上限 45 秒；页面事件订阅断开、挂断或应用退出会停止本地进程并请求停止云端管家。

App ID/Certificate 从农场的设置取得（家目录的 settings.json，否则 `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`），不进入源码、安装包和日志；设置页能改。

## Verification

离线 Go 测试覆盖转写合并、状态过滤、重复连接、helper 退出和过期断开不影响新通话；core 测试覆盖原生消息协议的合法与非法输入。

真实短通话观察到 RTC/RTM 连接、语音管家加入、麦克风和远端音量非零、原生 RTM 发消息及字幕返回。MyGo 窗口内手机入口显示通话中和管家问候字幕，并进行了用户语音与管家回复的往返。挂断退出后未发现残留 helper。

初次界面验收暴露自动调用未迁移 dispatch 的 409，随后通过明确的 voiceDispatch 能力标记修复并重启修正版。

带原生 SDK 的本机产物约 `.app` 77 MiB、DMG 41 MiB。此数字仍不含真实编码 agent、PGlite 和完整业务后端。没有声称完成长时间通话、实际令牌到期续期、设备切换或跨平台验收。

### 字幕延迟排查

原生端先订阅 RTM Message 和 Presence，再加入 RTC；云端管家等待订阅确认。页面复用 Electron 的 Agora toolkit TEXT 解析器和字幕映射，删除 Go 自写的转写合并规则，补上此前遗漏的 Presence 状态通知。

结束静音曾试调到 300 ms，但没有完整端到端证据支持改善。对齐时恢复 Electron 的实际配置。云端管家的请求现在由 Go 服务端按农场的设置拼（`farm.Voice.Native`，和网页语音同一份），几种配置的请求由 TypeScript 的 `voiceAgentFor` 生成过一次，存成 `server/internal/farm/testdata/voice-requests.json`，Go 测试逐字比对；TypeScript 服务端删掉以后这份对照冻结，Go 的 `Voice` 是唯一的来源，避免提示词、历史条数和模型参数漂移。Go 和 Node 的 MiniMax 内部标记名称不同，需要在边界转换；测试比较最终 SDK 请求，避免只比较工厂对象却遗漏托管 preset。

内存诊断只记录时间、长度和数值，不含转写或密钥。请求对照与字幕／状态回放用于验证行为对齐；真实音频采集和播放仍由不同 SDK 负责，不能据此宣称延迟相同。

参数核对覆盖 Electron 打包产物与实际采集设置。原生补齐 RTC 数据流与 toolkit 分片拼接，去掉 RTM 的额外 publisher 过滤；完整对照和证据边界当时写在 `apps/mygo/VOICE_PARITY.md`（已删，见 git 历史）。请求基准按实际区域生成并检查 URL。不同平台的 SDK 默认值按采集、编码和云端三层分别核对，避免把云端 chorus 当成客户端场景、把采集率当成发送采样率。

实时字幕验收增加独立回放模式：不依赖云端，使用实际 SSE、解析器、core 和 MyGo 手机界面，只发中间稿。这能区分「最后能看到文本」与「中间稿能直接显示」，但不代替真实采集验收。关闭唯一窗口触发统一退出清理，诊断携带构建标识，避免磁盘新包与残留旧进程混淆。
