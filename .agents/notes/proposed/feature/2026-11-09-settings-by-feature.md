# Agent Note: 设置按功能分，钥匙放一处，没准备好就指路

Status: proposed

## Problem

设置按「技术来源」分页，同一件事散在几处，没准备好的功能要等用到才失败：

- **钥匙在四个地方**：DeepSeek 在「模型」，MOSS 在「AI 服务」，声网 App ID 和证书在「通话线路」，听写还能填自己的地址。想知道还缺哪把钥匙得逐页翻；能用哪些模型也只在 MOSS 卡片里「查询模型」后才看得到。
- **一个功能几处设**：MOSS Live 是「AI 服务」表里的一行、自己一页、又是「通话线路」里「谁接电话」的一个选项；「听写」页只有一个开关和一条去「AI 服务」的链接。
- **MOSS Live 页是调试台**：试音、线路质量、对话、线路上的消息是调试；「实时视觉理解」和「向 Live 通话分享画面」两块说明和选法一样，重复。
- **用到才失败**：生图没绑定时 `/imagegen` 照样发给管家，管家交任务失败后才说去设置。准备状态只有两个零散的标志（`SettingsStatus.dictationReady`、`mossReady`），别的功能页面不知道。

## Proposal

三步，一步一个提交：

**一、每个功能的准备状态由服务端给。** `SettingsStatus.readiness: Record<Feature, Readiness>`，取代 `dictationReady`、`mossReady`（内部不留兼容）。`Feature` 是 `orchestrator`（管家想事情用的模型）、`image`、`understanding`、`speech`、`speakers`、`voiceDesign`、`transcription`、`dictation`、`live`、`vision`、`call`；`Readiness` 是 `{ ready: true }` 或 `{ ready: false; missing }`，`missing` 说缺什么：`deepseekKey`、`mossAccount`（还没有 MOSS 连接）、`mossKey`、`mossOff`（连接被停用）、`binding`（这个用途没选连接）、`agora`（声网凭据）、`dictationUrl`。规则只在 `apps/server/src/setting` 一处（复用 `boundConnection`），页面只读结论。页面用一个函数把 `missing` 翻成「还缺什么、去哪填」；用到的地方先挡住：输入框的 `/imagegen` 在生图没准备好时，菜单那一行写「生图还没设置」，按下去打开对应的设置，不把这一行发给管家。

**二、「账号与钥匙」一页。** DeepSeek、MOSS（多个连接）、声网的钥匙都在这一页，每个账号一张卡：钥匙的状态、去哪取、能用的模型（MOSS 按用途列出已适配的模型，查询目录后列出账号看得到的）。其余页不再填钥匙，只链到这里。

**三、功能页照功能排。** 「管家」（用哪个模型）、「生图与媒体」（六个媒体用途各用哪个模型）、「通话」（谁接电话、听、断句；MOSS Live 与实时视觉用哪个模型；调试收进一个折起的区，重复的画面分享删一份）、「听写」（MOSS 还是自己的地址、哪个模型）。每页顶上一行准备状态：「可以用了」或「还缺：…→ 去填」，链到「账号与钥匙」里对应的卡。

## 进度

| 步 | 状态 | 提交 | 做了什么 |
|---|---|---|---|
| 一 准备状态 | 完成 | `c50f118d3` | `SettingsStatus.readiness`（规则在 `apps/server/src/setting/readiness.ts`）；页面的 `fixOf`（`apps/web/src/infra/readiness.ts`，现在指向「模型」「AI 服务」「通话线路」「听写」，第二步改指「账号与钥匙」）；`/imagegen` 没准备好时打开设置 |
| 二 账号与钥匙 | 未做 | — | |
| 三 功能页 | 未做 | — | |

## Alternatives considered

- **页面自己从设置里推准备状态。** 规则（连接要启用、要有钥匙、要绑定）会在页面和服务端各写一份；照「页面不折事实」，结论由服务端给。
- **只改 `/imagegen` 的提示。** 媒体页、通话、听写同样卡；一处规则、一个指路函数，各处都用。

## Acceptance criteria

- `GET` 设置的答复里有 `readiness`，十一个功能各一条；`dictationReady`、`mossReady` 不在了。服务端测试覆盖每种 `missing`。
- 生图没准备好时，`/imagegen` 不发出消息，而是打开设置；准备好了照旧交给这里的管家。页面测试覆盖两种。
- 「账号与钥匙」一页能填三家的钥匙、看到能用的模型；别的页不再有钥匙输入框。
- 功能页顶上的准备状态和 `readiness` 一致，「去填」打开对应账号的卡。
- 截图：浅、深两种主题，1280 与 390 两种宽度；`web:check`、`server:check`、相关页面测试通过。

## Risks

- **改设置页会碰很多页面测试**（按 `data-testid` 找元素）：保留原有的标记，挪位置时跟着改测试。
- **语音通话的设置细节多**（识别、断句、谁接电话）：第三步只挪位置、不改它们的意思。
