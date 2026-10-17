# Agent Note: 配置只有一份 YAML 和环境变量，由 viper 读

Status: implemented

## Problem

服务端的配置原来有六个来源，规则各不一样：

- 二十多个 `VIBEVALLEY_*` 环境变量，散在各个服务里用 `os.Getenv`、`base.EnvNumber` 读；`HOST`、`PORT` 没有前缀。
- `--env-file` 给的 `.env`，再是 `$VIBEVALLEY_HOME/.env`，都只补还没设的变量；解析规则照 Node 的 `util.parseEnv` 自己写了一份（`base/env.go`）。
- macOS 应用自己又读一遍家目录的 `.env`，合进环境再启动服务端（`app/lib/desktop/desktop.dart`）。
- DeepSeek 的钥匙还会去 pi 的 `~/.pi/agent/models.json` 里找，那里的值又可能是 `$NAME`，再回到环境变量。
- 应用里填的钥匙和语音设置在 `settings.json`，比环境变量优先。
- `cmd/migrate` 和 `cmd/vibevalley` 各有自己的一套参数和环境变量。

要知道一个值从哪来，得把这几条路都走一遍；测试也只能靠 `t.Setenv` 改进程的环境。

## Decision

- **两个来源**：一份 YAML（`$VIBEVALLEY_HOME/vibevalley.yaml`，或 `--config` 给的文件）和环境变量。由 [viper](https://github.com/spf13/viper) 读，优先级从低到高：默认值、YAML、环境变量。环境变量名是 `VIBEVALLEY_` 加上键名，点和横线换成下划线（`manager.model` → `VIBEVALLEY_MANAGER_MODEL`）。
- **家目录不在 YAML 里**：YAML 在家目录里，所以家目录只由 `VIBEVALLEY_HOME` 或默认值（`~/.vibevalley`）定。
- **三个外家的名字照旧**：`DEEPSEEK_API_KEY`、`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE` 是那几家自己的约定，绑定到 `deepseek.api_key`、`agora.app_id`、`agora.app_certificate`，YAML 里也能写。
- **一个有类型的 `base.Config`**：开机读一次（`base.LoadConfig`），经 fx 交给服务；服务只读它的字段，不调 `os.Getenv`。`base.Defaults()` 是全部默认值的唯一出处，零就是零：端口 0 是随便一个，`patrol.heartbeat_minutes` 0 是关掉。测试从 `base.ConfigAt(home, work, db)` 出发再改字段，不用 `t.Setenv`。
- **删掉的**：`.env` 的读取和解析（`base/env.go`、`--env-file`、家目录的 `.env`，Go 和 Dart 两边）；从 pi 的 `models.json` 找 DeepSeek 钥匙（`setting` 和 `pkg/agent` 两处），`pkg/agent.Deepseek` 只用调用方给的钥匙；`DEEPSEEK_BASE_URL`；`HOST`、`PORT` 改叫 `VIBEVALLEY_HOST`、`VIBEVALLEY_PORT`。三个命令（`cmd/server`、`cmd/migrate`、`cmd/vibevalley`）都用 `--config` 指一个别的文件。
- **还读 pi 的**：`runtime` 算 pi 那台农机的余额时，照 pi 自己的规则找它的钥匙（`piDeepseek`）；那是 pi 的配置，不是我们的。
- **`settings.json` 不是配置**：它是应用里填的钥匙和语音设置，照旧比 YAML 和环境变量优先，钥匙的来源（`KeySource`）只剩 `settings` 和 `config` 两种。
- smith 自己的 `OAR_*` 和各家农机的环境变量（`CODEX_HOME`……）不归这里管。

键的形状（默认值省略）：

```yaml
work_root: ~/vibevalley-work
db: ""                  # 空：家目录的 vibevalley.db；memory：内存
host: 127.0.0.1
port: 8787
manager: { runtime: "", model: "" }
agent: { model: "" }    # cmd/vibevalley 单独跑时
deepseek: { api_key: "" }
agora: { app_id: "", app_certificate: "" }
voice: { model: "", id: "", line: { port: 0, url: "" } }
lan: { port: 0 }
git_emails: []
tokei: ""
cny_per_usd: 0
patrol: { heartbeat_minutes: 0 }
schedule: { tick_ms: 0 }
worker: { stall_seconds: 0 }
project: { max_workers: 0 }
trajectory: { days: 0 }
chat: { notice_batch_ms: 0, retry_wake_ms: 0 }
```

键的清单和默认值在 [architecture.md](../../../../docs/architecture.md)「配置」。

## Alternatives considered

**只删 `.env`，环境变量照旧散着读。** 改得最少。没选：值从哪来还是要翻每个服务，测试还是改进程的环境。

**自己写 YAML 的读取，不用 viper。** 少一个依赖。没选：环境变量覆盖、默认值、嵌套键到变量名的映射都要自己写一遍，正是 viper 做的事。

**配置写成 JSON，和 `config.json`、`settings.json` 一样。** 没选：这是人手写的文件，YAML 能写注释；`config.json` 存的是档案和技能，由应用写。

## Consequences

- **改了名的环境变量**：`HOST`、`PORT` 和几个调节项（`VIBEVALLEY_HEARTBEAT_MINUTES` 变成 `VIBEVALLEY_PATROL_HEARTBEAT_MINUTES` 这类）旧名不再认；照[只有一份表结构，不认旧数据](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)不留兼容，家目录的 `.env` 要手动改写成 `vibevalley.yaml`。
- **viper 的依赖**：它带进来 `mapstructure`、`fsnotify` 等几个包；只用它的读取，不用热重载。
- **写错的值不再悄悄用默认**：读不成数字、不是端口，服务端开机就报错；以前它们落回默认值。
- **一处看全**：一个值从哪来，看 `base.Config` 的字段和 architecture.md 的表就够了。

## Verification

- `internal/base/config_test.go`：默认值、文件、环境变量依次覆盖；逗号分隔的 `git_emails`；找不到的 `--config` 文件和读不成数字的端口都报错。
- `server/internal` 和 `server/cmd` 里只剩 `base.LoadConfig` 读 `VIBEVALLEY_HOME`。
