# Agent Note: 声音页：Agora 和语音管家的设置在一页里改，只存改过的

Status: implemented

## Problem

语音管家的一切都写死在服务端的 `agora.ts` 里：人设、开场白、区域（固定美国）、识别语言、断句的停顿、音色和模型（只有两个环境变量能换，改了要重启）。中国大陆的 Agora 项目连不上美国区，想换个音色、改句人设都得改代码。凭据虽然能在首页「设置」里填，但和语音的其他配置散在两处。

## Decision

工作台加一页「声音」（`/voice`，`app/lib/desk/voice/`），行为见 [voice.md](../../../../docs/reference/voice.md)「配置」。

- **形状只定义一次**：`VoiceSettings` 和存的形状 `SettingsUpdateVoice` 在 `server/internal/protocol/shapes.go`，默认值 `DefaultVoice`、范围和校验 `VoiceProblem` 在同一个包的 `voice.go`，Dart 的类型由它们生成。（当时存的形状 `VoiceOverrides` 由 `VoiceSettings` 每个字段变成可选得来，不另写一份；形状改在 Go 里写以后，`SettingsUpdateVoice` 是逐个字段写成可选的另一个结构体，见 [形状的源头是 Go](../architecture/2026-10-15-go-owns-the-shapes.md)。声音页在 `app/lib/desk/voice/voice_rules.dart` 照搬了一份 `voiceProblem`。）
- **和钥匙放在一起**：存在同一个 `settings.json` 的 `voice` 里，走同一个 `GET/PUT /api/v1/settings`；`SettingsStatus` 带上 `voice`（在用的）和 `voiceDefaults`（内置默认，再叠环境变量 `voice.model`、`voice.id`）。
- **只存改过的**：页面存的是和默认不同的字段（`voiceOverrides`），`voice` 整个替换，`{}` 就是恢复默认、从文件里删掉。以后默认的人设改进了，没改过的人自动用上。
- **每通电话现取**：`voice/agora.go` 每次开始时从 `Settings.Voice()` 取，存了下一通生效，不用重启。
- **三段各选服务**：识别、大模型、合成各是一个按 `vendor` 分的封闭联合（`VoiceASR`、`VoiceLLM`、`VoiceTTS`），`voice/agora.go` 的 `voiceVendorsFor` 逐个 `switch` 建出 agora-agents（Go 版 `agora-agents-go`）的对象。默认全用声网托管的，不要别的 key；要 key 的（微软、自己的接口）每段一个 key（`asrKey`、`llmKey`、`ttsKey`），和农场的钥匙一样只给页面看提示。DeepSeek 直接用农场已有的 DeepSeek key，走它 OpenAI 兼容的接口。
- **只给常用的几家**：agora-agents 支持几十家，页面只放托管的（ARES、Deepgram、GPT、MiniMax、OpenAI tts-1）、微软（识别和合成都有，国内外都能用）、DeepSeek 和任意 OpenAI 兼容接口（通义、Kimi 这些都走它）；「想」后来又多了农场的管家（[语音接到我们自己的管家](2026-10-10-voice-through-our-manager.md)）。加一家就是联合里多一个成员：Dart 的编译器会指出声音页里按联合 `switch` 的地方；Go 的编译器不查类型 `switch` 漏没漏，所以 `voiceVendorsFor`（`server/internal/voice/agora.go`）的测试按生成的成员表（`VoiceASRMembers`、`VoiceLLMMembers`、`VoiceTTSMembers`）挨个试，漏补的那家测试不过。

## Alternatives considered

**单独的 `/api/v1/voice/settings` 和单独的文件。** 凭据已经在 `settings.json`，分两处存，页面就要两个请求、两套「存好了没」；放在一起，声音页和首页「设置」改的是同一份凭据。

**整份存下来。** 简单，但默认的人设、开场白以后改了，存过一次的人永远停在旧的上；只存差异避免这个。

**照搬 Agora 的全部参数（VAD 阈值、前置填充、历史条数……）。** 页面会很长，大多数没人会动；只放听、想、说里会想改的几样，其余留在代码里。

## Consequences

- 改了不影响正在进行的电话，页面上写明「下一通电话生效」。
- 区域在叫停时也按当前设置选；通话中改了区域，那一通的停止请求可能发到新区域（通常也能停，停不了它 30 秒没人会自己走）。
- 语言和人设是两处：换了语言要自己把人设里的「用中文回答」改掉，页面提示了。
- 一段只存一个 key：从微软换到别家再换回来，key 还在；两家都要 key 的同一段（以后加了）会共用这个格子，到时候再分。

## Verification

- `server/internal/setting/setting_test.go`：环境变量给默认；存的只有改过的字段；存钥匙不动语音；`{}` 回到默认并从文件里删掉；超出范围、人设为空、地址不对的不存；服务自己的 key 存下来、页面只看到提示。
- `server/internal/voice/agora_test.go` 的 `TestVoiceVendorsSayWhichKeyIsMissing`：托管的不要 key，缺 key 的说缺哪个，DeepSeek 用农场的 key。
