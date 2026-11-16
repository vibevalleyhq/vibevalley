# Agent Note: 零密钥远程执行节点、Go 版 OAR 农机驱动与目录双向挂载

Status: proposed

## Problem

在受管平台架构（[总架构路线](.agents/notes/proposed/architecture/2026-11-16-go-managed-platform-roadmap.md)）中，控制面需将实际代码读写、终端命令执行与外部编码农机进程剥离至独立的远程执行节点（延续并深化 [拆出 apps/machine](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md) 的方向），当前面临四项工程缺口：

1. **外部农机适配层强绑定 Node 24**：现有农机调用依赖 TypeScript 版 [`@botiverse/oar`](https://github.com/botiverse/oar)，在无 Node 环境的轻量 Linux 容器或用户裸机上无法单文件启动。
2. **异构 CLI 归因与增量花费口径复杂**：Claude Code、Codex、OpenCode、Qwen Code、Qoder 各家的子任务谱系与 Resume 后历史累计花费口径各异，若简单包装标准输入输出易导致花费重复计算或静默吞掉不支持的启动选项。
3. **跨机环境下技能与记性割裂**：内置智能体可通过数据库接口查[记性](docs/subsystems/memory.md)与[技能](docs/subsystems/agent.md)，但跑在远程机器上的外部编码 CLI（如 Claude Code 与 Codex）只能访问工作目录文件；缺少类似 [Claude Managed Agents 自托管记忆挂载](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory) 的目录投影与自动双向同步机制。
4. **临时沙箱销毁导致交付物丢失**：云端容器沙箱在会话结束后即被回收，帮工在工作目录产出的图表、归档或构建包若未及时抽回中心存储，将随容器一同灭失（对比 [Managed Agents Deliverables 回收](https://platform.claude.com/docs/en/managed-agents/define-outcomes)）。

## Proposal

构建零 CGO、零持久化密钥的单静态二进制 `cmd/vibe-machine`（内部实现归 `internal/machine` 与零外部依赖的 `pkg/oar`），通过 [Go 版 Chord 链路](.agents/notes/proposed/architecture/2026-11-16-go-chord-sync-and-link.md) 主动外连 `vibe-server`，统一提供远程 `ExecutionEnv`、目录级记性/技能双向挂载、产出物自动回收以及异构农机驱动。

## 远程工作目录契约与并发安全执行（`internal/machine`）

[Durable 调度内核](.agents/notes/proposed/architecture/2026-11-16-go-durable-vault-and-governance.md)中的内置工具面向抽象接口 `contract.ExecutionEnv` 编程，不感知工作目录位于本机还是远端容器：

- **首轮推理零阻塞按需绑定**：用户发起纯对话时，`vibe-server` 直接请求模型流式输出；仅当模型首次发出文件或命令工具调用时，控制面才按仓库与农机标签挑选在线 `vibe-machine` 签发工作目录租约（`Lease`），大幅压降首字延迟。
- **同路径细粒度写锁与原子落盘**：并行工具调用修改文件时，`vibe-machine` 按 `(envID, canonicalPath)` 加进程内互斥锁串行化 `WriteAtomic` 与 `EditPatch`，通过同目录临时文件加 `os.Rename` 防止半截写入。
- **无 Shell 参数直传与进程树连根清理**：`Exec` 直接向 `os/exec` 传递参数数组并开启独立进程组（Unix `Setpgid: true`）；一旦调用上下文取消或 `chord/link` 断连超过宽限期，立即向整个负数进程组发送 `SIGTERM` 并在 3 秒后补发 `SIGKILL`，杜绝僵尸孙进程残留。
- **纯 Go 原生图片缩放**：替代上游的 Photon WASM 方案，使用 Go 标准库 `image` 直接读取图片头、按 EXIF 旋转并等比压缩至模型上限（默认 `2000 x 2000` 像素、体积不超过 `4.5 MB`），消除 WASM 线性内存不收缩问题。

## 工作目录技能/记性双向挂载与交付物摆渡

对标 [Claude Managed Agents 技能挂载](https://platform.claude.com/docs/en/managed-agents/skills) 与 [自托管记忆同步规范](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory)，让内置循环与外部编码 CLI 共享同一套文件系统心智：

1. **`.vibe/skills/` 只读物化与 `.vibe/memory/` 双向对账**：`vibe-machine` 认领会话租约时，将档案绑定的技能包与关联[记性](docs/subsystems/memory.md)/[笔记](docs/subsystems/pkm.md)子集下载至工作目录 `.vibe/` 下，并在系统提示开头注入挂载路径说明。会话运行期间，每轮工具调用后（节流间隔默认 `15 s`）自动双向对账：服务端更新下发落盘，帮工对 `.vibe/memory/` 的文件修改上传回服务端生成不可变历史版本；会话结束时执行最长 `30 s` 的最终刷盘并清理临时敏感挂载。
2. **内网私有 MCP 反向穿透隧道**：当企业内网开发机运行 `vibe-machine` 时，直接复用已建立的出站 `chord/link` 通道代理访问内网防火墙后的私有 MCP 服务（对标 [MCP Tunnels](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)），无需开放内网入站端口。
3. **`.vibe/outputs/` 交付物自动归档**：帮工写入工作目录 `.vibe/outputs/` 的文件在回合进入闲置态前，由 `vibe-machine` 自动计算 SHA-256 流式上传至服务端[素材库](docs/subsystems/media.md)与 [Artifact](docs/subsystems/artifact.md)，确保临时容器销毁后交付物永久可查可下载。

## 纯 Go 农机适配层与诚实花费核算（`pkg/oar`）

`pkg/oar` 严格遵守 [`botiverse/oar`](https://github.com/botiverse/oar) 的规范契约，仅依赖 Go 标准库：

1. **自证明归因信封（`RecordEnvelope`）**：每条事件携带会话内单调递增 `seq`、原生 `sessionId`、可选回合 `spanId`、表达帮手谱系的 `agentPath`（根为 `[]`）以及字节级原样保留的原始帧 `raw`，落盘格式兼容 `oar-voyage/3`（[`@botiverse/oar-cli`](https://npm.io/package/@botiverse/oar-cli)）。
2. **前置能力拒绝与无异常结果码**：各驱动静态声明 `RefusedOptions`；调用方传入不支持的选项时在拉起进程前立即返回 `UnsupportedOptionError`，绝不静默忽略；`Prompt`、`Steer`、`Queue`、`Withdraw`、`Abort`、`Compact` 与 `StopTask` 统一返回类型化 `ControlOutcome`；递归派生通过环境变量 `OAR_SUBAGENT_DEPTH` 实施默认深度 `1` 与并发上限 `4` 护栏（参考 [`subagents.md`](https://github.com/botiverse/oar/blob/main/docs/spec/subagents.md)）。
3. **四大主力驱动与「不知则不报」花费基线扣减**（对齐 [`attribution.md`](https://github.com/botiverse/oar/blob/main/docs/spec/attribution.md)）：

| 农机驱动 | 底层通道 | 关键协议边界与增量花费扣减机制 |
|---|---|---|
| **`claude`** | 双向 `stream-json` 控制流 | 解析 `parent_tool_use_id` 投影 `agentPath`；Resume 首轮前主动发 `get_usage` 获取累计 `modelUsage` 作为扣减基线，超时未获基线则置总量为 `nil` 绝不虚报历史账单。 |
| **`codex`** | 线程双向 JSON-RPC | 派生子线程映射为关联子会话；Resume 首轮前捕获重报的历史总账扣减 `cacheRead`、`cacheWrite` 与 `reasoning`；手动压缩期间拒绝新 `Queue` 输入防原生队列抢跑（参考 [`manual-compaction.md`](https://github.com/botiverse/oar/blob/main/docs/spec/manual-compaction.md)）。 |
| **`acp` 底座** | stdio ACP JSON-RPC | 统一承载 OpenCode（v2 解析 `_meta["opencode/child-session"]`）、Grok、Kimi 与 CodeBuddy（会话走 `--acp` 规避上游 `stream-json` 双发缺陷，见 [`codebuddy.md`](https://github.com/botiverse/oar/blob/main/docs/runtimes/codebuddy.md)）。 |
| **`qwen` / `qoder`** | SDK 双向 `stream-json` | `qwen` 首帧强制发控制 `initialize`（[`qwen.md`](https://github.com/botiverse/oar/blob/main/docs/runtimes/qwen.md)）；`qoder` 子进程注入 `QODER_EXPOSE_TOKEN_USAGE=1` 解锁真实用量，提示词与 MCP 配置写入 `0700` 临时目录下的 `0600` 文件，绝不进 `argv`（[`qoder.md`](https://github.com/botiverse/oar/blob/main/docs/runtimes/qoder.md)）。 |

4. **与 `durable` 跨层桥接**：服务端内置工具发起农机委派后经 `Park` 休眠；`vibe-machine` 将实时 `RecordEnvelope` 经 `chord/link` 流式折叠入父会话进度视图，支持用户在页面随时发送 `steer` 穿透注入远端运行中的农机回合，回合结束投递结算信号唤醒父会话。

## Alternatives considered

- **在 `vibe-machine` 中通过子进程调用官方 Node 版 `oar mcp`**：虽省去重写适配器，但迫使每个沙箱容器与用户电脑额外安装维护 Node 24 与数百 MB npm 缓存，破坏单二进制零依赖体验。
- **通过自定义 MCP 工具替代 `.vibe/memory/` 目录同步**：外部编码 CLI 对原生文件工具（`grep`、`read`、`edit`）的训练熟练度远高于自定义远程工具，目录化投影能以最小上下文开销让所有农机共享记性。

## Acceptance criteria

- `pkg/oar/replaytest` 在无外网、无真实账号条件下，基于录制夹具 `100%` 跑通四大驱动的事件归一化、Resume 基线花费扣减与异常退出报告。
- 在 `vibe-machine` 运行派生三层后台子进程的脚本时强制断开 `chord/link`，验证 4 秒内宿主机归属该进程组的全部 PID 清零。
- 在运行期间扫描宿主机进程命令行参数与公开轨迹日志，确认多行系统提示词与 MCP 鉴权头零泄露。
- 帮工在工作目录修改 `.vibe/memory/` 文件并向 `.vibe/outputs/` 写入二进制图表，验证 15 秒内及回合结束时记性历史版本与素材库卡片均准确生成。

## Risks

- **各厂商 CLI 版本升级导致私有协议漂移**：须保留上游 `oar` 风格的每日/发版前探针脚本与版本基线记录，一旦新版 CLI 帧结构变动，离线夹具与探针立即精准报错。
- **多会话并发修改同一记性文件冲突**：多帮工挂载同一记性集时，后提交写回若检测到基线版本已变，不静默覆盖，而是保存为分支冲突版本并在 Inbox 提醒用户或交由后台整合任务合并。
