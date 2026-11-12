# Agent Note: 拆出 apps/machine：一个服务端经出站长连接管多台机器

Status: proposed

## Problem

用户要在多台电脑（家里的、公司的、跑长任务的服务器）上共用同一套工单看板、频道与助手，让帮工按农机和仓库落到对应的机器上干活。

单服务端底座已就绪：数据库已迁至 Postgres / PGlite（[地基](docs/subsystems/foundation.md#契约规则和数据库)），[用户和设备](docs/subsystems/user.md)登录与钥匙已上线，`session_machine` 表与 `session/link.ts` 进程内克隆链路已接入（[帮工](docs/subsystems/session.md#模型和不变量)）。目前仓库、农机探测和执行器仍在 `apps/server` 同一进程内，尚未拆出独立的 `apps/machine` 与跨机长连接。

## Proposal

将本机相关能力（探测农机、管理 git 仓库与 worktree、经 oar 起帮工、回传事件与轨迹）拆入独立的 **`apps/machine`**（命令 `vibevalley machine …`），`apps/server` 只保留核心状态、业务模块与 Postgres。按以下剩余步骤逐提交推进：

1. **完成机器链路抽象（3b–3d）**：
   - **3b 仓库过链路**：工单与帮工（改动、冲突、合并、工作目录释放与清理、GitHub PR 观察）、游戏（提交统计）与工具对 `Repo` 的调用改为经链路定位拥有该仓库的机器。
   - **3c 探测过链路**：每台机器上报已装农机、额度与可用性并合入 `session/machine.ts` 状态；派活按档案所需农机与工单仓库挑选在线机器。
   - **3d 搬入 `apps/machine`**：链路消息在 `packages/protocol/src/machine` 定义 Zod schema（oar 事件按记录格式过线，仍由服务端 `session/reaction.ts` 折成事实）；执行器、仓库与探测迁入 `apps/machine`。单进程模式与整农场测试通过内存链路共跑两头。
2. **命令行注册与三类钥匙隔离（第 4 步）**：
   - 机器主动外连服务端（WebSocket 长连接，穿透 NAT 和睡眠唤醒），服务端从不反向连机器。
   - `vibevalley machine join <服务端地址>` 复用 `user.approval.*` 确认码流程，用户在页面批准后签发机器钥匙（存于机器家目录，可随时吊销断连）。
   - 严格隔离设备钥匙、机器钥匙与帮工会话令牌的接口权限：机器链路经对外门接入，帮工 CLI 与 `/mcp` 只连本机 `machine` 进程并由其持会话令牌转发，帮工拿不到机器钥匙。
3. **独立启停与真 Postgres CI（第 5 步）**：
   - 提供独立的 `vibevalley server` 与 `vibevalley machine` 命令；桌面版默认同起服务端（PGlite）与本机 machine，配对远端服务端后仅作为一台 machine 运行。
   - CI 增加在真实 Postgres 实例上运行服务端测试（每座测试农场独立空库）。

## Alternatives considered

- **服务端通过 SSH 或开放端口反向连机器**：内网与笔记本合盖场景不可达，且增加每台机器的暴露面；出站长连接只需服务端可达。
- **每台机器各跑一座农场再互相同步**：违背「核心状态只有一份」，跨机冲突无法收敛。
- **只支持外部 Postgres、去掉 PGlite**：会破坏单机桌面版开箱即用；两者共用同一套 Postgres SQL 与 `apps/server/scripts/pg-generate.ts` 生成代码。

## Acceptance criteria

- 两台机器登记到同一服务端后，工单自动派往具备对应农机与仓库的机器；断线显示离线，重连后恢复；吊销钥匙立即断开连接。
- 设备钥匙、机器钥匙与会话令牌权限由静态检查守住；无钥匙请求一律拒绝，帮工拿不到机器钥匙，`/mcp` 只经本机 `machine` 进入。
- 桌面版默认配置下保持单机开箱即用；`server:check` 在 PGlite 与 CI 真实 Postgres 上均通过；同步更新 `AGENTS.md`、[架构](docs/architecture.md)、[地基](docs/subsystems/foundation.md)、[帮工](docs/subsystems/session.md)与[连接到本机](docs/subsystems/lan.md)后删除本 Note。

## Risks

- **鉴权边界扩大**：服务端对外监听后，任一接口漏判钥匙类型即可能导致跨机命令执行，三类钥匙的能力表必须由检查强制覆盖。
- **跨机轨迹与附件体积**：机器回传的轨迹与附件写入服务端存储时须设大小上限与背压控制。
