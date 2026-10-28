# 设置和配置

服务端的值从三处来：配置（`base/config.ts` 的 `Config`，由 `loadConfig` 用 Effect 的 `Config` 读，开机读一次：环境变量在前，`VIBEVALLEY_` 加键名，DeepSeek 和声网的三把钥匙也认它们自己的名字；再是 `vibevalley.yaml`，最后是默认值）、「设置」（`Setting`，主人在工作台「设置」页 `/settings` 填的钥匙、语音、听写、记性的来源，存在 `$VIBEVALLEY_HOME/settings.json`），和代码里的默认值（`defaults()`）。设置里的钥匙比配置优先，每次用时现取，存了不用重启。服务端写出的每一行过一遍 `redact`，钥匙不进日志。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 配置的来源、优先级、键名到环境变量名、开机时的校验、每个键的用途和默认值 | oar 的 `OAR_*`、各家农机自己的环境变量和配置（`CODEX_HOME`、pi 的 `models.json`） |
| `settings.json`：存、读、校验、只给页面看来源和末四位 | 语音设置的每一项、谁接电话（[语音](docs/subsystems/voice.md)「配置」） |
| 钥匙从哪取：设置 > 配置 | 记性来源怎么接、怎么读写（[记性](docs/subsystems/memory.md)） |
| 日志和送出农场的文字里抹密钥（`base/redact.ts`） | 档案、技能书、农机的设置：`config.json`（`agent` 包） |
| | 首页、设置页的样子（[farm-ui.md](docs/reference/farm-ui.md) 的「设置」、`apps/web/src/features/setting/SettingsForm.tsx`） |
| | GitHub 检测（`project`，[工单](docs/subsystems/issue.md)「和谁打交道」） |

## 在哪

- 配置：`apps/server/src/base/config.ts`（`Config`、`defaults`、`loadConfig`、`serverAddress`、`dbDir`、`projectsDir`、服务 `Settings`）。`src/main.ts` 用 `--config` 指一个别的文件；命令行只读家目录的。
- 设置：`apps/server/src/setting`：`setting.ts`（`Setting`、`settings.json` 的形状、取钥匙的方法、交给别的服务的 `VoiceConfig`、`DictationConfig`、`MemorySourceConfig`）、`rules.ts`（`settingsProblem`、`keyHint`、记性来源的校验和合并、语音的校验和只存差异）。规则的黄金数据在 `setting/testdata/rules.jsonl.gz`。
- 抹密钥：`apps/server/src/base/redact.ts`（`redact`、`redactOutput`）。
- 接口：`setting.get`、`setting.check`、`setting.update`（[capabilities.md](docs/reference/capabilities.md)），形状是 `SettingsStatus`、`SettingsUpdate`、`Check`、`KeyStatus`。
- 页面：`apps/web/src/features/setting/SettingsPage.tsx`，表单 `SettingsForm.tsx`。

## 模型和不变量

**配置**：

- **两个来源**，优先级从低到高：`defaults()`、YAML（`$VIBEVALLEY_HOME/vibevalley.yaml`，或 `--config` 给的文件）、环境变量。环境变量名是 `VIBEVALLEY_` 加键名、点换成下划线（`session.stall_seconds` → `VIBEVALLEY_SESSION_STALL_SECONDS`）；`defaults()` 里没有的键不从环境变量读。数、一串（环境变量里逗号分隔）、字按默认值的种类读。
- **三个外家的钥匙用它们自己的名字**：`DEEPSEEK_API_KEY`、`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE` 绑到 `deepseek.api_key`、`agora.app_id`、`agora.app_certificate`，YAML 里也能写。
- **家目录不在 YAML 里**：YAML 在家目录里，家目录只由 `VIBEVALLEY_HOME` 定，默认 `~/.vibevalley`。
- **`defaults()` 是默认值的唯一出处，零就是零**：端口 0 是随便一个，`patrol.heartbeat_minutes` 0 是关掉巡查。
- **读不成就不起来**：`--config` 给了却找不到的文件、读不成数字的值、不在 0–65535 的 `port`、`voice.line.port`、`lan.port`，`github.pr_poll_seconds` 不大于 0，`loadConfig` 都报错，服务端不起来。家目录的 `vibevalley.yaml` 不在时照默认。
- **读完再整理**：`work_root`、`tokei`、`web`、`db` 里开头的 `~/` 换成用户目录；`db` 是 `memory` 时用内存库，空的是家目录的 `db` 文件夹（`dbDir`），别的是那个文件夹。
- **主接口的地址固定**：`serverAddress` 是 `127.0.0.1:<port>`，没有 `host` 配置，设了 `VIBEVALLEY_HOST` 也不认。
- **服务只读 `Config` 的字段**：开机读一次，作为 `Settings` 服务交给各服务，不读 `process.env`；测试从 `testing/layers.ts` 的 `testConfig()` 出发改字段。不热重载：改了配置要重启服务端。

**配置键**（默认值由 `defaults()` 给出）：

| 键 | 用途 | 默认 |
|---|---|---|
| `work_root` | 工作目录：`projects/` 是项目，`worktrees/` 是 worktree，帮工只在这里面干活（[项目](docs/subsystems/project.md)） | `~/vibevalley-dev` |
| `db` | 库：PGlite 的文件夹；`memory` 是只在内存里 | `$VIBEVALLEY_HOME/db` |
| `port` | 主接口固定听 `127.0.0.1`，只能选端口；0 由系统分配。HTTP 和帮工的 `/mcp` 使用同一实际监听地址 | 8787 |
| `web` | 同时在 `/` 提供的页面（`apps/web/dist`）；也可以用 `--web` 给 | 无 |
| `agent.model` | 命令行里自己的 agent 用的模型；空着是 DeepSeek 的默认 | |
| `deepseek.api_key` | 管家和 VibeValley 农机用的 DeepSeek 钥匙（`DEEPSEEK_API_KEY`） | |
| `agora.app_id`、`agora.app_certificate` | 语音：签 RTC 令牌、请语音管家（`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`）；都没有时语音不可用，别的照常 | |
| `voice.id` | 语音管家的音色的默认；声音页里改过的优先 | 声音页的默认 |
| `voice.line.port`、`voice.line.url` | 语音线路（「想」选农场的管家时）：只给声网用的那个监听的端口；你自己的隧道的公网地址，没有就用 cloudflared 临时隧道 | 8788、（无） |
| `lan.port` | 「连接到本机」的端口：打开「连接到本机」时在所有网卡上听，只放配对过的设备（[连接到本机](docs/subsystems/lan.md)）；0 是随便一个 | 8790 |
| `agent.starters` | 新农场除了默认管家还装哪些内置的模板（`apps/server/src/agent/templates` 的 id，照这个次序）；环境变量里用逗号分隔 | 空：帮工由主人在模板目录里挑 |
| `git_emails` | 算经验时也算作「你」的 commit 邮箱；环境变量里用逗号分隔 | git 全局和各仓库的 user.email 本来就算 |
| `tokei` | 数项目种了什么用的 tokei 在哪 | PATH 上的 `tokei` |
| `cny_per_usd` | 价目表是美元，折成人民币的汇率 | 7.2 |
| `patrol.heartbeat_minutes` | 巡查的间隔，0 是关掉 | 10 |
| `cron.tick_ms` | 多久看一遍有没有到点的定时任务 | 20000 |
| `session.stall_seconds` | 一轮里多久没动静就提醒 | 240 |
| `session.trajectory_days` | Session 走了以后，它的事件日志留几天（`session` 表里的行一直留着）；0 是一直留着 | 30 |
| `project.max_sessions` | 一个项目里最多几个帮工同时干活 | 3 |
| `project.check_timeout_seconds` | 合进主分支前在帮工 worktree 里运行 `.vibevalley/check` 的时限，超时拒绝合并 | 1200 |
| `github.pr_projects` | 完成时提 PR 的项目名列表；还须项目的 `pullRequest.available` 为真，其他项目本地合并 | 空列表 |
| `github.pr_poll_seconds` | 查询开着的 PR 的间隔，单位秒，必须大于 0 | 180 |
| `chat.notice_batch_ms` | 忙着的帮工收到的提示，攒多久合成一条 | 3000 |
| `chat.retry_wake_ms` | 叫醒在开口前就失败了，多久以后再叫一次 | 3000 |
| `otlp.url` | OTLP 收集器的地址（如 `http://127.0.0.1:4318`）：填了，`Effect.fn` 的 span、日志和指标都送过去；空着不送 | 空 |

**设置**：

- **`settings.json` 只有你能读**（0600），由 `base/files.ts` 的 `FileWriter` 写：先写临时文件再改名，写到一半崩了也不留半个文件。开机按 `Stored` 的 Schema 读一次进内存，之后读内存；文件不存在就从空设置开始；读取、JSON 解析或形状校验失败，就改名成 `settings.json.unreadable-<毫秒>` 留着、从空设置开始并记日志：钥匙还在那份文件里，之后的保存写的是新文件，不会盖掉它；改不了名就不开机。
- **设置 > 配置**：`deepseekApiKey()`、`agora()` 每次被调时按「设置里有就用设置的，没有用配置的」取，App ID 和 Certificate 各取各的；两样凑不齐时 `agora()` 是 `undefined`，语音不可用，别的照常。来源（`KeyStatus.source`）只有 `settings` 和 `config` 两种。
- **只在设置里有的**：语音服务的 ASR、LLM、TTS key，听写（地址、模型、key），记性的来源（地址、key、开关）。听写没填地址就是关着（`dictation()` 是 `undefined`）。
- **钥匙不出服务端**：`status()` 对每把钥匙只给来源和末四位（`keyHint`：`…` 加最后 4 个 UTF-16 码元）；Agora 的 App ID 不算钥匙，整串给。
- **一次更新**：没给的字段不动，给了空字符串就清掉（清掉后露出配置里的那把）；值去掉两头空白。听写的地址和模型都空时整项删掉；记性来源整张换掉，没给 key 的来源沿用这一种原来存的 key。
- **格式不对就一样都不存**（`settingsProblem`）：DeepSeek 的钥匙带空格或不到 8 个字；Agora 的 App ID、Certificate 不是 32 位十六进制；语音服务的 key 带空格；听写的地址不是 `http(s)://` 开头或没填模型；记性来源不认识、同一种接了两个、打开了却没地址、地址不对、key 带空格；语音设置不对（`voiceProblem`）。`setting.check` 只回这句话，`setting.update` 把它当 409 拒绝。不调 DeepSeek、Agora 去验证钥匙。
- **语音只存和默认不同的**：默认是 `defaultVoice()`，配置的 `voice.id` 改它的音色；存的时候只留和默认不同的项，全一样就不存。以后改了默认，主人没动过的那几项跟着变；「恢复默认」回到它。
- **一次取齐**：`voiceConfig()`（语音设置、三把 key 和 DeepSeek 钥匙）、`dictation()`（地址和 key）、`memorySources()`（地址和 key）各从同一份设置里一次读出，地址不会和另一次保存的 key 配在一起。

**抹密钥**：

- `redact` 把长得像钥匙的写成 `[redacted]`：私钥块、`sk-…`、`ghp_…` 这类和 `github_pat_…`、`xox[abprs]-…`、`AKIA…`、`AIza…`、JWT（`eyJ…` 三段）、农场自己的会话令牌（`hb_…`，`session/session.ts`）；`Bearer` 后面的值；名字里带 `api_key`、`secret`、`token`、`password`、`passwd`、`access_key`、`certificate` 后面跟 `=` 或 `:` 的值，名字留着（`api_key=[redacted]`）。
- 服务端写到 stdout、stderr 的每一次都过一遍（`main.ts` 的 `redactOutput`：日志、库自己打的字都在里面；一把钥匙被拆在两次写入里时漏过去，`console` 一次写一行）；记性送往外面来源的文字也过它（`memory/everos.ts`、`memory/nowledge.ts`）：加一条规则两处都管。

## 怎么走

**开机**：`loadConfig` 读出 `Config` → 作为 `Settings` 交给各服务；`Setting` 建的时候记下配置里的三把钥匙和语音的默认，读一次 `settings.json`。

**主人填一把钥匙**：设置页先 `setting.check` 看格式，再 `setting.update`；服务端校验、合进内存里的那份、整份写回 `settings.json`，回新的 `SettingsStatus`。

**用的时候现取**：

| 谁 | 什么时候取 |
|---|---|
| 管家（`orchestrator`） | 每次请求模型前，`agentcore` 的 `getApiKey` 问 `DeepseekAPIKey()`；没钥匙起不来的失败不缓存，下一句话再试 |
| VibeValley 农机的帮工（`runtime.Registry`） | 每个会话开始时取 DeepSeek 钥匙 |
| 语音（`voice`） | 每次签令牌、请语音管家时取 `Agora()`、`VoiceConfig()`；听写每次取 `Dictation()` |
| 记性（`memory`） | 每次读写前对一遍 `MemorySources()`，变了就照新的重建 |

## 和谁打交道

- **谁依赖配置**：几乎所有服务的 `make` 都拿 `Settings`；每个键归哪个子系统，见本篇「配置键」的表。
- **谁依赖设置**：`orchestrator`、`runtime`、`voice`、`memory` 拿 `Setting`，只调取值的方法；`handlers.ts` 调 `status`、`check`、`save`，`check` 的结果里补上 `project` 的 GitHub 状态。
- **「连接到本机」**：配对过的设备能看设置、能检查（`setting.get`、`setting.check`），不能保存：`setting.update` 没有 `remote`（[连接到本机](docs/subsystems/lan.md)）。
- **桌面版**：起服务端时设 `VIBEVALLEY_PORT=0` 和登录 shell 的 `PATH`，别的照环境和家目录的配置（[客户端](docs/subsystems/app.md)）。
- **不归这里**：`runtime` 算 pi 那台农机的余额时，照 pi 自己的规则找 pi 的 DeepSeek 钥匙（`piDeepseek`）：那是 pi 的配置。

## 为什么这样

- **配置只有 YAML 和环境变量两个来源，照默认值的形状读。** 放弃了环境变量照旧散着读：值从哪来还要翻每个服务，测试只能改进程的环境。`defaults()` 的每个键就是能配的全部，环境变量名、数和一串怎么读都从它推出，不另写一张表。不热重载。不读 `.env`、不从 pi 的 `models.json` 找我们的钥匙、没有 `DEEPSEEK_BASE_URL`。
- **配置用 YAML，不用 JSON。** 它是人手写的文件，YAML 能写注释；`config.json`、`settings.json` 由程序写。
- **一个有类型的 `Config`，服务不读 `process.env`。** 一个值从哪来，看 `Config` 的字段和本篇的配置键表就够；测试改字段，不改进程的环境。
- **写错的值让服务端起不来，不悄悄用默认。** 悄悄落回默认时，主人以为改了的值其实没生效。
- **钥匙存在服务端的家目录（`settings.json`），不存在页面里。** 放弃了存在页面里、每次带给服务端：几台设备各一份，钥匙还经过页面。服务端本来就是持有钥匙的一方。放弃了写回 `vibevalley.yaml`：那是人手写的文件，程序改它要保住注释和顺序；另一个文件也能单独设 0600。
- **设置比配置优先。** 主人在应用里最后填的那把最该算数；装好应用的人不知道还有一个配置文件。
- **每个用钥匙的地方现取，不在开机时拷一份。** 存了就用上，不用重启；管家起不来的失败也不会被缓存住。
- **保存时只查格式，不调对方验证。** 要花一次请求，Agora 的 Certificate 也没有便宜的验证办法；用时出错照旧说明白。
- **一份抹密钥的规则，日志和送出农场的文字共用。** 两份规则迟早不一样，漏掉的那份就是泄露的口子。

## 还没做的

现在没有提案。

## 怎么验证

- `apps/server/src/base/config.test.ts`：默认、文件、环境变量依次覆盖；读不成的拒绝（找不到的 `--config`、读不成数字的端口）；主接口的地址总在回环上；提 PR 的配置。
- `setting/setting.test.ts`：这里存的钥匙比配置的优先、只露出末四位；格式不对什么都不存；语音只存和默认不同的、默认由配置定；语音服务的 key 只给提示；记性来源的 key 留到清掉。`setting/rules.test.ts`：黄金数据和设置拒绝什么、语音只存差异、记性来源。
- `base/base.test.ts`：钥匙从文字里抹掉、别的留着；服务端写出的字抹过钥匙；存的文件整份写、封住以后不再写；一个家目录一个服务端。
- 页面：`apps/web/test/settings.spec.ts`（DeepSeek 的钥匙存、只露末尾、清掉；记性的来源；声音页的两部分）。
