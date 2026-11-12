# AI 服务

用户在「设置 → AI 服务」保存供应商连接，为听写、生图、媒体理解、单人语音、多人对白、音色设计、长音频转写、MOSS Live 与独立 Vision 分别选择连接和模型；用途可以共用凭据，也可以使用不同账号。提交、预览、播放与保存由[媒体任务](docs/subsystems/media.md)提供，实时设备与会话见[语音](docs/subsystems/voice.md)。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 连接的名称、开关、凭据更新规则与默认用途 | 私有设置的原子保存（[设置](docs/subsystems/setting.md)） |
| MOSS 账号模型目录查询、用途模型校验和解析 | 录音设备、通话、中继与字幕（[语音](docs/subsystems/voice.md)） |
| 脱敏的公共状态、配置版本冲突与迟到查询结果 | 外部编码农机的登录、模型和凭据（[档案和农机](docs/subsystems/agent.md)） |

当前适配器为 MOSS；供应商目录（`apps/server/src/modules/provider/vendors.ts`）还列出 DeepSeek（助手的对话模型）与声网（通话线路），它们的钥匙仍在各自的设置里。用的地方只拿到不认供应商的账号：连接、revision、模型、Key 的指纹，和封着 Key 与 Provider 自己 `fetch` 的调用。自建兼容转写地址仍由听写设置配置，Provider 统一解析调用配置，不把任意地址当成 MOSS 官方连接。媒体任务由 Media 管；Provider 只选择账号和模型、查询目录与音色，不因保存设置自动发起生成或上传。

## 在哪

| 位置 | 职责 |
|---|---|
| `packages/provider/src/moss/models.ts` | 官方模型目录的认证请求、响应解码和安全错误分类 |
| `packages/provider/src/moss/image-models.ts` | 已适配的生图模型与快照；配置校验与生图协议共用唯一列表 |
| `packages/provider/src/base/transcription.ts` | 支持的 MOSS 转写模型、官方地址、唯一的兼容转写客户端 |
| `apps/server/src/modules/provider/` | `Provider` 服务、供应商目录 `vendors.ts`、连接变更规则与不认供应商的能力出口 |
| `apps/server/src/modules/setting/provider.ts` | `settings.json.providers` 的私有 Schema 与单一绑定规则 `bindingOf` |
| `packages/protocol/src/provider/` | 公共形状、Schema 和接口权限 |
| `apps/web/src/features/provider/` | `/settings/providers` 的连接与默认用途表单 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)。Provider 在 Platform 中、Setting 之后组装；后层 Voice 依赖 Provider，Provider 不依赖 Voice。

## 模型和不变量

- **配置只有一份**：`settings.json.providers` 保存 `revision`、`connections` 及九个独立用途：`dictation`、`image`、`understanding`、`speech`、`speakers`、`voiceDesign`、`transcription`、`live`、`vision`。连接有稳定 ID、名称、`adapter`、开关和私有 Key；最多 32 条。没有单独的 MOSS Key 文件、连接数据库或自动旧格式迁移。
- **修改整组配置时检查版本**：请求携带读取时的 `revision`，不一致就拒绝。Setting 的同一把锁覆盖普通设置与连接设置的读取、校验、写盘和内存替换；写盘失败不改变内存与版本。
- **凭据更新有三个动作**：省略 `key` 保留，非空字符串替换，`null` 清除。公共状态只显示来源与末四位提示；`settings.json` 里是普通字符串，读进内存就是 `Redacted`（启动配置的钥匙用 `Config.Redacted` 读），日志和编码里出不来，只有真正发请求的地方取出明文。
- **用途引用有效连接**：默认用途必须引用存在、已启用且有凭据的连接。删除、禁用或清除凭据时，用户应在同次修改中明确解除或改绑用途；服务端不自动换账号。
- **听写与实时线路分开**：每个用途绑定连接 ID 与完整模型 ID，包括 Live、Vision 的稳定版本或快照。更换听写模型不改变通话协议；长转写不借用输入框听写绑定。
- **生图用途固定模型版本**：`image` 保存连接 ID 与完整模型 ID；只接受已适配的稳定名称与官方快照。`Provider.image(request)` 按绑定的模型校验请求，在服务端返回连接 ID、配置 revision、模型的一次性快照和之后才跑的调用（Key 封在调用里），不回退到听写或 Live 账号；改绑与换 Key 不改变已经取得的快照。该内部方法不发网络请求，也不经 HTTP 暴露。
- **媒体理解独立绑定**：`understanding` 保存连接与模型，只接受 `moss-vl-1.0` 和官方 `2026-07-08` 快照；配置与协议共用 `moss/understanding-models.ts`。`Provider.understanding()` 返回一次性的账号快照（连接、revision、模型、Key 的指纹）和封着 Key 的调用（校验、提问、上传和删除文件），不借用其他用途的账号，不发请求。图片／视频理解的上传许可、任务与结果由 [Media](docs/subsystems/media.md) 管理，配置本身不会上传。
- **单人语音独立绑定**：`speech` 保存连接和模型；`moss/speech-models.ts` 是 Flash／Pro 稳定 ID 与官方快照的唯一列表。`Provider.speech()` 返回冻结的账号：连接、revision、模型、Key 的指纹，和封着 Key 的调用（校验、生成、异步任务、流式），不调用模型、不借用听写或 Live 账号。删除、停用或清 Key 必须先解绑；不把多人 TTS 放进单人模型选项。
- **多人对白、设计、长转写与 Vision 独立绑定**：各用途使用对应 `moss/*-models.ts` 的闭集，稳定 ID 与快照走相同协议，不靠字符串前缀猜能力。所有 11 个已适配稳定模型及其 11 个快照按用途路由；目录中的其他模型不自动成为可调用选项。克隆不另设模型用途，按请求明确指定连接与 revision，许可和输入限制见[媒体任务](docs/subsystems/media.md)。
- **音色查询限定账号与版本**：owner-only `provider.voice.list` 接受 connection、revision 和一组分页参数；请求前后都检查配置版本，换账号或换 Key 后不交付旧结果。只读一页，最多 150 条，offset 与 after 互斥；返回 ID、名称、创建秒数和下一页游标，不持久化，也不从列表猜音色就绪或模型兼容性。30 秒覆盖响应体，最多 1 MiB，不重试、不跟重定向，原始厂商错误不出服务端。
- **保存不推理、不探测**：配置完整只表示本机所需字段齐全，不代表账号有模型权限或真实调用已通过。模型查询由用户单独触发，不自动验证密钥或调用付费模型。
- **目录不是能力证明**：MOSS `GET /v1/models` 返回模型 ID 与归属方，没有能力字段。未知模型保留在列表，不依据名称推断用途。听写选项来自已适配的协议模型，而非目录前缀过滤。
- **目录查询绑定版本**：请求携带连接 ID 与配置版本。请求前或返回时版本不一致都拒绝；页面有未保存修改时不显示旧查询结果。查询结果不持久化，不显示跨版本的「验证通过」。
- **请求固定配置**：一次听写或已经建立的实时连接使用启动时取得的配置。改绑、轮换或解绑影响新请求，不撤回已经发送的录音、不自动挂断正在进行的通话；立即停通话应使用挂断。

## 怎么走

1. 用户添加 MOSS 连接，填名称和 Key；页面只保留当前未保存输入，成功后清空输入框。
2. 用户为所需用途选择连接与模型；选择「不使用」解除相应用途绑定。
3. Provider 校验整个候选配置，Setting 在锁内检查并原子保存，返回脱敏状态；发生版本冲突时页面保留草稿，用户可重新加载。
4. 用户查询模型时，Provider 取该版本的连接 Key，调用官方 `https://api.mosi.cn/v1/models`；没有可用凭据时在本机拒绝。
5. Voice 发起听写时向 Provider 要绑定好的听写：模型和封着地址、Key 的转写器（现有 Provider 转写实现），经 AI Core 调用，返回文本给原输入框。普通听写继续使用同步 multipart 和 `response_format=json`，不因选多说话人模型就自动启用分段、热词或流式。

目录请求不跟随重定向，不重试，不从环境中取 Key；15 秒超时覆盖响应体读取，结果最多 1 MiB、1000 条。认证、权限、限流、网络、超时、格式与上限错误各有提示，不将原始响应正文或带认证头的异常回传页面。协议依据见 [MOSS 模型列表](https://platform.moss.cn/docs/reference/models)与[音频转写](https://platform.moss.cn/docs/reference/transcriptions)。

## 为什么这样

- **Provider 管选择，Setting 管存储**：目录与用途被多种能力使用，不放进 Voice；私有配置留在现有原子文件中，避免两个存储所有者互相同步。
- **能力挂在单一 `Provider` 服务上，供应商作数据目录（`vendors.ts`）**：遵循一模块一服务，不为每个能力另起服务，也不在启动时定死供应商（绑定可在运行期切换）；调用方只拿不认供应商的 `Account` 快照（连接、revision、模型、Key 指纹和封着 `Provider` 自身 `fetch` 的调用）与能力自己的错误类型，Media 等模块不直接依赖 `@vibevalley/provider/moss/*`。
- **整组配置加版本检查**：连接数量有上限，用户可在一次保存中解绑再删除，引用校验不会出现中间失效状态；不为小目录引入多表事务或事件流。
- **不自动迁移散置凭据**：内部格式直接采用连接与用途，不保留两套 Key 的回退优先级。已有旧配置需由用户重新填写，开发和验收只使用隔离家目录。
- **目录查询不复用实时握手验证**：查询账号模型不需要建立语音会话；MOSS Live 的握手检查留在语音页，只验证绑定的实时连接。

## 怎么验证

- `packages/provider/src/moss/models.test.ts`：认证头、未知模型、重定向、响应上限、错误分类、超时、取消与凭据保护。
- `packages/provider/src/moss/speech.test.ts`、`audio-tasks.test.ts`、`voices.test.ts`：同步／异步提交、状态读取、分页、响应上限、取消、超时和脱敏；只证明协议，不证明生成产品或真实厂商可用。
- `apps/server/src/modules/provider/speech.test.ts`：四个单人语音模型的独立绑定、凭据轮换、不可变快照、引用保护与账号音色分页；配置变化后拒绝迟到结果。
- `apps/server/src/modules/provider/provider.test.ts`：凭据更新、用途引用、账号隔离、版本冲突、并发保存、迟到目录结果。
- `apps/server/src/modules/setting/setting.test.ts`：权限 `0600`、私有配置重启后保留、公共设置只暴露就绪状态。
- `apps/server/src/gateway/voice/voice.test.ts`、`http/moss.test.ts`：听写使用选择的模型与连接、MOSS Live 使用绑定密钥、自建转写与实时中继回归。
- `apps/web/test/providers.spec.ts`：真实隔离服务端上的表单保存、刷新、密钥脱敏、冲突草稿、用途解绑清除与空选项显示。
- `apps/web/test/a11y.spec.ts`：已绑定生图与理解模型的浅深主题无障碍检查、390px 窄屏与截图；模型与语音网络适配由不联网协议测试覆盖，不当作真实厂商效果验收。

