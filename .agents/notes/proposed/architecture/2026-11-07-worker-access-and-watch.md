# Agent Note: 帮工接入身份与工单观察

Status: proposed

## Problem

本机代理会截走编码 agent 到回环 MCP 的请求。会话创建成功不能证明工具已加载；现有 `issue show --watch` 只等待工单状态，不能观察工具失败或执行轨迹。帮工需要不依赖 MCP 加载及登录 shell PATH 的交活入口，但不能借用主人 HTTP 身份。

## Proposal

由子工单 #7 → #8 → #9 → #10 依次实施以下四步，不再拆单。子工单不授权自行开 PR，只有父工单 #2 最终提交整批 PR。每块先运行会失败的最低层 `regression: ` 测试，再改实现。生成器和构建串行运行。

### 恢复与检查约束

原 #3–#6 的 `constraints.check` 被填成中文验收说明，产品自动合回执行时报 `sh: 先最窄: command not found`。这是拆单参数错误，旧单取消不代表检查或验收通过。主人通过公开 API 取消旧单，未改库或跳检查；据工单串 #general:2 的消息 4，产品保留 #3 的 `a8081ab2`、`f7ae6f4b`，由 #7 复用并重新验证。父分支当前尚未包含这两个提交，集成时以实际提交和检查结果为准。

新子单的 `check` 是可执行的 server/web/effect/health/docs/deadcode 串行命令；验收说明放在 brief 与结构化 checks，不能放入 shell 命令字段。集成记录必须保留此次命令执行失败及后续重验结果。

主人追加授权的 artifact 测试夹具修复属于本批：使用合法、按序且不同的 order key（优先 `keyBetween`），保留原 applied/Markdown 断言和生产校验，记录基线红与修后绿。#7 先核查保留提交中已有修复，后续不重复修改。

### 实施步骤

1. **运行时接入观测**：在 runtime/executor 启动边界合并派生进程环境的 `NO_PROXY`、`no_proxy` 与 `127.0.0.1,localhost,::1`；保留已有项、去重，不改全局环境或清空代理。先核查 oar 中性事件能力；确需原始记录时，在 runtime 边界用 Schema 解码，向上交中性结果。通过 Session 轨迹及 Core 事实输出连接失败；未观测到就是 unknown。订阅回放已有记录，释放时取消订阅。
2. **会话 CLI**：复用 `session/records.ts` 的会话令牌生命周期和 `/mcp` 工具执行路径，提供最小的交活、PR 提交、只读上下文和诊断命令。客户端仅引用共享契约，不引入服务端。启动说明提供绝对可执行路径，凭证只经子进程环境或受保护的运行时文件传递，禁止进入 argv、提示、日志和提交。服务端从凭证解析身份，拒绝缺失、无效、撤销凭证及越权 PR；参数不能选别的会话。必需 CLI 接入不可用时阻塞启动；可选 MCP 状态与它分开。
3. **工单 watch**：依赖前两步的会话生命周期与观测契约。读取服务端折好的工单状态与 SessionEvent，不在 CLI 重算业务判断。先订阅再补历史，或提供等价原子游标协议；按会话、seq、revision 去重，断线补齐，跟随新一轮与新会话。读取、缓冲和显示有界；若保留历史已截断，明确报告缺口。默认交回或结束退出，`--follow` 持续观察，Ctrl-C 只取消观察。提供独立 JSONL 选项与契约，不改变全局 `--format json`，保留 `issue show --watch` 等待语义。
4. **集成验收**：汇合前三步，隔离家目录和端口运行真实服务，验证连接失败、watch 与合法/非法会话交活。沉淀到 session、issue 子系统及 CLI README，删除此 Note。补一份可复用验收分册（若已有分册不足）。统一检查、PR 元数据与回归说明，授权经 VibeValley 提交，不手动 push、不合并。

### 接缝与共享约定

`session/launch.ts` 已签发 MCP 会话令牌；`mcp/mcp.ts` 经 `who(token)` 解析调用方；`executor/executor.ts` 已通过 `rawEvents` 观察记录。oar `events()` 明确允许某条原始记录无中性事件，不能用空 events 推导 ready。实际中性能力仍需实现者完整核查。

不另存第二份业务状态，不新增兼容迁移。新增共享形状归 protocol 对应概念，Schema 与接口同改；需要生成 API client、能力表或词典时使用生成器。协议改动由后续步骤依赖前序提交，避免平行修改同一契约。

## Alternatives considered

**主人 HTTP CLI 作为兜底**：拒绝。它没有帮工会话的授权边界，未知 token 不能回退主人。

**仅探测 /health**：拒绝。它只证明服务端可达，不能证明编码 agent 加载了 MCP 工具。

**客户端定时拉全量轨迹**：拒绝。会产生重复输出，也不能解决历史与实时之间的丢失窗口。

## Acceptance criteria

- 子进程代理例外保留已有值，源环境不变；回归覆盖大小写变量及重复项。
- 工具失败进入轨迹与状态，unknown 不被宣称 ready；必需 CLI 接入失败有明确阻塞。
- watch 覆盖初始已交回/结束、重复与 revision、新轮次/会话、重连补齐、取消不停止会话；补 CLI 真服务接线测试。
- CLI 覆盖真实身份绑定、无效/撤销凭证、越权 PR，以及合法交活和提交。
- 保存最窄检查、vp check、server:check、web:check、docs:verify、deadcode、health/effect 的实际结果。隔离服务验证按 vv-acceptance 执行；已有 artifact 基线失败与分支门禁不得放宽。

## Risks

原始厂商事件可能没有中性投影或无法证明 ready，须报告能力边界，不能猜测。轨迹保留上限可能造成重连历史缺口，协议必须显式表达。CLI 可执行路径须覆盖源码与桌面打包入口；无法验证的宿主写入未验证项。当前分配分支 `vibevalley/issue-2` 与分支门禁可能冲突，保持分支不动，经平台报告。
