# Agent Note: 给 agent 用的命令行

Status: proposed

## Problem

命令行是这台电脑上的 agent（Claude Code、Codex、帮工）和主人在终端里驱动农场的入口，今天它是接口表照抄出来的：156 个接口一个一条命令（`apps/server/src/cli/api.ts` 在运行时拼出来）。

- **按接口分，不按事情分**：派一个活是 `issue status update <id> --json '{"status":"todo"}'`，回答帮工的问题是 `issue comment create`，验收是 `issue review` 再 `issue status update`；agent 要先知道接口叫什么、请求体长什么样，才能做一件事。
- **没有类型**：命令是从表里拼的，effect/cli 跟不上它的类型，靠四处 `as never`；参数一律塞进 `--json`，到运行时才照 Schema 查。
- **答复费 token**：每条命令打出接口的整份 JSON，`issue list` 一页就是几千字，agent 读的大多用不上。
- **说明只说接口**：帮助里没有例子，agent 照着帮助拼不出一条对的命令。

## Proposal

**命令是 agent 要做的事，一条一条手写、带类型；接口整体经一条 `api` 命令都够得着；输出默认是短的文字，`--format json` 是接口的形状。**

### 命令

组名照接口的模块（`issue`、`channel`、`pkm`……），组里的词是事情（`work`、`say`、`accept`），不是接口的动词。第一版：

```bash
vibevalley                                   # 和 VibeValley 自己的 agent 聊（照旧）
vibevalley doctor                            # 这台电脑上的农场好不好（照旧）
vibevalley app status|open [页]|update [check|install]|quit|restart

vibevalley issue list [--status …] [--project p] [--agent a] [--limit n]
vibevalley issue show <工单>                  # 工单、它在哪一步、在等谁、问题、验收标准
vibevalley issue new <标题> [--body 字|-] [--project p] [--agent a] [--criterion …] [--key k]
vibevalley issue edit <工单> [--title] [--body] [--project] [--agent] [--priority]
vibevalley issue work <工单> [--no-wait] [--timeout 秒]    # 派活，等它交回来，打出改动
vibevalley issue say <工单> <话>              # 带一句话给它的帮工
vibevalley issue answer <工单> <话>           # 回答它在等的问题
vibevalley issue accept <工单> | reject <工单> <为什么>
vibevalley issue done|cancel|reopen <工单>
vibevalley issue diff <工单> | log <工单>      # 改动；时间线、每一轮和花费

vibevalley channel list | read <频道> [--limit] [--before 号] | say <频道> <话> [--reply 号] | search <词…>
vibevalley project list | show <项目> | add <名字> [--repo 地址]
vibevalley agent list | show <档案>
vibevalley session list [--agent a] | show <帮工> | stop <帮工>
vibevalley runtime list | refresh [农机] | chat <农机>
vibevalley memory search <词…> [--agent a] | add <档案> <话>
vibevalley cron list | add <何时> <话> | remove <任务>
vibevalley pkm capture|today|search|radar|page get|page edit|page list
vibevalley artifact list | show <稿子> | read <稿子>

vibevalley api list [--module m]             # 每个接口：操作、说明、请求体的 JSON Schema
vibevalley api <操作> [--json 字|-|@文件]     # 直接调一个接口，照它的 Schema 查过再发
vibevalley api state [--watch] | api events
```

- **说法是人的说法**：工单是号（`12`、`#12`），频道是名字（`#general`），档案、项目、农机、页面都按名字；能不能认、认成哪一个由服务端说（已经这样的照旧，不认名字的接口补上）。
- **语音、游戏、配对、连接器登录、管家的评测这类**没有自己的命令：要屏幕、要钱或只给页面用，`api` 够得着。
- **哪个接口归哪条命令**：`apps/server/src/cli/reach.ts` 一张 `Record<操作, 命令 | "api">`，每个接口写明由哪条命令用到，或只经 `api`；加接口不写这一行编不过，和桌面版的 `desktopReach` 一样。

### 类型

- 每条命令用 effect/cli 的 `Flag`、`Argument` 写出来，参数是参数（`--project`、`<工单>`），不是 `--json`；只有 `api <操作>` 收 JSON。
- 答复先照协议的 Schema 解出来再用，`--format json` 打的也是解过的；命令行里没有 `as never`。
- 一个概念一个文件（`cli/issue.ts`、`cli/channel.ts`……），`cli/api.ts` 只剩 `api` 这一组和调接口的那几行。

### 输出

- **默认是文字**：一件东西一行，开头是能接着用的那个名字（`#12  todo  修登录页  @老周`）；`show` 是几行短的段落；列表默认 20 条，还有的话最后一行说怎么看下一页。
- **`--format json`**：协议的形状，给要结构的 agent 和脚本；全命令行同一个参数（笔记的命令已经这样）。
- **改东西的命令**：打出改了什么和它的名字；都收 `--dry-run`；新建的收 `--key`，同一把键重发不会建两份（服务端已有请求键的照用）。
- **失败**照旧：stderr 最后一行是 `{"error":{"tag","message","next"}}`，退出码照旧；`next` 里的命令是新的写法。
- 输出和错误经 effect/cli 的 `CliOutput.Presenter`，不再换掉 `Console`。

### 让 agent 找得到

- 每条命令一句说明、至少一个例子（`Command.withExamples`）；测试查每条都有。
- `vibevalley --help` 按事情分组；`vibevalley api list` 是机器读的全集。
- 写一份给 agent 的说明（`docs/cli.md`，命令行的 `vibevalley guide` 打出它）：常见的几件事各一段，从「看有什么工单」到「派活、回答、验收」，照着就能做完。

## Alternatives considered

- **照旧一个接口一条命令**（上一版，[渠道和命令行](.agents/notes/proposed/feature/2026-11-04-desktop-channels-and-cli.md)）：加接口自动有命令，但命令是接口的形状、没有类型、答复太长，agent 得先懂接口。取代它的那一部分；每个接口的说明留着，`api list` 和能力表用。
- **只给 agent MCP 工具**：帮工和管家已经有，但这台电脑上的 Claude Code、Codex 在 shell 里最顺，命令行能接管道、能写进脚本，也不用配。
- **命令和帮工的 MCP 工具共用一份定义**：两边都是给 agent 的，长远应该一份；但工具的描述为模型调过、有评测管着，这次先不动，等命令行稳了再看。
- **默认 JSON**：脚本好读，但 agent 读 JSON 费 token，人读不下去；要结构时加 `--format json`。

## Acceptance criteria

- 命令行里没有 `as never`，`cli/api.ts` 里不再按接口拼命令；`reach.ts` 每个接口一行。
- 每条命令有说明和例子；`vibevalley api list` 列出每个接口；`api <操作>` 发出去以前照 Schema 查。
- 一条流程测试只用命令行：建工单、派活、帮工问问题、回答、交回、验收、完成，每一步读默认的文字答复往下走（用测试里的帮工）。
- `issue list` 默认的文字比 `--format json` 短得多（测试里对比一次）。
- 文档：[开发](docs/development.md) 的命令行一段改成新的样子，`docs/cli.md` 写好，`AGENTS.md` 的命令一行跟着改；[渠道和命令行](.agents/notes/proposed/feature/2026-11-04-desktop-channels-and-cli.md) 里「命令的样子」指到这里。

## Risks

- 新接口不会自动有命令：`reach.ts` 逼着写明它归哪条命令或只经 `api`，不会漏掉，但要有人决定。
- 文字输出变了，读它的脚本会坏：脚本该用 `--format json`；文字的样子在命令行的黄金数据里，改了看得见。
- 按名字认东西会认错（两个同名的档案）：认不准时拒绝，`next` 列出候选和它们的 id。
