# Agent Note: 语音用 Agora ConvoAI，照官方示例搬过来

Status: implemented

## Problem

VibeValley 的本意是用说话指挥团队。语音要识别、对话、合成和实时音频，自己搭整条链路成本很高。

## Decision

用 Agora 的 Conversational AI（[voice.md](../../../../docs/reference/voice.md)）：

- 先把官方示例 `agent-quickstart-nextjs` 原样跑通，再按它的代码搬进 VibeValley（当时改写成 Effect；现在服务端是 Go，用 Agora 的 Go SDK）：服务端签 RTC + RTM 令牌、请语音管家进出频道（`server/internal/voice/agora.go`，声网本身的部分在 `server/pkg/agora`）；客户端用 Agora 的 Flutter SDK 加入频道、发布麦克风、收字幕（`app/lib/voice/`）。网页那一半（`web/src/voice/agora.ts`，core 的 `VoiceApi`、`VoiceLink`）随网页删掉了。
- 出声回答的默认是 Agora 托管的大模型（`gpt-4.1-mini`）、识别用 ARES 中文、合成用 MiniMax 中文音色（都能在声音页改，「想」后来也能选农场的管家，见 [语音接到我们自己的管家](2026-10-10-voice-through-our-manager.md)）。它听到的一句话交给农场的管家（`manager/hear`）：管家只派活、不回话。
- 凭据在首页「设置」里填（`$VIBEVALLEY_HOME/settings.json`），或者写进配置（`$VIBEVALLEY_HOME/vibevalley.yaml`、环境变量）；缺了语音不可用，别的照常。

## Alternatives considered

**马上让 Agora 调我们自己的管家（自定义大模型接口）。** 要 Agora 云端能访问本机，得开公网隧道，而帮工能执行任意命令；当时留作下一步，后来主人确认后接上了，只对外开一个接口（[voice-through-our-manager](2026-10-10-voice-through-our-manager.md)）。

**凭记忆直接写。** Agora 的 SDK 和接口参数多、版本变得快；照能跑通的官方示例搬，最快接通。

**自己接识别和合成。** 要处理回声、打断、延迟，工作量远超这一步需要的。

## Consequences

按麦克风就能说话派活，字幕进田头窗口。代价是语音里回答的大模型看不到农场，只会礼貌地确认（「想」选了农场的管家时不是这样）；真人说话、听到声音还要人亲自试。

## Verification

先用官方示例自己的 `pnpm dev` 跑通一次（语音管家进了频道，欢迎语经 RTM 到了字幕），再搬进 VibeValley。自动验证过：服务端签令牌、请语音管家进出频道；无头浏览器用模拟麦克风在 VibeValley 页面上接通、收到中文欢迎语、打字派活后语音管家出声回答且帮工被派出、挂断后它离开。真人说话、听到声音要人亲自试。

这些是网页版时的验证。现在服务端拼出的声网请求由 `server/internal/voice/agora_test.go` 守着，Flutter 客户端的语音在 macOS 上实测过（[客户端迁到 Flutter](../architecture/2026-10-13-flutter-client-over-ts-server.md)）。
