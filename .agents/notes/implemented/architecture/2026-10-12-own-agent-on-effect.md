# Agent Note: 自己的 agent：完全用 Effect 写，当管家，也当帮工

Status: implemented

> 实现已被取代：VibeValley 自己的 agent 现在是 Go 写的（`server/pkg/ai`、`agentcore`、`agent`，`packages/ai`、`agent-core`、`agent` 的移植），管家在 `server/internal/manager/manager.go`，帮工用的 `vibevalley` 农机（下文当时叫 `heybro`）是 smith 的 runtime（`server/pkg/agent/oarruntime`），命令行是 `server/cmd/vibevalley`；`manager.runtime=pi` 被拒绝（[服务端用 Go 重写](2026-10-13-go-server-on-smith.md)）。TypeScript 的包随 [一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md) 删掉了。「自己的 agent 当管家、也当帮工」这个决定照旧；下面「完全用 Effect 写」是当时的做法。

## Problem

管家原来是一个 pi 会话（[管家在 pi 上](2026-10-10-manager-on-pi.md)），帮工是 oar 包着的第三方编码 agent。VibeValley 是一个 personal agent，它最核心的那个「脑子」却是别人的：

- pi 的会话、工具、压缩、记性都在它的 SDK 里，VibeValley 只能从外面喂提示、听事件；想加一种能力（定时醒来、按需加载技能、开子 agent、接 MCP），要么等 pi 支持，要么绕开它。
- 服务端、core、protocol 都是 Effect，唯独管家这一段是 Promise 和回调，错误、取消、资源释放都要在两种世界之间翻译。
- 主人想要一个自己的、像 nanobot 那样有完整能力的 agent，能在 VibeValley 里当管家、当帮工，也能单独跑。

## Decision

VibeValley 有自己的 agent，`@heybro/agent`，完全用 Effect v4 写，参照 nanobot 和 pi-coding-agent。它建在两个更底下的包上（为什么这样分、名字为什么照 pi，见 [ai 和 agent-core](2026-10-12-ai-and-agent-core.md)）：`@heybro/ai` 调模型，`@heybro/agent-core` 跑循环。它不知道农场：农场的工具、现状由服务端在装它的时候给。

它有这几组能力，用法和细节当时在它的 README（`packages/agent/README.md`，已删，见 git 历史）：

1. **循环和基础工具**：读写文件、按原文改、列目录、ripgrep、跑命令（带超时）、抓网页；说话中途来的话插进这一轮（`send`），要等这一轮做完的放进后面（`later`）；每次运行有步数上限。会话一行一条存在磁盘上，重启接着聊；太长时早先的部分压成摘要，原文归档。
2. **技能和记性**：技能照 Agent Skills 的约定找 `SKILL.md`，系统提示只列名字和什么时候用，用到时 `load_skill` 读正文；记性是自己目录下的 `MEMORY.md`，系统提示里带着，`remember`、`rewrite_memory` 改它，`search_archive` 翻压掉的旧对话。
3. **帮手和 MCP**：`spawn_agent` 开一个不存盘的帮手做一件事，同一步派几个就同时做；MCP 客户端（HTTP 和 stdio）把服务器的工具原样交给模型。
4. **定时**：`schedule` 记下「什么时候、做什么」（某一刻、每隔几分钟、cron），到点把那句话交给自己；存在磁盘上，错过的开机只补一次。

模型用 DeepSeek（默认 V4.1 Flash），密钥从 `DEEPSEEK_API_KEY` 读，没有就用 pi 配好的。

在 VibeValley 里它有三个位置：

- **管家**（`apps/server/src/foreman-agent.ts`）：默认就是它，`VIBEVALLEY_FOREMAN_RUNTIME=pi` 换回 pi。管家的工具在 `foreman-tools.ts` 里用 Effect Schema 定义一次，pi 拿它们的 JSON Schema，所以两种都能用。管家没有编码工具、不派帮手、不加载技能，有记性和定时；农场现状在系统提示里，没叫醒它的汇报记成 `farmNews`，人说的话插进这一轮，定时、提醒和汇报等这一轮做完（[server.md](../../../../docs/reference/server.md)「管家」）。
- **帮工**（`apps/server/src/vibevalley-runtime.ts`）：包成 oar 的一种 runtime `heybro`，照 oar 自己的 scripted runtime 用它的 runtime-author SPI 写，「农具」页里多一台；帮工在自己的 worktree 里干活，拿全部基础工具，农场工具经会话给的 MCP 服务器来；花费按模型表的价钱算，可以设每日预算（[agents-and-runtimes.md](../../../../docs/reference/agents-and-runtimes.md)）。
- **命令行**（`pnpm --filter @heybro/agent cli`）：不开 VibeValley 也能跟它聊、让它干活。

## Alternatives considered

**接着用 pi，缺什么在外面补。** 定时、子 agent、MCP、按需技能都得在 pi 外面再搭一层，搭出来的还是两套世界；pi 的版本一变还要跟着改。pi 作为管家的开关和帮工的一种 runtime 留着，不是因为要靠它，而是让主人能选。

**用 nanobot 本身。** Python，有自己的总线、渠道、记性，会和 VibeValley 的田头、连接器重复成两套（[频道和定时任务](../feature/2026-10-11-channels-and-schedules.md)里已经否决过把它当外壳）。参照它的结构，用 Effect 重写需要的部分。

**用 Vercel AI SDK、LangChain.js 这类框架。** 能用，但又是 Promise 世界；和整个仓库一套写法、取消和资源释放跟着 Effect 走，比少写几百行更要紧。

**先当帮工再当管家。** 帮工要的是完整的编码能力，要和 Claude Code、Codex 比；管家要的工具是 VibeValley 自己的、事情也简单，先在管家这里把循环、会话、压缩磨稳更合适。实际也是这个顺序。

## Consequences

- VibeValley 的「脑子」是自己的：要加一种能力，改自己的包；管家、帮工、命令行用的是同一份代码。
- **DeepSeek 的工具调用**没有 Claude 稳：靠步数上限、坏参数时给模型一句看得懂的错误、可选参数传 null 当作没填来兜住。
- **跑命令没有沙箱**，和别的帮工一样：只在工作目录里开工、服务端只听本机。管家不给 shell 和写文件的工具。
- **压缩会丢细节**：原文归档、摘要里写明归档在哪，`search_archive` 能翻回去。
- 多了要维护的东西：provider、循环、会话格式、oar runtime 都要自己跟着上游（DeepSeek、Anthropic、oar）改。

## Verification

- 不连网的测试：`packages/agent`（循环、插话、步数上限、会话和旧文件转换、压缩、技能、帮手同时做、定时、现状不存、停下），`apps/server/test/foreman.test.ts`（管家派活、语音只做不说、汇报作为 farmNews、定时叫醒），`apps/server/test/vibevalley-runtime.test.ts`（oar 会话：工具、事件、插话、排队和撤回、停下、接着上次、MCP 工具、失败）。
- 真跑过：命令行在 DeepSeek 上读、改、复查文件；管家记住偏好、定的两分钟提醒到点在田头上说了；管家把活派给跑在 `heybro` 上的帮工，帮工在自己的 worktree 里写文件、提交，经农场工具在田头上汇报。
