# 设置和配置

服务端的运行参数与凭据来自两类入口：
- **静态配置（`AppConfig`）**：开机时从默认值、`vibevalley.yaml` 和环境变量一次性加载（`internal/config/config.go`），运行期只读。
- **动态设置（`Setting`）**：用户在工作台 `/settings` 保存的密钥、语言、语音与记忆来源，以 `0600` 权限存于 `$VIBEVALLEY_HOME/settings.json`，保存即生效；明文凭据统一受 `internal/vault` 密钥信封保护。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `AppConfig` 的加载优先级、类型转换、开机校验与配置键定义 | 各农机自身的配置文件（如 `pi` 的 `models.json`） |
| `settings.json` 的原子读写、格式校验、密钥优先级（设置 > 配置）与末四位掩码 | 语音通话与记忆来源的业务实现（[语音](docs/subsystems/voice.md)、[记性](docs/subsystems/memory.md)） |
| `internal/vault` 密钥存储、脱敏边界与日志输出隔离 | 档案、技能书与农机并发设置（归[档案和农机](docs/subsystems/agent.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `internal/config/config.go` | `AppConfig` 加载优先级解析、环境变量与 `vibevalley.yaml` 校验、`work_root` / `home` / `repos` / `worktrees` / `pkm` 解析 |
| `internal/domain/setting/` | `setting.go`（原子读写、版本校验与状态汇总）、`catalog.go`（供应商连接与九种用途默认绑定目录） |
| `internal/vault/` | `secret.go`、`envelope.go`、`store.go`、`sqlstore.go`、`hostpolicy.go`、`proxy.go`：密钥加密封装、主密钥保护与脱敏出站隔离 |
| `apps/web/src/features/setting/` | 工作台设置页（`SettingsPage.tsx`、`SettingsForm.tsx`；跨功能共享的 `Readiness` 在 `apps/web/src/ui/domain/settings.tsx`） |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`setting.get`、`setting.validate`、`setting.update`）。

## 模型和不变量

### 静态配置（`AppConfig`）

- **优先级与命名**：
  - 优先级固定为 `环境变量 > vibevalley.yaml > defaults()`。
  - 环境变量名由配置键加 `VIBEVALLEY_` 前缀并将 `.` 换为 `_` 得出。
  - 额外支持直接读取 `DEEPSEEK_API_KEY`、`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`；家目录由 `VIBEVALLEY_HOME` 指定（默认 `~/.vibevalley`）。
- **错误配置拒绝开机**：配置文件解析失败或端口越界时直接报错退出，不静默回退默认值。
- **配置键清单**：

| 配置键 | 用途 | 默认值 |
|---|---|---|
| `work_root` | 空间：仓库（`repos/`）、工单 `worktrees/` 与笔记 `pkm/` 的根目录 | `~/vibevalley-dev` |
| `db` | SQLite 数据库路径（测试模式下支持 `:memory:`） | `$VIBEVALLEY_HOME/db/vibevalley.db` |
| `port` | 主 HTTP 与 `/mcp` 监听端口（仅绑定 `127.0.0.1`，`0` 为随机端口） | `8787` |
| `web` | 在 `/` 托管的前端静态产物目录（也可由 `--web` 指定） | 无 |
| `agent.model` / `agent.starters` | CLI 对话默认模型、新农场自动安装的内置模板 ID 列表（支持 `VIBEVALLEY_AGENT_STARTERS`） | 空 / 空 |
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

- **设置优先于配置，按需实时读取**：动态设置里的凭据与语音配置保存后立即生效，为空时回退 `AppConfig`。
- **暴露当前空间的实际路径**：`SettingsStatus.paths` 给出 `repos`、`worktrees` 与 `pkm` 的绝对路径，关于页逐行显示。
- **密钥隔离，不回传明文，损坏文件保留备份**：
  - 静态和动态密钥经 `internal/vault` 加密信封与协议 `Secret`（`packages/protocol/src/common/schema.ts`）双重隔离；`setting.get` 仅返回来源和末四位提示（`…xxxx`）。
  - `settings.json` 以 `0600` 权限原子改名写入；启动时若文件损坏，保留备份并从空设置启动。
- **每个功能的准备状态由服务端统一计算（`SettingsStatus.readiness`）**：
  - 服务端为 11 项功能（`orchestrator`、`image`、`understanding`、`speech`、`speakers`、`voiceDesign`、`transcription`、`dictation`、`live`、`vision`、`call`）给出 `{ ready: true }` 或 `{ ready: false, missing }`。
  - 页面钥匙集中在 `/settings/accounts`（「账号与钥匙」：DeepSeek、MOSS 连接与模型、声网），各功能页只绑账号模型并在顶部用 `Readiness` 指路；输入框 `/imagegen` 在生图未就绪时直接打开对应设置，不发给助手。
- **统一输出脱敏**：所有日志、Vault 代理出站与记忆同步输出均过滤凭据，防止私钥、`sk-*`、`ghp_*` 等密钥外泄。

## 怎么走

1. **启动加载**：`internal/config/config.go` 解析环境变量与 `vibevalley.yaml` 生成 `AppConfig`；`Setting` 读取并校验 `settings.json`。
2. **校验与保存**：前端实时调用 `setting.validate` 检查格式；保存时调用 `setting.update`（`can` 只有 `user`）原子写盘。

## 和谁打交道

- **全部服务端模块**：注入 `AppConfig` 读取静态参数。
- **助手、农机、语音与记性（`stack`、`agent`、`voice`、`memory`）**：读取最新密钥、语音与记忆来源。

### 供应商配置

Setting 保存供应商私有配置与用途绑定，普通设置与供应商修改并发加锁保护；`SettingsStatus.readiness` 给出各功能就绪与缺项。版本冲突、用途引用和密钥更新语义见 [AI 服务](docs/subsystems/provider.md)。

## 为什么这样

- **静态配置与动态设置分离**：`vibevalley.yaml` 只在启动时读一次，`settings.json` 在运行期由界面原子更新，互不覆盖且明文不进日志。
- **准备状态由服务端算一份，钥匙放一页**：连接启用、凭据与用途绑定规则只在服务端算一次，避免页面再推一份或等发出去才报错。
- **单一 `AppConfig` 入口与 `vault` 密钥信封**：禁止业务模块直接读取全局环境或绕过 `vault` 明文存储密钥。

## 怎么验证

- `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./internal/config/... ./internal/domain/setting/... ./internal/vault/...`：配置优先级、非法值拦截、密钥信封、代理隔离与脱敏掩码测试。
- `apps/web/test/settings.spec.ts`：设置页端到端测试。
