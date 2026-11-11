# Agent Note: agent 带什么：工具集（toolsets）和技能（skill 模块），用户用 `/` 叫它们

Status: proposed

## Problem

内置只读技能（`apps/server/src/modules/agent/skills/`）、助手内置技能（`apps/server/src/modules/orchestrator/skills/`）及输入框固定斜杠命令（`/stop`、`/issue`、`/remember`、`/imagegen`）已上线（见 [档案和农机](docs/subsystems/agent.md)），但还剩三处能力缺口：
- **用户技能仍存单字符串并整段拼入提示词**：`config.json` 的用户自定义技能每勾一个就每轮全量拼进人设（`session/briefing.ts`），不能携带附属参考文件，且未与仓库 `.agents/skills/`、本机 `~/.agents/skills/` 统一按需加载。
- **工具按角色硬编码二分**：`apps/server/src/modules/tool/` 固定按 `orchestrator` 与 `session` 两张表切分，无法给领班帮工档案开放 `issue` 拆单工具，也无法裁剪某个助手档案的工具。
- **输入框 `/` 不能直接点名调用技能**：用户无法在频道输入 `/<技能名> <说明>` 让目标 agent 在当轮按指定技能执行。

## Proposal

1. **统一技能目录与按需读取（`skill` 模块）**：
   - 将农场用户技能从 `config.json` 字符串迁为 `$VIBEVALLEY_HOME/skills/<name>/SKILL.md` 文件夹（可在设置页新建、编辑、删除、导入），与仓库 `.agents/skills/`、内置只读技能、本机全局技能按优先级合并。
   - 进程内 `Brain` 仅将已勾选技能的名称与简介放入系统提示，经 `load_skill` 按需读正文；外部农机在任务说明末尾附上 `SKILL.md` 绝对路径供其按需读取。
2. **档案级工具集（`Agent.toolsets`）**：
   - `Agent` 档案增加 `toolsets: Toolset[]`（`chat`、`memory`、`look`、`issue`、`cron`、`channel`、`coding`），`tool/` 用 `Record<工具名, Toolset>` 编译期强制全覆盖。
   - `toolsets` 仅用户可经 `agent.update` 修改；助手工具表与帮工 `/mcp` 在列出与执行时均按档案 `toolsets` 二次校验，接口权限 `can` 收窄为 `user`、`remote`、`agent`。
3. **输入框 `/<技能>` 显式调用**：
   - `/` 补全菜单列出目标 agent 可用技能；复用 `channel.message.send` 记录 `command: { name, args }` 渲染标签，投递时由服务端在当轮输入附上该技能 `SKILL.md` 正文，不改动系统提示前缀。

## Alternatives considered

- **把技能复制进帮工 worktree 的 `.claude/skills/`**：会污染工作树 `git status` 且收工需清理；传绝对路径按需读取更干净。
- **在前端把 `/<技能>` 展开成全文发进频道**：会让聊天记录塞满几百行指令；在服务端投递步展开只留原话与标签。
- **为 `/` 技能另起 `skill.invoke` 接口**：复用 `channel.message.send` 直接继承 `sendKey` 幂等、工单串归属与 Mailbox 路由。

## Acceptance criteria

- `$VIBEVALLEY_HOME/skills/<name>/SKILL.md` 支持增删改与导入；勾给进程内 agent 时系统提示只含简介并可 `load_skill`，勾给外部农机时任务说明含路径。
- 用户为帮工档案勾选 `issue` 工具集后可建单与拆单，取消勾选后下一次调用立即被拒。
- 输入框补全并发送 `/<技能> ...` 后，频道展示技能标签，当轮 agent 输入包含该技能正文。

## Risks

- 技能目录简介每条硬限 160 字，修改后需重放助手评测集验证前缀缓存与工具选择；领班帮工赋 `issue` 工具集后需限制最大派工深度防占满并发槽位。
