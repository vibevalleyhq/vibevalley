# Agent Note: 让容易的写法就是对的写法

Status: implemented

## Problem

代码大多由 agent 写。agent 照着已有的代码抄，走最短的路；agent 落代码的速度，人每个 PR 都细看跟不上。只靠 `AGENTS.md` 里的规矩和人审，同一类问题会一再出现：规矩要 agent 记得、读对，人审会漏。

## Decision

挡住一类问题，按这个顺序选手段，能用前面的就不用后面的（写在 [AGENTS.md](../../../../AGENTS.md#怎么让-agent-做对)）：

1. **代码**：结构、类型、不变量、边界。把一类问题整个消掉，比如核心状态只有一份、形状只在 Go、生成的代码不手改。
2. **静态检查**：lint、测试、CI、形式化验证。比如 `bun run go:deadcode`、黄金数据、`docs:verify` 查文档里的路径、生成的成员表查穷尽的 `switch`。
3. **文字**：注释、规矩、`AGENTS.md`、skill。只写没法强制、要判断的。
4. **人看**：花在设计环境上，不花在逐行看每个 PR 上。

加一条规矩前，先问能不能写成代码或检查。

### 验证 skill

第 3 层里最有用的一种是**验证 skill**：改了一块以后，怎么在真的程序上证明它对了。测试用的是假的帮工、假的服务端，证明不了「服务端起得来、接口返回对、页面画得对」。

- 项目的 skill 放在 `.agents/skills/`，`.claude/skills` 是指向它的链接：和 `.agents/notes` 一样不绑一家 agent，Claude Code 和 Codex 读同一份。
- 写验证 skill 的办法本身也是一个 skill：`create-verification-skill`。它先问这件事能不能变成代码或检查；要写，就先在真的改动上做一遍、记下命令和看到的输出，再写成固定的几节（什么时候用、准备、步骤、证据、出错时、收拾），最后让一个没有上下文的子 agent 照着做一遍。
- 「证据」一节是关键：agent 说「验证过了」时，要附上那几样输出或截图，主人看证据，不看过程。
- 先有两个：`verify-server`（临时家目录里的服务端、接口、`/api/state`）和 `verify-app`（对着它用 `app/tool/screens/live_screens_test.dart` 画截图）。都不派真的帮工：真的帮工会花钱，要主人点头。
- 格式交给检查：`scripts/skills.ts`（进 `bun run docs:verify`）查 frontmatter 的名字和目录一致、`verify-*` 有那几节、README 的表和目录对得上、`.claude/skills` 的链接在；`scripts/doc-links.ts` 也查 skill 里写的路径。

## Alternatives considered

**规矩写全，靠人审兜底。** 规矩越长，agent 越容易漏读、读偏；人审跟不上 agent 的速度。没选。

**验证步骤写进 docs/development.md。** 文档是给人读的现状，agent 不会在改完时自己想起去读；skill 有 description，agent 按改动的路径会想起它。没选。

**skill 放在 .claude/skills。** 只有 Claude Code 读；放 `.agents/skills` 再链过去，两家都能用。

## Consequences

- `AGENTS.md` 的规矩列表应只增加写不成代码或检查的条目；已经有检查的规矩，宜只留一句和检查的命令。
- 发现一类反复出现的问题，先补代码或检查，再考虑写规矩。

## Verification

- 新增的规矩能指出为什么写不成代码或检查。
- `bun run docs:verify` 通过；删掉一个 `verify-*` 的「证据」一节，`bun scripts/skills.ts` 报错。
- 照 `verify-server`、`verify-app` 做过一遍：临时家目录里的服务端答 `/api/health`，接口新建的工单出现在 `/api/state` 和 `app/build/live-tickets.png` 里。
