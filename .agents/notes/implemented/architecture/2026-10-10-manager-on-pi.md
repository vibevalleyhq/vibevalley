# Agent Note: 管家是服务端里的一个 pi 会话

Status: implemented

> 已被取代：管家跑在 VibeValley 自己的 agent 上（[自己的 agent](2026-10-12-own-agent-on-effect.md)）；Go 服务端没有 pi 管家，`VIBEVALLEY_FOREMAN_RUNTIME=pi` 被拒绝（[服务端用 Go 重写](2026-10-13-go-server-on-smith.md)），`foreman-pi.ts` 随 TypeScript 服务端删掉了（[一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md)）。下面是当时的决策。

## Problem

管家要理解主人的话、派活、盯进度、转述汇报。它需要一个大模型、一组能直接调用帮工的工具、记得住的对话，并且要能很快接上：最早的方案是走 Claude API，自己写工具循环，挂在 Agora 的自定义大模型接口后面，但那条路要公网隧道，接起来慢。

## Decision

设 `VIBEVALLEY_FOREMAN_RUNTIME=pi` 时，管家是服务端进程里的一个 pi 会话（`@earendil-works/pi-coding-agent` 的 `createAgentSession`，`apps/server/src/foreman-pi.ts`）；默认的管家已经换成 VibeValley 自己的 agent，见 [自己的 agent](2026-10-12-own-agent-on-effect.md)。pi 这一版：

- 用本机 pi 的登录，不要另外的 API key。模型依次取 `VIBEVALLEY_FOREMAN_MODEL`、农具房里 pi 的默认模型（现在是 DeepSeek V4.1 Flash）、本机 pi 的默认模型；思考强度默认 `low`。
- 只带 VibeValley 的提示词和工具（`foreman-tools.ts`，和 VibeValley 自己的 agent 共用；pi 拿它们的 JSON Schema），不加载本机 pi 的扩展、技能、提示模板和 AGENTS.md，也没有读写文件、跑命令的工具。
- 会话存在 `$VIBEVALLEY_HOME/manager`，启动时接着最近的一个。
- 每句话前面附上「农场现状」，管家不用先查也知道现场。帮工在田头上自己汇报；没做成的汇报作为一条消息交给管家，它说卡在哪、问下一步（[农场群聊](../feature/2026-10-11-farm-group-chat.md)）。

具体行为见 [server.md](../../../../docs/server.md)「管家」。

## Alternatives considered

**Claude API 加自己写的工具循环。** 要自己管对话历史、工具调用和流式输出，还要一个 API key；pi 已经有会话、流式、工具定义和持久化。

**让 Agora 托管的大模型当管家。** 它看不到农场，也调不了我们的工具；现在它只负责语音里的寒暄，听到的话转给 pi 上的管家（[voice-through-agora-quickstart](../feature/2026-10-10-voice-through-agora-quickstart.md)）。

**管家也用 oar 的子 agent。** 子 agent 是编码 runtime，带全套读写和执行工具；管家要的是一组受控的农场工具和低延迟。

## Consequences

不用额外的钥匙，几分钱就能跑一天。管家和帮工用同一个模型时，换模型一处就够。代价是依赖本机装好并登录 pi；pi 的 API 变了要跟着改 `foreman.ts`。
