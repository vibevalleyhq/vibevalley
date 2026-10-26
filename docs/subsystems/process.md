# 工程流程

代码周围的东西：文档和 Note 放在哪、怎么查，项目自己的 skill，写作规范，素材怎么生成，名字怎么写。它不是运行时的一块，农场里也不画；它要回答的是：代码大多由 agent 写，怎么让 agent 默认就写对、写的东西有家、改坏了有检查拦下。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 「让容易的写法就是对的写法」的四层手段，和新规矩先问能不能写成代码或检查 | 具体的规矩条文（根目录 [AGENTS.md](AGENTS.md#规矩)） |
| 文档的分层、子系统和 Note 的分工 | 每层放什么的规矩本身（[docs/AGENTS.md](docs/AGENTS.md)）；Note 的位置、类别和格式（[.agents/notes/README.md](.agents/notes/README.md)） |
| `docs:verify` 的四个检查：Note、skill、链接和路径、旧名字 | 服务端和页面的检查：黄金数据、`schema.test.ts`、`server:check`、`web:check`（[地基](docs/subsystems/foundation.md)、[客户端](docs/subsystems/app.md)） |
| 项目自己的 skill 和验证 skill 的格式 | 每个验证 skill 的步骤（[.agents/skills](.agents/skills/README.md)） |
| 写作规范为什么是现在这样 | 写作规范本身（[style/writing.md](docs/style/writing.md)）、代码怎么写（[style/code.md](docs/style/code.md)） |
| 素材的生图和切图流水线 | 客户端怎么读图、密度、像素村（[农场的皮](docs/subsystems/farm.md)）；操作步骤（[development.md](docs/development.md#素材音效和官网)） |
| 名字：VibeValley、码农场物语、小写的 `vibevalley` | 渠道各自的 bundle id 和目录（[客户端](docs/subsystems/app.md)） |

## 在哪

- **`scripts/`**（Bun 跑，不带构建）：`agent-notes.ts`（Note 的目录和格式，`--write` 重写 `CATALOG.md`）、`skills.ts`（skill 的格式）、`doc-links.ts`（总地图覆盖、链接和反引号里的源文件路径）、`stale-names.ts`（代码里不许回来的旧名字）、`capabilities.ts`（能力表是否最新）。五个连起来是 `bun run docs:verify`；`notes:verify`、`notes:catalog`、`names:verify` 是单跑其中一个。同一个目录里还有 `deadcode.ts`、`app-imports.ts`、`verify-server.ts`（验证 skill 起隔离服务端用），归各自的子系统。
- **`.agents/`**：`notes/` 是 Agent Notes，`CATALOG.md` 是生成的清单；`skills/` 是项目自己的 skill，`.claude/skills` 是指向它的符号链接。
- **`docs/`**：分层见 [docs/AGENTS.md](docs/AGENTS.md)；`docs/style/` 是 `writing.md` 和 `code.md`。
- **`design/`**：`pixel/gen.sh`（codex 生图）、`pixel/process.py`（切图，写 `apps/web/public/pixel/` 和 `sprites.json`）、`pixel/prompts/`（提示词）、`pixel/icons/`（Hugeicons 的 SVG 和排参考图的 `ref.py`）；`assets/` 只留最早一套手绘界面的 `gen.sh`、提示词和原图；`art.sh` 把单独仓库 vibevalley-art 里的原图链接进来；`names.md` 是给档案和人物起名的梗。

## 模型和不变量

- **一个事实一个家。** 常驻规矩在根目录 `AGENTS.md`，一条一到三行、链接到它的家；当前的行为在 `docs/`，子系统写沉淀下来的样子和理由；包的对外约定在包的 README；计划在 Note。别处只链接。
- **索引和操作各有自己的家。** `docs/README.md` 是唯一的手工文档地图，其他目录不另列子系统或参考清单；`docs/**/*.md` 除地图自身外都要从地图链到，`doc-links.ts` 查漏收。界面清单在 `reference/farm-ui.md`，素材生成和切图的操作在 `development.md`，流程和理由留在这里。
- **Note 是计划，子系统是沉淀。** Note 走 `proposed/` → `implemented/`；做完以后仍然成立的决定和放弃的路写进子系统的「为什么这样」，Note 删掉，指向它的链接改指子系统；子系统的「还没做的」只放 `proposed/` 的链接。没沉淀之前，`implemented/` 的 Note 跟着代码改事实（路径、名字、默认值）。
- **生命周期和类别都在路径里**：`.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`。类别是封闭的集合，以 `agent-notes.ts` 的 `AGENT_NOTE_CLASSES` 为准；`Status:` 行要和所在目录一致，每个生命周期有必需和禁止的章节。
- **清单只有一份，是生成的。** `CATALOG.md` 只来自路径和每篇的 `# Agent Note:` 标题，按生命周期、类别列，新的在前，否决的带上理由；不手改，`notes:catalog` 重写；手写的 `INDEX.md` 放进来就报错。合并冲突时重新生成。
- **链接从仓库根写**，不写 `../`、`./`，不以 `/` 开头；目标要存在，大小写要和磁盘上的文件一致（macOS 不分大小写，`agents.md` 会打开 `AGENTS.md`）。外链不抓、`#片段` 不查；代码块和反引号里的链接算例子。
- **反引号里的源文件路径也查**：带一层以上目录、扩展名是 `go`、`dart`、`ts`、`tsx`、`astro`、`sql`、`json`、`yaml`、`sh`、`py`、`gz` 的，要能在仓库里找到；可以从仓库根写、从包里写（`core/core.ts`），或相对文档所在目录。范围是全部受管的 Markdown，除了 `.agents/notes/`（Note 写的是当时的文件）。没目录或扩展名不在表里的（家目录里的 `config.json`）不查；还没 `git add` 的新文件也算在仓库里。类型和函数名不查。
- **旧名字只在代码里查**：`stale-names.ts` 扫 `apps/server/src`、`apps/web/src`、`apps/web/test`、`packages/protocol/src` 的 TypeScript，命中时报文件、行号和该写成什么。一个名字进这张表，要求改名本身是个决定，而不是这个词还有别的正经意思（测试的 helper、界面上的帮工、游戏里的收获都不算）。
- **skill 放在 `.agents/skills/<名字>/SKILL.md`**：frontmatter 的 `name` 和目录同名、`description` 不空；`acceptance` 的入口和每份分册（同目录的其他 `.md`）都要有「什么时候用」「准备」「步骤」「证据」「出错时」「收拾」六节，入口的表正好列全分册；README 的表和目录一一对得上；`.claude/skills` 必须是指向 `../.agents/skills` 的符号链接。
- **名字**：给人看的地方用 VibeValley 和码农场物语（窗口、首页、通知、Dock 写码农场物语，文档正文写 VibeValley），代码、命令、目录、环境变量（`VIBEVALLEY_*`）、分支（`vibevalley/…`）、bundle id（`dev.vibevalley.app`）写小写的 `vibevalley`；GitHub 组织是 `vibevalleyhq`，官网 vibevalley.dev。改名以前就删掉的东西（旧 TypeScript 服务端、Electron 应用）讲到时照旧写它当时的名字，只有还在的东西用新名字。代码里不认旧名字。

## 怎么走

**一件非平凡的工作**：先在 `proposed/` 写计划 Note（什么时候要写见 [Note 的规矩](.agents/notes/README.md#什么时候写)）→ 做的时候挪到 `implemented/`，`## Proposal` 改成现在时的 `## Decision` → 做完把仍然成立的写进子系统、删 Note、改链接 → `bun run notes:catalog` 重写清单 → `bun run docs:verify`。

**挡住一类反复出现的问题**，按顺序选，能用前面的就不用后面的：

1. **代码**：结构、类型、不变量、边界，把一类问题整个消掉（核心状态只有一份、形状只在 protocol、生成的不手改）。
2. **静态检查**：lint、测试、CI、形式化验证（黄金数据、`docs:verify`、`schema.test.ts`、`tsc` 查穷尽的 `switch`）。
3. **文字**：注释、规矩、skill，只写没法强制、要判断的。已经有检查的规矩，只留一句和检查的命令。
4. **人看**：花在设计让 agent 默认就做对的环境上，不花在逐行看每个 PR 上。

**写一个验证 skill**（照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md)）：先问能不能改成代码或检查 → 在真的改动上完整验证一遍，记下命令和看到的输出 → 写成固定的六节 → 让一个没有上下文的子 agent 照着做一遍。「证据」一节列出 agent 说「验证过了」时要附上的输出或截图，主人看证据，不看过程。验证 skill 默认不派真的帮工（花钱，要主人点头）。

**加一张素材**：`design/art.sh` 链接原图 → `design/pixel/gen.sh <名字>`（两倍密是 `hd-<名字>`）让 codex 照参考图出一张品红底的整图到 `design/pixel/raw/` → `process.py` 里写「哪张图、几行几列、每格叫什么」，去品红、切格、缩成像素画、算落脚点，写出 PNG 和 `sprites.json`。按钮图标先 `python3 icons/ref.py <表>` 把 Hugeicons 的形状排成参考图，再生图、切图。操作命令和应用图标的位置见[开发](docs/development.md#素材音效和官网)。

## 和谁打交道

- **根目录 `AGENTS.md`**：「怎么让 agent 做对」一节是四层手段的常驻版本，理由链到这里；规矩列表里每条链到它的家。
- **各子系统**：沉淀的去处；`docs:verify` 查它们的链接和路径。
- **地基、客户端**：它们的检查（黄金数据、`schema.test.ts`、`db:check`、各包的类型）是第 2 层的另一半，跟着各自的代码住。
- **验收只有一个 skill**：[acceptance](.agents/skills/acceptance/SKILL.md) 的入口写共同的沙箱（`scripts/verify-server.ts` 起隔离的服务端）、证据和收拾，按「改了什么」指到一份分册（服务端、页面、手机壳、管家的评测，管家的评测归[管家](docs/subsystems/orchestrator.md)）。一个入口，agent 改完不用先猜该找哪个 skill；分册只在用得上时读，验一个接口不带上模拟器和花钱的步骤。
- **农场的皮**：读 `process.py` 写出的 `apps/web/public/pixel/` 和 `sprites.json`；界面按钮图标只用这条流水线的贴图（[AGENTS.md](AGENTS.md#规矩)「图标是像素素材」）。

## 为什么这样

- **挡问题先用代码和检查，文字和人看排在后面。** 代码大多由 agent 写，agent 照已有的代码抄、走最短的路，人每个 PR 都细看跟不上；只靠规矩和人审，同一类问题会一再出现：规矩越长越容易漏读、读偏，人审会漏。放弃了「规矩写全，靠人审兜底」。
- **验证写成 skill，不写进 `docs/development.md`。** 测试用假的帮工、假的服务端，证明不了服务端起得来、页面画得对，得有人在真的程序上看；文档是给人读的现状，agent 改完不会自己想起去读，skill 有 description，agent 按改动的路径会想起它。
- **skill 放 `.agents/skills`，再从 `.claude/skills` 链过去。** 和 `.agents/notes` 一样不绑一家 agent，Claude Code 和 Codex 读同一份；放在 `.claude/skills` 只有 Claude Code 读。
- **文档只写现状，理由和计划另有家。** 一份文档同时写现状、历史和理由，读的人分不清哪句还算数，理由一改文档就丢。放弃了一个 `decisions.md` 记全部决策（越写越长、改动挤在一个文件、分不清哪些还在提案），也放弃了理由留在文档里（文档会被不断改成现状，理由跟着被删）。照 DeepSeek Harness 的 Agent Notes，类别也编进路径，没照 kico 写在 `Category:` 行。
- **Note 做完就沉淀进子系统、删掉。** 留着的 `implemented/` Note 要跟着代码改事实，几十篇散着，讲一个子系统的理由要翻好几篇；子系统一篇讲完边界、模型和放弃的路，Note 只剩计划这一个用途。
- **清单生成，不手写。** 手写的 `INDEX.md` 会和路径、标题对不上，不相关的改动挤在一个文件上；只靠目录和搜索，要总览就得翻两层目录。也没把清单写进 README 的一节（重新生成时得小心只换那一节），没给每篇加一行摘要（每篇多一个要维护的字段，标题已经说得清）。
- **检查跑在 Bun 上。** Bun 自带 glob 和文件读写，脚本不用别的依赖、不带构建；Node 只跑服务端（它的 agent SDK 在 Node 上）。
- **链接从仓库根写。** 一个文件不管从哪链过去都是同一个写法，挪了它搜一个字符串就能改完；以 `/` 开头读起来像磁盘上的绝对路径。
- **反引号里的路径查，名字不查。** 挪文件、改名时文档里的旧路径没人提醒，一轮下来当前文档里写着早不在的文件；名字试过一起查，驼峰词在代码里找不到就报，会报出例子和别处的叫法（`QUOTA_LOW`、`XMembers`），要维护白名单。名字改由 `stale-names.ts` 在代码里查，表里只放有决定的改名。
- **写作规范以信息密度为主，STE 只留词和格式。** 整篇照 ASD-STE100 时，管得住一句话会不会被读错，管不住一段话该不该有：每句合规的 Note 仍然把清单抄一遍、同一条理由写两遍；「一句一事」「每句不超过 50 字」「三项以上用列表」还把一个因果拆碎，和信息密度相反。没选两套都留（句子层方向相反，写的人要自己裁决），也没选 STE 全删（「应」「宜」分不清、同一个东西换着叫，agent 会读错）。这条写不成检查，属于第 3 层。
- **素材用 codex 照参考图生成，脚本切图。** 风格一致的素材有几百张（田地十几种状态、7 种动物 × 4 套衣服 × 6 个动作、走路循环、图标），手画不现实。一张生成图是一只动物穿一套衣服的全部动作，所以同一个角色各个动作长得一样，放弃了每个动作单独生成；切图只写清单，换一次图重跑，放弃了手切。重新打光（黄昏、夜里）以原图为参考只改光线。代价是生图要 codex 和网络、结果要人看一眼。
- **原图留着，但放在单独的仓库。** 生图不是确定的，原图删了就回不来；原图和效果图有四百多 MB，不该让每次克隆都带上。`design/art.sh` 链接回 `design/`，脚本照常读写。
- **叫 VibeValley（码农场物语）。** 原名 heybro 在 GitHub 上撞了一个同样做 AI agent 的项目，也说不出它是什么。VibeValley 一个词连着 vibe coding、《星露谷物语》的田园感和硅谷；码农场物语是「码农」「农场」的双关，「物语」呼应《牧场物语》。放弃了 vibefarm（域名、游戏、GitHub 名都被占）、viberfarm（VIBER 是注册商标，读音也撞）、只改仓库名（GitHub 和应用两个名字，传不起来）、只改名字不改数据里的 id（看不见的地方永远叫旧名，新代码要记住例外），也放弃了兼容旧名字：每个读环境变量或目录的地方都得记着旧名，而当时没有外部用户，改一次最便宜。

## 还没做的

- 用 VibeValley 开发 VibeValley：干活的农场和正在改的代码分开、合并前跑检查、渠道各用各的工作目录：[提案](.agents/notes/proposed/process/2026-10-18-build-vibevalley-with-vibevalley.md)。

## 怎么验证

- `bun run docs:verify`：依次跑 `agent-notes.ts`、`skills.ts`、`doc-links.ts`、`stale-names.ts`，任何一个失败都退出 1，报出文件和行号。
- 在文档里写一个不存在的反引号路径或 `../` 链接，`bun scripts/doc-links.ts` 报错；删掉一份验收分册的「证据」一节、或入口的表漏了一份，`bun scripts/skills.ts` 报错；加一篇 Note 不跑 `notes:catalog`，`bun scripts/agent-notes.ts` 报 `CATALOG.md` 过期。
- `bun test scripts/verify-server.test.ts`：`only a machine receipt from the owned process announces readiness`、`sandbox owns isolation, readiness, validation failure and cleanup`。
- 素材没有自动检查：重跑 `process.py` 后看 `git diff apps/web/public/pixel/`，图鉴页能看全部贴图。
