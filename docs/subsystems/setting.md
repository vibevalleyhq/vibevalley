# 设置和配置

服务端的值从三处来：配置（`base.Config`，由 `base.LoadConfig` 从 `vibevalley.yaml` 和环境变量读，开机读一次）、「设置」（`setting.Service`，主人在工作台「设置」页 `/settings` 填的钥匙、语音、听写、记性的来源，存在 `$VIBEVALLEY_HOME/settings.json`），和代码里的默认值（`base.Defaults()`）。设置里的钥匙比配置优先，每次用时现取，存了不用重启。日志整行过一遍 `base.Redact`，钥匙不进日志。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 配置的来源、优先级、键名到环境变量名、开机时的校验 | 每个键的用途和默认值的查表（[architecture.md](docs/architecture.md)「配置」） |
| `settings.json`：存、读、校验、只给页面看来源和末四位 | 语音设置的每一项、谁接电话（[语音](docs/subsystems/voice.md)「配置」） |
| 钥匙从哪取：设置 > 配置 | 记性来源怎么接、怎么读写（[记性](docs/subsystems/memory.md)） |
| 日志和送出农场的文字里抹密钥（`base/redact.go`） | 档案、技能书、农机的设置：`config.json`（`agent` 包） |
| | smith 的 `OAR_*`、各家农机自己的环境变量和配置（`CODEX_HOME`、pi 的 `models.json`） |
| | 首页、设置页的样子（[farm-ui.md](docs/reference/farm-ui.md) 的「设置」、`workbench/settings/settings_form.dart`） |
| | GitHub 检测（`project`，[工单](docs/subsystems/issue.md)「和谁打交道」）；`setting.check` 顺带回它的结果 |

## 在哪

- 配置：`server/internal/base/config.go`（`Config`、`Defaults`、`LoadConfig`、`ServerAddress`、`DB`、`ProjectsDir`）。`cmd/server`、`cmd/migrate` 用 `--config` 指一个别的文件；`cmd/vibevalley` 只读家目录的。
- 设置：`server/internal/setting`：`setting.go`（`Service`、`settings.json` 的形状 `voiceStored`、取钥匙的方法）、`rules.go`（`settingsProblem`、`keyHint`、记性来源的校验和合并）、`voice_rules.go`（语音的校验和只存差异）、`types.go`（交给别的服务的 `VoiceConfig`、`DictationConfig`、`MemorySourceConfig`）。规则的黄金数据在 `setting/testdata/rules.jsonl.gz`。
- 抹密钥：`server/internal/base/redact.go`（`Redact`、`RedactingWriter`）。
- 接口：`setting.load`、`setting.check`、`setting.save`（[capabilities.md](docs/reference/capabilities.md)），形状是 `protocol` 的 `SettingsStatus`、`SettingsUpdate`、`SettingsCheck`、`KeyStatus`。
- 客户端：`workbench/settings/settings_page.dart`，表单 `workbench/settings/settings_form.dart`。

## 模型和不变量

**配置**：

- **两个来源，由 viper 读**，优先级从低到高：`base.Defaults()`、YAML（`$VIBEVALLEY_HOME/vibevalley.yaml`，或 `--config` 给的文件）、环境变量。环境变量名是 `VIBEVALLEY_` 加键名、点换成下划线（`session.stall_seconds` → `VIBEVALLEY_SESSION_STALL_SECONDS`）；`Defaults` 里没有的键不从环境变量读（`setDefaults` 给每个键先设默认，viper 才会去找它的环境变量）。
- **三个外家的钥匙用它们自己的名字**：`DEEPSEEK_API_KEY`、`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE` 绑到 `deepseek.api_key`、`agora.app_id`、`agora.app_certificate`，YAML 里也能写。
- **家目录不在 YAML 里**：YAML 在家目录里，家目录只由 `VIBEVALLEY_HOME` 定，默认 `~/.vibevalley`。
- **`Defaults()` 是默认值的唯一出处，零就是零**：端口 0 是随便一个，`patrol.heartbeat_minutes` 0 是关掉巡查。
- **读不成就不起来**：`--config` 给了却找不到的文件、读不成数字的值、不在 0–65535 的 `port`、`voice.line.port`、`lan.port`，`github.pr_poll_seconds` 不大于 0，`LoadConfig` 都报错，服务端不起来。家目录的 `vibevalley.yaml` 不在时照默认。
- **读完再整理**：`work_root`、`tokei`、`db` 里开头的 `~/` 换成用户目录；`db` 是 `memory` 时换成 `:memory:`，是文件夹时用里面的 `vibevalley.db`，空的是家目录的 `vibevalley.db`。
- **主接口的地址固定**：`ServerAddress()` 是 `127.0.0.1:<port>`，没有 `host` 配置，设了 `VIBEVALLEY_HOST` 也不认。
- **服务只读 `base.Config` 的字段**：开机读一次，经 fx 交给服务，不调 `os.Getenv`；测试从 `testkit/fixture` 的 `fixture.Config(home, work, db)` 出发改字段。不热重载：改了配置要重启服务端。

**设置**：

- **`settings.json` 只有你能读**（0600），由 `base.FileWriter` 写：先写临时文件再改名，写到一半崩了也不留半个文件。开机读一次进内存，之后读内存；文件读不成或不是 JSON 时当作空的。
- **设置 > 配置**：`DeepseekAPIKey()`、`Agora()` 每次被调时按「设置里有就用设置的，没有用配置的」取，App ID 和 Certificate 各取各的；两样凑不齐时 `Agora()` 是 nil，语音不可用，别的照常。来源（`KeySource`）只有 `settings` 和 `config` 两种。
- **只在设置里有的**：语音服务的 ASR、LLM、TTS key，听写（地址、模型、key），记性的来源（地址、key、开关）。听写没填地址就是关着（`Dictation()` 回 false）。
- **钥匙不出服务端**：`Status()` 对每把钥匙只给来源和末四位（`keyHint`：`…` 加最后 4 个 UTF-16 码元）；Agora 的 App ID 不算钥匙，整串给。
- **一次更新**：没给的字段不动，给了空字符串就清掉（清掉后露出配置里的那把）；值去掉两头空白。听写的地址和模型都空时整项删掉；记性来源整张换掉，没给 key 的来源沿用这一种原来存的 key。
- **格式不对就一样都不存**（`settingsProblem`）：DeepSeek 的钥匙带空格或不到 8 个字；Agora 的 App ID、Certificate 不是 32 位十六进制；语音服务的 key 带空格；听写的地址不是 `http(s)://` 开头或没填模型；记性来源不认识、同一种接了两个、打开了却没地址、地址不对、key 带空格；语音设置不对（`voiceProblem`）。`setting.check` 只回这句话（顺带 GitHub 的状态），`setting.save` 把它当 409 拒绝。不调 DeepSeek、Agora 去验证钥匙。
- **语音只存和默认不同的**：默认是 `protocol.DefaultVoice()`，配置的 `voice.model`、`voice.id` 改它的「谁接电话」和音色；存的时候只留和默认不同的项，全一样就不存。以后改了默认，主人没动过的那几项跟着变；「恢复默认」回到它。
- **一次取齐**：`VoiceConfig()`（语音设置、三把 key 和 DeepSeek 钥匙）、`DictationConfig`（地址和 key）、`MemorySourceConfig`（地址和 key）各在一把锁里读，地址不会和另一次保存的 key 配在一起。

**抹密钥**：

- `base.Redact` 把长得像钥匙的写成 `[redacted]`：私钥块、`sk-…`、`ghp_…` 这类和 `github_pat_…`、`xox[abprs]-…`、`AKIA…`、`AIza…`、JWT（`eyJ…` 三段）、农场自己的会话令牌（`hb_…`，`session/tokens.go`）；`Bearer` 后面的值；名字里带 `api_key`、`secret`、`token`、`password`、`passwd`、`access_key`、`certificate` 后面跟 `=` 或 `:` 的值，名字留着（`api_key=[redacted]`）。
- 服务端的日志（`cmd/server` 的 `log.SetOutput(base.RedactingWriter(…))`）每次写入整行过一遍；记性送往外面来源的文字也过它（`memory/everos.go`、`memory/nowledge.go`）：加一条规则两处都管。

## 怎么走

**开机**：`base.LoadConfig` 读出 `Config` → fx 交给各服务；`setting.New` 记下配置里的三把钥匙和语音的默认，读一次 `settings.json`。

**主人填一把钥匙**：设置页先 `setting.check` 看格式，再 `setting.save`；服务端校验、合进内存里的那份、整份写回 `settings.json`，回新的 `SettingsStatus`。

**用的时候现取**：

| 谁 | 什么时候取 |
|---|---|
| 管家（`manager`） | 每次请求模型前，`agentcore` 的 `GetApiKey` 问 `DeepseekAPIKey()`；没钥匙起不来的失败不缓存，下一句话再试 |
| VibeValley 农机的帮工（`runtime.Registry`） | 每个会话开始时取 DeepSeek 钥匙 |
| 语音（`voice`） | 每次签令牌、请语音管家时取 `Agora()`、`VoiceConfig()`；听写每次取 `Dictation()` |
| 记性（`memory`） | 每次读写前对一遍 `MemorySources()`，变了就照新的重建 |

## 和谁打交道

- **谁依赖配置**：几乎所有服务的构造函数都拿 `base.Config`；每个键归哪个子系统，见 [architecture.md](docs/architecture.md)「配置」的表。
- **谁依赖设置**：`manager`、`runtime`、`voice`、`memory` 拿 `*setting.Service`，只调取值的方法；`handler` 调 `Status`、`Check`、`Save`，`Check` 的结果里补上 `project` 的 GitHub 状态。
- **「连接到本机」**：配对过的设备能看设置、能检查（`setting.load`、`setting.check`），不能保存：`setting.save` 没有 `remote`（[连接到本机](docs/subsystems/lan.md)）。
- **macOS 应用**：起服务端时设 `VIBEVALLEY_HOME`、`VIBEVALLEY_WORK_ROOT`、`VIBEVALLEY_PORT` 和登录 shell 的 `PATH`（[客户端](docs/subsystems/app.md)）。
- **不归这里**：`runtime` 算 pi 那台农机的余额时，照 pi 自己的规则找 pi 的 DeepSeek 钥匙（`piDeepseek`）：那是 pi 的配置。

## 为什么这样

- **配置只有 YAML 和环境变量两个来源，由 viper 读。** 放弃了只删 `.env`、环境变量照旧散着读：值从哪来还要翻每个服务，测试只能改进程的环境。放弃了自己写 YAML 的读取：环境变量覆盖、默认值、嵌套键到变量名的映射正是 viper 做的事。只用它的读取，不用热重载。不读 `.env`、不从 pi 的 `models.json` 找我们的钥匙、没有 `DEEPSEEK_BASE_URL`。
- **配置用 YAML，不用 JSON。** 它是人手写的文件，YAML 能写注释；`config.json`、`settings.json` 由程序写。
- **一个有类型的 `base.Config`，服务不调 `os.Getenv`。** 一个值从哪来，看 `Config` 的字段和 architecture.md 的表就够；测试改字段，不改进程的环境。
- **写错的值让服务端起不来，不悄悄用默认。** 悄悄落回默认时，主人以为改了的值其实没生效。
- **钥匙存在服务端的家目录（`settings.json`），不存在客户端。** 放弃了存在页面里、每次带给服务端：几台设备各一份，钥匙还经过客户端。服务端本来就是持有钥匙的一方。放弃了写回 `vibevalley.yaml`：那是人手写的文件，程序改它要保住注释和顺序；另一个文件也能单独设 0600。
- **设置比配置优先。** 主人在应用里最后填的那把最该算数；装好应用的人不知道还有一个配置文件。
- **每个用钥匙的地方现取，不在开机时拷一份。** 存了就用上，不用重启；管家起不来的失败也不会被缓存住。
- **保存时只查格式，不调对方验证。** 要花一次请求，Agora 的 Certificate 也没有便宜的验证办法；用时出错照旧说明白。
- **一份抹密钥的规则，日志和送出农场的文字共用。** 两份规则迟早不一样，漏掉的那份就是泄露的口子。

## 还没做的

现在没有提案。

## 怎么验证

- `base/config_test.go`：`TestConfigDefaultsThenFileThenEnvironment`（默认、文件、环境变量依次覆盖，逗号分隔的 `git_emails`）、`TestConfigRefusesWhatItCannotRead`（找不到的 `--config`、读不成数字的端口）、`TestServerIdentityCannotBeConfiguredOutsideLoopback`、`TestPullRequestConfiguration`、`TestDBPathFrom`。
- `setting/setting_test.go`：`TestSettingsKeysAreYoursAlone`（存进 `settings.json`、0600、设置比配置优先、页面看不到钥匙本身、清掉后露出配置的）、`TestSettingsRefuseWhatCannotBeRight`（格式不对什么都不存）、`TestSettingsVoiceKeepsOnlyWhatDiffers`、`TestSettingsVoiceVendorKeysAreHints`、`TestMemorySourcesKeepTheirKeyUntilCleared`、`TestMemorySourcesProblem`。
- `setting/concurrency_test.go`：`TestConcurrentPartialSavesKeepEveryField`、`TestVoiceConfigReadsProviderAndKeysFromOneRevision`；`setting/setting_rules_test.go` 和 `setting/rules_golden_test.go` 的 `TestRulesGolden`（`settingsProblem`、`voiceProblem`、`voiceOverrides`、`keyHint` 的黄金数据）。
- `base/redact_test.go`：`TestRedactTakesSecretsOutOfText`、`TestTheLogIsRedacted`。
- `pkg/agentcore/agentcore_test.go` 的 `TestGetApiKeyIsAskedBeforeEveryRequest`：中途换的钥匙下一次请求就用上。
