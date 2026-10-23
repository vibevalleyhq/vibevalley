# Agent Note: 命令行是 agent 验证的入口：照 effect/cli 重写，能组合、能试跑、出 JSON、报错给下一步

Status: proposed

## Problem

agent 改完代码，最贵的一步是证明改对了。现在证明的路有三条，各有毛病：

- **Playwright 和截图**（`verify-app`）：要构建页面、起浏览器，慢；断言绑在界面的字和布局上，界面一改字就红，证明的却是皮，不是服务端的行为。
- **服务端的测试**（`src/flows`、黄金数据）：快、确定，但只能测写好的情形；agent 想在真程序上「派一张工单、看它走到哪」，得自己拼 HTTP。
- **命令行**（`apps/server/src/cli.ts`，`verify-server` 的沙箱经 `VIBEVALLEY_VERIFY_CLI` 调它）：方向是对的，接口表里的 98 个接口都是一条命令（从 `packages/protocol/src/api.ts` 的 `endpoints` 生成，不会漂），但只做了一半。

按「先把应用做成命令行，命令能组合，破坏性操作带 `--dry-run`，输出 JSON，报错时告诉 agent 下一步怎么做」逐条看现在的命令行：

| 要求 | 现在 | 差在哪 |
|---|---|---|
| 应用就是命令行 | 每个接口一条命令；另有 `issue run`、`state`、`events`、`runtime chat` 和自己的 agent | 参数解析是手写的 `wordsOf`（约 30 行），没有每条命令的帮助、参数类型、补全；请求体只查「是不是 JSON」，不照接口的 Schema 解码，错的请求体要到服务端才被拒 |
| 命令能组合 | 请求体能从标准输入读（`--json -`），答复是 JSON，能接 `jq` | `state --watch` 每一帧打成多行的 JSON，接不了按行读的工具；没有约定 stdout 只放数据、stderr 放进度；退出码只有 0 和 1，脚本分不出「被拒了」「没找到」「连不上」 |
| 破坏性操作带 `--dry-run` | 没有 | 删工单、删档案、挪到已完成（会合并或开 PR）、取消、叫停、收工、放弃计划，都只能真做；agent 想知道「这一步会发生什么」只能读代码，或者先做了再说 |
| 输出 JSON | 成功时打 JSON | 失败时打一行中文到 stderr（`409 这张工单关上了`），不是 JSON；帮助是给人看的纯文字 |
| 报错告诉下一步 | 服务端的拒绝（`ApiError` 的 `Refused`）多半是一句带建议的中文，如「先叫停，等它停下再换人」 | 建议是给人读的散文，agent 要自己把它翻成命令；命令行自己的错（参数不对、连不上）只说错了，不说怎么改 |

所以要做的不是从零造一个命令行，是把现有的这一层做完整，并让它成为 agent 验证改动的首选入口。

## Proposal

一句话：**命令行是接口表的另一张皮，和页面平级；它用 `effect/cli` 搭，从 `endpoints` 生成命令，stdout 只放 JSON，破坏性操作能试跑，每个错误都是带下一步的 JSON。** 规则（能不能做、试跑会发生什么、下一步是什么）在服务端，命令行和页面一样只转发、只展示（[处理函数要薄](AGENTS.md)）。

### 一、照 effect/cli 重写，命令仍从接口表生成

- 用 Effect 4 自带的 `effect/cli`：`Command.make` / `withSubcommands` / `withHandler` 搭命令树，`Argument` 对应路径参数，`Flag` 对应查询参数，`Command.run` 接进 `@effect/platform-node`。服务端本来就是 Effect，命令行跟着用同一套运行时、`Layer` 和日志。
- 命令树照旧从 `endpoints` 生成：`<group> <op>`（`issue create`、`issue status <id>`），一个接口一条，不手写；接口表加一个接口，命令行自动多一条，帮助、补全（`Completions`）都有。手写的只有组合命令：`issue run`（派出去、等它交回来、打出改动）、`state`、`events`、和农机直接聊、自己的 agent。
- 请求体：`--json <文本>`、`--json -`（标准输入）或 `--json @文件`，在命令行这一侧先照接口的 Schema 解码（`Flag.withSchema` 或 `FileSchema`），对不上就当场报 `InvalidValue`，带出是哪个字段、要什么。
- 全局设置用 `GlobalFlag.Setting`：`--server`（或 `VIBEVALLEY_SERVER`）、`--dry-run`、`--output json|text`（默认：stdout 是终端时给人看的排版，不是终端时是 JSON）。

### 二、能组合

- **stdout 只放结果，stderr 放进度和提示。** 一次请求一个 JSON 文档；流（`state --watch`、`events`）一行一个 JSON（NDJSON）。
- **退出码有意义**，脚本不用解析字就能分支：

| 退出码 | 意思 | 对应 |
|---|---|---|
| 0 | 成功（含试跑） | |
| 2 | 命令用错了 | `effect/cli` 的 `CliError`（不认的参数、缺参数、值不对、没有这个子命令） |
| 3 | 被拒绝 | `ApiError` 的 `Refused` |
| 4 | 没找到 | `Missing` |
| 5 | 连不上服务端 | 网络错误、`503` |
| 1 | 别的 | 服务端出错 |

- **认人能读的编号**：工单写 `41`、`#41`、id 都行（服务端已经认，`Issues.idOf`）；答复里带编号，前一条命令的输出能直接喂给下一条。

### 三、破坏性操作能试跑

- 接口表里会删东西、合进主分支、开 PR、让帮工走、把工单关上的接口带一个 `dryRun`，指向另一个接口：同样的路径参数、查询参数和请求体，答复一个 `Preview`（`{ does: [...] }`）。没用查询参数：试跑的答复和真做的形状不一样，分成两个接口，各自的 Schema 都准。命令行的 `--dry-run` 就是调它。
- **试跑归拥有规则的服务**，不归命令行：服务照真做的同一条路走到要动手之前，把会做的事说成一个 `Preview` 返回（会挪到哪个状态、交付是什么、会不会合并、会冲突的文件、会删掉哪些分支和 worktree），不写库、不施加事实、不碰 git。例：工单挪到已完成，试跑给出 `statusMove` 的挪法、`changes` 的预检和会走本地合还是 PR。页面将来也能用它在按钮下面说「会发生什么」。
- 被拒的照样被拒：试跑和真做在同一处判断，所以试跑说能做，真做就不会因为同一个原因被拒。

### 四、错误是 JSON，带下一步

- 失败时 stderr 是一个 JSON：`{ "error": { "tag": "Refused", "message": "…", "next": [ … ] } }`，退出码照上表。
- `ApiError` 加一个可选的 `next`：拒绝的一方写下接着能做什么，每一条是 `{ say, run? }`：`say` 是一句话，`run` 是能直接执行的命令（`["issue", "act", "41", "--json", "{\"act\":\"stop\"}"]`）。「先叫停再换人」「先验收通过才能完成」「这是计划里的工单，在计划里改」都写成这样。命令行把 `run` 拼成可复制的一行；管家的工具把 `say` 当回话；页面可以把 `run` 做成按钮。
- 命令行自己的错也给下一步：用错了附上 `help <命令>` 和正确的写法；连不上附上起服务端的命令和 `--server`。

### 五、验证的方法

这是写这篇的原因：命令行做完整以后，验证一个改动就是写一段命令，而不是点页面。

- **`verify-server` 的沙箱以命令行为主**：隔离的家目录、空闲端口已经有了（`scripts/verify-server.ts`）；验证 skill 写成「起沙箱 → 一串命令 → 断言 JSON」，证据是命令和它们的输出。
- **契约测试**（静态检查，比文字便宜）：每个接口都有一条命令；每个带 `dryRun` 的接口指向的试跑和它同参数、同请求体，每个删除要么有试跑、要么在待做的单子上；试跑前后数据库和核心状态不变；每个 `DELETE` 都标了 `destructive`。
- **命令行的黄金数据**：`--help` 的输出、几条典型错误的 JSON（含 `next`）录下来，改了要看 diff。

### 做到哪了

1. 第一、二节和第四节里命令行自己的那一半：已经做了。`effect/cli` 搭的命令行（`apps/server/src/cli.ts`、`src/cli/`），每个接口一条命令、有帮助，`--json` 收文本、`-`、`@文件` 并照 Schema 先查；stdout 只放 JSON（终端里排开，不是终端时一行，流一行一帧），失败是 stderr 最后一行带 `next` 的 JSON，退出码照上表。没加 `--output`：是不是终端已经够分。
2. 服务端的拒绝带 `next`（第四节的另一半）：已经做了工单的。`ApiError` 的 `Refused`、`Missing` 有可选的 `next`；工单的拒绝给出它现在能做的动作和挪法（`nextSteps`），找不到工单给 `issue list`。后来推到了别的服务：`missing(what, next)` 的 `next` 是必填的，每个找不到的都要说去哪儿找，去处写在 `errors.ts` 的 `lookIn`（一种东西一条列出它们的命令，`cli.test.ts` 跑每一条的帮助）；说「没有 X」却用 `Refused` 的（计划、频道、对话、帮工）改成 `Missing`；请求里点到不存在的档案或频道、没有能派的帮工，仍是拒绝，带上去哪儿找；计划和步骤的动作被拒时给出它现在能做的（`graphActions`、`taskActions`，`task.ts` 的 `graphNext`、`stepNext`）。其余的拒绝是规则（没说要做什么、分支没能建），下一步要主人想，不硬给命令。
3. 试跑（第三节）：已经做了工单的。接口表的一项带 `dryRun`，指向同参数、同请求体、答复 `Preview` 的另一个接口（不用查询参数 `dryRun`：答复的形状不一样，分开两个接口各自的 Schema 都准）；`issue.status`、`issue.act`、`issue.delete` 有了，`setStatus` 拆成算出挪法（`settledMove`）和动手两步。命令行的 `--dry-run` 调 `dryRun` 指的那个；只读的照跑；别的改东西的命令带它会被拒。每个删除都有了试跑（定时、计划的一步、档案、技能、记性、连接到本机的设备和配对码），各服务把「能不能删」写成一处判断（如 `deletableAgent`、`forgettable`、`known`），删和试跑都过它，找不到的两边都是 `Missing`、带上去哪儿找；`cli.test.ts` 查每个 `DELETE` 都带 `dryRun`。
4. 验证 skill 改成只用命令行（第五节）：已经做了。`scripts/verify-server.ts --scripted-helper` 让沙箱里的 pi 是服务端测试里照字眼干活的帮工（`VIBEVALLEY_TEST_RUNTIMES`），`verify-server` 的 skill 写着一遍只用命令行的：建工单、`issue run` 等它交回来、试跑完成、真完成、`git log` 看合进去的提交；`scripts/verify-server.test.ts` 跑着同样的一遍。

5. 命令行自己也尽量用 Effect：已经做了。请求走 `HttpClient`（`FetchHttpClient.layer`），流用 `Sse.decode`，读写走 `Stdio`、`@文件` 走 `FileSystem`，`VIBEVALLEY_SERVER` 是 `--server` 的 `Flag.withFallbackConfig`，JSON 和服务端的错误照 Schema 解（protocol 的 `ApiError` 有了 Schema，服务端认错误也用它）；`issue run` 跟着 `/api/v1/state` 的帧走，不再轮询；进程由 `NodeRuntime.runMain` 起，Ctrl+C 中断，退出码 130。和农机、自己的 agent 聊（`cli/chat.ts`）仍是 Promise：底下的 Brain 和 oar 会话就是 Promise，它自己接 Ctrl+C，所以在不可中断的一段里跑。

还没做的：命令行的黄金数据（`--help`、几条典型错误的 JSON）。

## Alternatives considered

**接着用手写的解析。** 现在的 `wordsOf` 够用，但帮助、补全、参数类型、请求体的 Schema 校验、错误的格式都得一样样手写，而 `effect/cli` 已经有，和服务端是同一个运行时。用它也是照项目「能用代码挡住的不写成规矩」：参数用错由解析器挡住，不靠 agent 读帮助。

**按资源手写命令（`issue list`、`issue show` 各写一个）。** 读起来像常见的命令行，但和接口表会漂：加一个接口要记得加命令。生成的命令只在组合命令上手写。

**只给 agent 开 MCP，不做命令行。** 帮工已经经 `/mcp` 用工具，但 MCP 的工具是给在干活的帮工的一小组；验证要的是整个应用，还要能在 CI、沙箱和终端里跑，主人也要用。两者都从同一个服务的方法来，不互相替代。

**试跑放在命令行这一侧（先 GET 再推算）。** 简单，但是在命令行里重写服务端的规则，迟早和真做不一致；违反「规则在拥有它的服务里」。

## Acceptance criteria

- `vibevalley` 用 `effect/cli` 搭：`vibevalley --help`、`vibevalley issue --help`、`vibevalley issue status --help` 都有每个参数的说明；`--json` 不合接口的 Schema 时不发请求，退出码 2，错误 JSON 指出字段。
- 任何命令的 stdout 能直接接 `jq`；`state --watch` 一行一帧；失败时 stdout 为空。
- `vibevalley issue status 41 --json '{"status":"done"}' --dry-run` 返回会怎么交付、会不会冲突，数据库、核心状态、git 都没变；同一条去掉 `--dry-run` 在同样的状态下照它说的做。
- 被拒时 stderr 是带 `next` 的 JSON，退出码 3；`next` 里的 `run` 原样执行能走下一步（有测试照几种常见的拒绝跑一遍）。
- 契约测试：每个接口一条命令、每个带 `dryRun` 的接口的试跑和它同形状、试跑不改状态，都在 `server:check` 里。
- 至少一个验证 skill 改成只用命令行：起沙箱、派一张工单、等它交回来、试跑完成、真完成，证据是命令和 JSON。

## Risks

- **`effect/cli` 在 Effect 4.0 里标着 unstable**，接口可能变；只在 `cli.ts` 一处用它，升级时改一处。
- **改了命令行的写法会打断现有的用法**：文档（`docs/development.md`「只用命令行派一个活」）、`verify-server` 和 skill 里的命令都要一起改；照「不留兼容」，不留旧写法。
- **试跑和真做分叉**：只要试跑是另写的一条路就会分叉。要求服务把「判断和计划」与「动手」拆成两步，真做 = 计划 + 动手，试跑 = 只计划；做不到这样拆的接口先不标 `destructive` 的试跑，宁可没有也不要说错。
- **`next` 写成又一份规则**：下一步的命令必须由拒绝的那一处给出，不在命令行里按错误的字去猜；否则字一改提示就错。
