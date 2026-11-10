# Agent Note: 频道里用 /imagegen 生图

Status: proposed

## Problem

用户想在频道里直接要图：打 `/imagegen 一只在麦田里打盹的橘猫`，过一会儿图就出现在这个频道里。现在做不到：

- 生图（`Media.createImage`，MOSS）只有两个入口：用户在素材库（`/library`）的「生成」对话框里填表，或者助手调 `media.image.create` 工具（只在承接用户那一轮）。生成好的图存成本机附件，要用户回媒体页手动发到频道。
- 助手的大脑建时写着 `noSkills: true`（`session/host.ts`），它一个 skill 都看不到；VibeValley 也没有自带给助手的 skill。
- 输入框的斜杠命令只有 `/issue`、`/remember`、`/stop`、`/dm`。

## Proposal

**一个 skill，一条路。** 生图的写法（怎么把一句话扩成 MOSS 的提示词、尺寸怎么选、重试保持同一个 id）写成 VibeValley 自带的 skill `imagegen`，放在 `apps/server/src/orchestrator/skills/imagegen/SKILL.md`，和内置模板一样随服务端打包（`base/assets.ts` 的 `serverFiles`）。助手的大脑读这个目录（不再 `noSkills`），系统提示里列出它，助手照 skill 调已有的 `media.image.create`，不新加生图的接口。

**`/imagegen` 交给这里的助手。** 输入框加一个 `/imagegen` 命令：把这一行原样作为用户的话发到当前频道，带上 `to`（`SayRequest.to`），值是服务端算好的「这里的助手」（`T.Channel.orchestrator`，由 `orchestratorIn` 算）。服务端核对 `to` 是助手，写进消息的 `ingressRecipient`：只有他收到，频道里没有成员也有人接，不叫醒别的成员。页面只读帧里的字段，不重写谁是这里的助手。用户在承接这一轮，所以助手可以生图（现有的 `forOwner` 规矩不变）。

**生成好自动发回。** 来源是助手、带来源频道的生图任务，下载完变成 `ready` 时，由 Media 以那个助手的名义在来源频道发一条带图的消息（`Channel.announce` 从只带 Artifact 卡片扩成「做出来的东西」：卡片或附件，可带 `sendKey`）。`sendKey` 用 `media:<任务 id>`，同一个任务只发一次；在 `ready` 和发出之间停机的，重启时把最近的任务再发一遍，靠 `sendKey` 不重复。发图失败不影响任务是 `ready`。用户在 `/media` 页自己发起的任务照旧不自动发。

不做：帮工生图（帮工没有生图权限，不变）；图片编辑、参考图（MOSS 这里不支持）。

## Alternatives considered

- **服务端认出以 skill 名开头的用户的话，自己交给这里的助手。** 服务端得知道助手有哪些 skill（读目录）、再从正文里认命令；`to` 更直接，也是一个通用的「对这个助手说」。
- **`/imagegen` 在页面直接调 `media.image.create`。** 提示词就是用户那句原话，没有 skill 的作用（扩写、选尺寸），也绕开了助手；以后别的 skill 还得各写一个页面命令。
- **skill 写成档案上的 `T.Skill`。** 那套是拼进帮工提示的，助手不读；生图归助手。
- **生成好由助手自己轮询任务再发图。** 助手一轮早就结束了；轮询费 token，也可能没人醒着。完成的那一刻在 Media 里，就在那里发。

## Acceptance criteria

- 在一个频道里发 `/imagegen <描述>`：这里的助手收到这一句（频道没成员也一样），读 `imagegen` skill，调一次 `media.image.create`，任务来源是这个助手和这个频道。
- 任务 `ready` 后，来源频道里出现一条助手发的带图消息；同一任务重试下载或重启后不多发。用户在素材库「生成」对话框里发起的任务不自动发。
- 服务端测试：skill 随服务端带着、写的工具名就是助手的工具名（`orchestrator/skills.test.ts`），助手的系统提示列出它（`orchestrator.test.ts`）；带 `to` 的用户发言只投递给那个助手、`to` 指向帮工被拒（`channel.test.ts`）；助手发起的生图完成后发回来源频道、重启后仍只一条，用户自己的不发（`media.test.ts`）。页面：`commandOf` 认得 `/imagegen`（`commands.test.ts`）。
- 文档：`docs/subsystems/media.md`、`channel.md` 写上这条路。

## Risks

- **助手不照 skill 做。** skill 写清楚触发词和步骤；测试用脚本模型只验接线，真模型的表现用助手评测（花钱，先问用户）。
- **打包漏了 SKILL.md。** 加进 `serverFiles`，`server-pack.test.ts` 查得到。
- **花钱。** 只有用户自己打的 `/imagegen` 会生图；助手自主巡查时仍不能生图。
