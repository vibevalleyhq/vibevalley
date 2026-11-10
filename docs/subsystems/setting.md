# 设置和配置

服务端的运行参数与凭据来自两类入口：
- **静态配置（`ServerConfig`）**：开机时从默认值、`vibevalley.yaml` 和环境变量一次性加载，运行期只读。
- **动态设置（`Setting`）**：用户在工作台 `/settings` 保存的密钥、语言、语音与记忆来源，以 `0600` 权限存于 `$VIBEVALLEY_HOME/settings.json`，保存即生效。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `ServerConfig` 的加载优先级、类型转换、开机校验与配置键定义 | 各农机自身的配置文件（如 `pi` 的 `models.json`） |
| `settings.json` 的原子读写、格式校验、密钥优先级（设置 > 配置）与末四位掩码 | 语音通话与记忆来源的业务实现（[语音](docs/subsystems/voice.md)、[记性](docs/subsystems/memory.md)） |
| 全局日志与出站文本的密钥脱敏（`base/redact.ts`） | 档案、技能书与农机并发设置（存于 `config.json`，归[档案和农机](docs/subsystems/agent.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/infra/config.ts` | `ServerConfig`、`defaults`、`loadConfig`、`serverAddress`、`dbDir`、`reposDir`、`worktreesDir`、`pkmDir` |
| `apps/server/src/provider/provider.ts` | [AI 服务](docs/subsystems/provider.md)：连接与用途规则、模型目录；私有配置仍由 Setting 保存 |
| `apps/server/src/setting/` | `setting.ts`、`saving.ts`、`keys.ts`、`memorySources.ts`、`voice.ts` |
| `apps/server/src/base/redact.ts` | 日志与出站文本密钥脱敏（`redact`、`redactOutput`） |
| `apps/web/src/features/setting/` | 工作台设置页（`SettingsPage.tsx`、`SettingsForm.tsx`） |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`setting.get`、`setting.validate`、`setting.update`）。

## 模型和不变量

### 静态配置（`ServerConfig`）

- **优先级与命名**：
  - 优先级固定为 `环境变量 > vibevalley.yaml > defaults()`。
  - 环境变量名由配置键加 `VIBEVALLEY_` 前缀并将 `.` 换为 `_` 得出。
  - 额外支持直接读取 `DEEPSEEK_API_KEY`、`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`；家目录由 `VIBEVALLEY_HOME` 指定（默认 `~/.vibevalley`）。
- **错误配置拒绝开机**：配置文件不存在、数字解析失败或端口越界时，`loadConfig` 直接报错退出，不静默回退默认值。
- **配置键清单**：

| 配置键 | 用途 | 默认值 |
|---|---|---|
| `work_root` | 空间：仓库（`repos/`）、工单 `worktrees/` 与笔记 `pkm/` 的根目录 | `~/vibevalley-dev` |
| `db` | PGlite 的数据目录（设为 `memory` 则使用内存库；配了 `database.url` 时不用） | `$VIBEVALLEY_HOME/db` |
| `database.url` | 一个 Postgres（`postgres://…`）：库放在那里；可能带密码，按密钥读 | 空：用 PGlite |
| `port` | 主 HTTP 与 `/mcp` 监听端口（仅绑定 `127.0.0.1`，`0` 为随机端口） | `8787` |
| `web` | 在 `/` 托管的前端静态产物目录（也可由 `--web` 指定） | 无 |
| `agent.model` / `agent.starters` | CLI 对话默认模型、新农场自动安装的内置模板 ID 列表 | 空 / 空 |
| `deepseek.api_key` | DeepSeek API Key（`DEEPSEEK_API_KEY`） | 空 |
| `agora.app_id` / `agora.app_certificate` | 声网 RTC 凭据（`AGORA_APP_ID` / `AGORA_APP_CERTIFICATE`） | 空 |
| `voice.id` / `voice.line.port` / `voice.line.url` | 默认音色、语音线路端口与固定公网隧道地址 | 默认音色 / `8788` / 空 |
| `lan.port` | 「连接到本机」局域网监听端口 | `8790` |
| `git_emails` / `tokei` | 计入用户经验的额外 git 邮箱列表、tokei 命令路径 | 空 / `tokei` |
| `cny_per_usd` | 美元单价折算人民币汇率 | `7.2` |
| `patrol.heartbeat_minutes` / `cron.tick_ms` | Inbox 巡查间隔（分钟，`0` 关闭）、定时任务检查间隔（毫秒） | `10` / `20000` |
| `session.stall_seconds` / `session.trajectory_days` | 帮工静默告警秒数、离场后轨迹保留天数（`0` 永久保留） | `240` / `30` |
| `repo.max_sessions` / `repo.check_timeout_seconds` | 单仓库并发帮工上限、`.vibevalley/check` 超时秒数 | `3` / `1200` |
| `github.pr_repos` / `github.pr_poll_seconds` | 完成时走 PR 的仓库名列表、开放 PR 轮询间隔秒数 | `[]` / `180` |
| `chat.notice_batch_ms` / `chat.retry_wake_ms` | 忙时提示合并毫秒数、唤醒失败重试间隔毫秒数 | `3000` / `3000` |
| `otlp.url` / `pkm.root` | OpenTelemetry 收集器地址、笔记库根目录（空：`<work_root>/pkm`） | 空 / 空 |

### 动态设置（`Setting`）与脱敏

- **设置优先于配置，按需实时读取**：`deepseekApiKey()` 与 `agora()` 优先取 `settings.json`，为空时回退 `ServerConfig`，保存后立即生效。
- **暴露当前空间的实际路径**：`SettingsStatus.paths` 给出 `repos`、`worktrees` 与 `pkm` 的绝对路径，关于页逐行显示。
- **密钥不出服务端，损坏文件保留备份**：
  - `setting.get` 对密钥仅返回来源 `settings`/`config` 与末四位提示（`…xxxx`）。
  - `settings.json` 以 `0600` 权限经临时文件原子改名写入；启动时若文件损坏，改名为 `settings.json.unreadable-<毫秒>` 备份并从空设置启动。
- **语音设置只存差异**：`settings.json` 的 `voice` 字段仅保存与 `defaultVoice()` 不同的覆盖项。
- **统一输出脱敏（`redact`）**：所有日志与外部记忆出站文本均经 `base/redact.ts` 将私钥、`sk-*`、`ghp_*`、JWT、`hb_*` 及敏感键值对替换为 `[redacted]`。

## 怎么走

1. **启动加载**：`loadConfig` 解析环境变量与 `vibevalley.yaml` 生成 `ServerConfig`；`Setting` 读取并校验 `settings.json`。
2. **校验与保存**：前端实时调用 `setting.validate` 检查格式；保存时调用 `setting.update`（仅本机 `owner` 可调）原子写盘。

## 和谁打交道

- **全部服务端模块**：注入 `ServerConfig` 读取静态参数。
- **管家、农机、语音与记性（`orchestrator`、`runtime`、`voice`、`memory`）**：注入 `Setting` 实时获取最新密钥、语音与记忆来源。

### 供应商配置

Setting 在 `settings.json.providers` 保存供应商私有配置，普通设置与供应商修改共用一把锁，完整覆盖读、写盘与内存替换。`SettingsStatus` 只给出 `dictationReady`、`mossReady` 等本机配置状态；连接及脱敏凭据经 Provider 接口读取。版本冲突、用途引用和密钥更新语义见 [AI 服务](docs/subsystems/provider.md)。

## 为什么这样

- **静态配置与动态设置分离**：`vibevalley.yaml` 供开发者手写并保留注释；`settings.json` 由程序原子写入图形界面保存的密钥与偏好，互不覆盖。
- **单一 `ServerConfig` 入口与统一 `redact` 出口**：禁止业务模块直接读 `process.env`；日志与外部记忆共用同一套脱敏规则，防止密钥外泄。

## 怎么验证

- `apps/server/src/infra/config.test.ts`、`apps/server/src/setting/*.test.ts`：配置优先级、非法值拦截、密钥掩码测试。
- `apps/server/src/base/base.test.ts`、`apps/web/test/settings.spec.ts`：密钥脱敏与设置页端到端测试。
