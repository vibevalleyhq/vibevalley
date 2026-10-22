# Skills

这里放这个项目自己的 skill：要 agent 判断、写不成代码或检查的做法（[AGENTS.md](AGENTS.md#怎么让-agent-做对) 的第 3 层）。`.claude/skills` 是指向这里的链接，Claude Code 和 Codex 读同一份。`bun run docs:verify` 查每个 skill 的格式，也查下面的表和目录对得上（[scripts/skills.ts](scripts/skills.ts)）。

现在的 skill 多是**验证 skill**（`verify-*`）：改了一块以后，怎么在真的程序上证明它对了。新写一个照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md)。

| skill | 什么时候用 | 证明什么 |
|---|---|---|
| [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) | 一类改动没有现成的验证办法 | 写出下一个 agent 照着就能做的验证步骤 |
| [verify-server](.agents/skills/verify-server/SKILL.md) | 改了 `apps/server` 的接口、服务、表结构、开机 | 隔开的服务端起得来，接口和 `/api/v1/state` 里有这次的改动 |
| [verify-app](.agents/skills/verify-app/SKILL.md) | 改了 `apps/web` 的页面、组件、贴图 | 对着真的服务端，页面画出来是对的（截图） |
| [verify-mobile](.agents/skills/verify-mobile/SKILL.md) | 改了 `apps/mobile`、宿主的桥、「连接到本机」的配对 | 安卓模拟器上的真应用配对、经「连接到本机」打开页面、桥让手机弹通知、重开直接回农场 |
| [verify-assistant-evals](.agents/skills/verify-assistant-evals/SKILL.md) | 改了管家的提示、工具描述或 `agent/brain` 的提示拼法；加了管家的样例 | 用真模型重放每个样例 5 次，以前修好的错没回来，新的修好了（花钱，先问主人） |
