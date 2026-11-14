# AI 服务

用户在「设置 → AI 服务」保存供应商连接（现在只有 MOSS），为每个用途（听写、生图、媒体理解、单人语音、多人对白、音色设计、长音频转写、Live、Vision）选连接和模型；用途可以共用一个账号，也可以各用各的。提交、预览、保存由[媒体任务](docs/subsystems/media.md)做；Rust 服务端现在只用到生图和单人语音两个用途（其余用途能存、能查模型，没人调用，见[语音](docs/subsystems/voice.md)）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 连接的名称、开关、钥匙更新规则与默认用途 | `settings.json` 的读写与锁（[设置](docs/subsystems/setting.md)） |
| MOSS 账号的模型目录和音色查询、用途模型校验 | 生成、上传和下载（[媒体任务](docs/subsystems/media.md)） |
| 脱敏的公共状态、配置版本冲突 | 编码农机的登录、模型和凭据（[档案和农机](docs/subsystems/agent.md)） |

DeepSeek（助手的对话模型）的钥匙在设置里，不是连接。

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-server/src/modules/provider.rs` | `Provider`：`status`、`update`（`connections_over` 把更新叠到当前配置上，不对就拒）、`models`、`voices`；`Use` 是九个用途的闭集，各带自己的模型列表；`Providers::account` 给用的地方一个账号（连接、revision、模型、钥匙） |
| `crates/vibevalley-server/src/modules/media/vendor.rs` | MOSS 的 HTTP 调用（生图、语音、文件、理解），响应进门即解码 |
| `packages/protocol/src/provider/` | 公共形状和接口（Rust 类型由它生成） |
| `apps/mac/ui/vv/web/features/provider/` | `/settings/providers` 的连接与默认用途表单 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`provider.*`）。

## 模型和不变量

- **配置只有一份**：`settings.json` 的 `providers` 存 `revision`、`connections` 和九个用途的绑定；读进来是 `Providers`/`Connection` 结构体，钥匙是 `Secret`（打印只出末四位）。连接有稳定 ID、名称、`adapter`、开关和钥匙，最多 32 条。
- **整组修改检查版本**：请求带读到的 `revision`，对不上就拒；写盘失败不改内存和版本。
- **钥匙更新三个动作**：省略 `key` 保留，非空字符串替换，`null` 清除。
- **用途引用有效连接**：绑定的连接必须存在、开着、有钥匙；删、停、清钥匙时用户要在同一次修改里改绑，服务端不自动换账号。
- **用途的模型是闭集**：每个用途只接受 `Use::models` 里的稳定 ID 和官方快照，不靠前缀猜能力；目录里的其他模型不自动成为选项。
- **一次任务冻结账号**：媒体任务开始时取账号，之后改绑或换钥匙不影响已开始的任务。
- **查询绑定版本**：模型目录和音色查询带连接 ID 与 revision，前后版本不一致都拒；结果不持久化，也不代表账号真有权限。
- **保存不推理、不探测**：配置完整只表示字段齐全；不自动验证钥匙或调付费模型。

## 为什么这样

- **Provider 管选择，Setting 管存储**：用途被多种能力共用；配置留在一个原子写的文件里，不设第二个存储。
- **整组配置加版本**：用户能在一次保存里先解绑再删除，引用校验不会有中间失效状态。

## 怎么验证

- `crates/vibevalley-server/tests/provider.rs`：不对的连接修改被拒、没配好的连接不当默认、保留钥匙、跟着 revision 走。
- `crates/vibevalley-server/tests/setting.rs`：语音厂商的钥匙只给提示，就绪状态跟着连接走。
- `apps/web/test/providers.spec.ts`：隔离服务端上的表单保存、刷新、钥匙脱敏、冲突草稿与解绑。
