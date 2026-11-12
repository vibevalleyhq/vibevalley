# Agent Note: 大脑换成上游的 pi-durable

Status: proposed

## Problem

2026-10-27 为了让大脑整个跑在 Effect 里，把 pi-ai 和 pi-agent-core 重写成了 `packages/ai`、`packages/agent`（循环、压缩、前缀校验、`.jsonl` 会话、技能、MCP、子帮手、自己的任务图），又在 `session`、`mailbox` 里自己做持久和恢复。2026-11-12 拿掉 Effect 时它们照退路原样改成了普通 TypeScript（[地基](docs/subsystems/foundation.md#为什么这样)），重写本身留了下来：

- 助手（`session/host.ts` 的 `makeHost`，进程内直接调 `makeBrain`）和自己的农机（`runtime/vibevalley.ts`，经 oar 的 `defineRuntime`）都不持久：服务端在助手回答到一半时停掉，重启后这一轮不会接着答，只靠 [talk.test.ts](apps/server/src/flows/talk.test.ts) 守着的「重启后回到同一个对话」。
- 上游的 `@earendil-works/pi-durable`（1.5.2）已经是一整套 harness：输入、每一轮、每个工具调用先落盘再显示，进程死掉后从断点接着跑；自带 `read`、`write`、`edit`、`bash`（`/tools` 的 `CodingTools`）、扩展、压缩、子任务、任务图、用量和费用；`conversation.watch()` 给出界面要的全部状态。`@earendil-works/pi-ai` 1.5.2 有 DeepSeek 的 provider（处理 `reasoning_content`）和测试用的 faux provider。

oar 0.101（最新）带的 pi-durable runtime 写在 1.4 上（peer `~1.4.0`），而 1.5 去掉了它用的 `watchEvents`、改了压缩事件的字段，所以用最新的依赖就不能用它：农机那一侧由我们自己照 oar 的 `Runtime` 契约写一个，oar 跟上 1.5 以后换回它的。

## Proposal

依赖全用最新：`@botiverse/oar` 0.101.0、`@earendil-works/pi-ai`、`pi-durable`、`chord`、`pi-schema` 1.5.2，版本钉在 catalog；oar 对 pi-durable、chord 的 peer 在 `pnpm-workspace.yaml` 的 `peerDependencyRules` 里放到 1.5.2，注释写明为什么、什么时候删。

**存储（A）**：每个服务端一个 SQLite 文件，`$VIBEVALLEY_HOME/durable.db`（`openNodeSqliteStorage`，WAL）；测试农场用 `MemoryStorage`，要测重启的用临时家目录里的文件。会话的转写不是核心状态，核心状态仍只在 Postgres 一份；Postgres 的存储后端（过 pi-durable 的一致性测试）以后单独做，换后端不碰别处。

**一个 Harness，归 runtime 模块**：`apps/server/src/modules/runtime/durable.ts` 开、关这个 `Harness`（`Harness.open(storage, { models, registry })`），`models` 由 Provider 的 DeepSeek 连接每次现取（钥匙换了就用新的）；它是 Runtime 服务的一部分，`close()` 时关。

1. **P0 助手持久（不花钱）。** `makeHost` 的接口（`AgentHost`）不变，里面从 `makeBrain` 换成 Harness 的一个 conversation：
   - 一个会话一个 conversation，id 记在会话上；`submit` 是 `conversation.submit`（忙时 steer，闲时开一轮），`stop` 是 `abort`，`resume` 是重开以后 Harness 自己接着跑。
   - 我们的工具（`Tool`：JSON Schema 加 `execute`）由一个函数包成 `defineTool`，`ToolFailed` 照旧是模型读到的失败结果；会改东西的工具不声明 `replay: "safe"`，断在中间时模型读到 `interrupted`。
   - 事件：`conversation.watch()` 的提交读成现在 `BrainEvent` 喂给 `journal` 和 `reaction` 的那几样（开始、文字、工具开始和结束、一轮结束、用量），核心状态的事实不变。
   - 流程测试：pi-ai 的 faux provider 照脚本答；说一句话，在模型答到一半时 `farm.close()`，用同一个家目录再起，它答完，这一轮只记一次。原来 `host` 的测试照旧过。
2. **P1 助手换模型的那一侧。** 用 pi-ai 的 DeepSeek provider 取代 `packages/ai` 的桥；先用离线的录制核对 `brain.md` 记的几处（纯工具的 `content: null`、`reasoning_text`、choice 里的 usage、迟到的工具 id），不对的在 provider 外面补。读 1.5.2 的代码（`api/openai-completions.js`）四处都已处理：助手消息默认 `content: null`，`reasoning_content`/`reasoning`/`reasoning_text` 都读、DeepSeek 的模型带 `requiresReasoningContentOnAssistantMessages`，`choice.usage` 在 `chunk.usage` 缺时读，迟到的工具 id 补到已开的调用上；模型 id（`deepseek-flash`、`deepseek-v4-pro`）和我们的一样。录制核对仍要做。真模型的助手评测在换之前、之后各跑一遍（花钱，先问用户）。
3. **P2 农机。** `runtime/vibevalley.ts` 改成在同一个 Harness 上开 conversation（一个 oar 会话一个，`resume` 找回）、装 pi-durable 的 `read`、`write`、`edit`、`bash`（环境是帮工的工作目录，`bash` 带会话的环境变量、默认 120 秒），MCP、`runtime_todo` 的任务和 `spawn_agent`（调用拥有的子对话）经 `durableTool`，照 oar 的 `Runtime` 契约出事件。放下会话时照 oar 的约定停下这一轮；崩溃留下的一轮在会话再打开时接着跑完。命令行的 `chat` 跑同一个农机，但在 `agent/<名字>/durable.db` 开自己的 Harness（pi-durable 没有跨进程的锁，服务端的那个不能共用）。
4. **P3 删。** `packages/agent` 里自己的循环、压缩、前缀、会话文件、子帮手和任务图，`packages/ai` 里模型的桥和重放，`session`、`mailbox` 里只为它做的恢复；还要的（技能的读法、`dag` 的校验、记性的端口、转写和 MOSS）留在原处或挪到用它的模块。`brain.md` 改成新的样子。

## Alternatives considered

- **用 oar 0.101 自带的 pi-durable runtime，pi-durable 停在 1.4。** 不用自己写适配。没选：主人要最新的依赖；1.5 改了事件和字段，停在 1.4 只是把升级往后推，而且助手本来就不经 oar。
- **以 pi-coding-agent 为底。** 没选：它是建在不持久的 pi-agent-core 上的命令行；作为库，它有的（四个编码工具、会话、压缩、扩展）pi-durable 都有，还持久。它留作 oar 里给帮工用的一种 runtime。
- **存储直接上 Postgres。** 没选作第一步：要自己写后端并过一致性测试，约一周；SQLite 文件开箱就有，以后换后端不影响别处。
- **留着自己的循环，补上持久。** 没选：等于把上游现成的再写一遍，以后上游的新能力（并行工具、新的压缩、任务图）还要再追。

## Acceptance criteria

- P0 的流程测试在：答到一半关掉、重起、答完、只记一次；`session/host` 原有的测试和全部流程测试照旧过。
- 助手和农机都跑在 Harness 上，`durable.db` 在家目录；`packages/agent`、`packages/ai` 里不再有自己的循环、会话文件和模型桥。
- 真模型的助手评测换之前、之后各一张表，放进 PR（花钱，先问用户）。
- `vp check`、`server:check`、`web:check`、`desktop:test`、`docs:verify`、`deadcode` 全过；[vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 的服务端分册走通。
- `docs/subsystems/brain.md`、`session.md` 改成新的样子，删掉本 Note。

## Risks

- **pi-durable 自己标着 Experimental，版本间不打招呼地改 API。** 缓解：版本钉死；对它的用法收在 `runtime/durable.ts` 和 `session/host.ts` 两处；升级时跑全部流程测试和助手评测。
- **oar 的 peer 落后。** `peerDependencyRules` 放宽只为一个我们不用的子模块；oar 跟上 1.5 以后删掉这条，农机那一侧换回 oar 的 runtime。
- **DeepSeek 的细节和 pi-ai 不一致，助手答得不一样。** 缓解：P1 先用录制的响应离线核对，再跑评测对比。
- **两个持久的地方（Postgres 和 `durable.db`）不同步。** 会话的事实仍由 `reaction` 读成事实折进核心状态并记在 Postgres；`durable.db` 只是转写。一轮在 `durable.db` 里完成、事实还没进 Postgres 时重启：重开以后 watch 从头给出这一轮，`reaction` 照 run id 去重。
