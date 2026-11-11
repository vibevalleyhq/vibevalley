# 用户和设备

一个服务端只有一个用户（`User`，`apps/server/src/modules/user/user.ts`）。在跑服务端的那台电脑上，来自本机的请求就是这个用户，不用登录；从别处来的只经[那道门](docs/subsystems/lan.md)进来，每台设备凭自己的一把钥匙。用户有名字（界面和提示词称呼他用它，能改）和一个密码（只在本机设）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 账号（`user_account`，至多一行）：名字、密码的 scrypt 哈希 | 门的监听、按来路放行、Cookie（[连接到本机](docs/subsystems/lan.md)） |
| 设备（`user_device`）：每台一把钥匙，来路 `paired` 或 `login`，最近一次来、收回、久不用作废 | 配对码与本机点头的状态机（`Lan`） |
| 凭密码登录：限次、锁定 | 帮工的会话令牌和 `/mcp`（[帮工](docs/subsystems/session.md)） |
| 凭确认码登录（命令行的 `vibevalley auth login`）：请求、同意、取钥匙 | 命令行把钥匙存在哪、带给谁（`apps/cli/README.md`，`@vibevalley/home` 的 `auth.json`） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/modules/user/user.ts` | 服务 `User`：账号、设备、钥匙的哈希比对、登录请求；收回时发 `revoked` 流 |
| `apps/server/src/gateway/http/handlers/user.ts` | `user.*` 接口；从门转来的请求头（`x-vibevalley-outside`、`x-vibevalley-lan-device`、`x-vibevalley-from`）读出 `Caller` |
| `packages/protocol/src/user/` | 形状和接口（`UserStatus`、`UserDevice`、`Approval…`、`deviceKeyCookie`） |
| `apps/web/src/features/user/` | `/login`、`/approve`、设置「设备」页里的名字和密码、等你同意的登录、全部设备；门外打开的页面先去哪（`entry.ts`） |
| `apps/cli/src/commands/auth.ts` | `vibevalley auth login|status|logout` |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`user.*`）。

## 模型和不变量

- **谁是用户**：没经门的请求是本机的，就是用户（`here`）。经门来的，带着一把有效的设备钥匙才是；配对来的只能调 `remote` 的接口，登录来的能调全部给用户的接口，只有 `user.password.set` 不行。
- **密码只在本机设**：`user.password.set` 对经门来的一律拒绝；至少 8 个字；scrypt（N=2¹⁵、r=8、p=1，加盐），存成 `scrypt:N:r:p:盐:哈希`，校验时照它记下的参数算。没设密码时没人能凭密码登录。
- **登录限次**：密码连错 5 次锁 60 秒；登录一个一个地校验，计数不会被并发绕过。
- **钥匙**：32 字节随机数，以 `vvk_` 开头，只发一次；库里只存 SHA-256，定长时间比对。名字是称呼，不拿来登录。
- **收回**：`user.device.delete`、`user.logout`、久不用作废都经 `revoke`：删行，发 `revoked`，门当场切断那台设备的连接。
- **久不用作废**：钥匙 90 天没用过（`last_seen`，没来过就按 `added_at`）就收回；开机时和之后每天清一遍，`byKey` 碰到时也当场拒绝。
- **确认码登录**（RFC 8628 的设备授权，语义照它，接口名用本仓库的）：
  - `user.approval.create` 不要钥匙：给一个 `XXXX-XXXX` 的确认码（20 个辅音字母，没有元音和易混的）和只有请求方知道的取件凭证（`claim`，只存哈希），记下请求方的地址和时间。
  - 用户在有钥匙的页面上对上码，`user.approval.answer` 同意或拒绝；同意页提醒只同意自己刚发起的。
  - 请求方凭取件凭证轮询 `user.approval.collect`：等着时给空的，比约定的间隔快就把间隔加 5 秒（`every`，即 `slow_down`），同意后给一把 `login` 来路的钥匙，只给一次。
  - 请求只在内存里，10 分钟过期，同时至多 5 个；设备在取钥匙时才建，同意了没人取的不留下设备。
- **门外不报名字**：`user.get` 对没钥匙的只说有没有密码，名字给空的。

## 怎么走

**浏览器从门外打开**：页面先问 `user.get`（钥匙在 HttpOnly 的 Cookie 里，页面读不到）；有钥匙就进农场，否则设过密码去 `/login?next=<原地址>`、没设去 `/pair`。登录后回到 `next`（只认本站的路径）。

**终端登录**：

1. `vibevalley auth login <服务端>` 先问 `user.get`：`here` 就说不用登录。
2. 否则 `user.approval.create`，打印确认码和 `<服务端>/approve?code=…`，在终端里时打开浏览器。
3. 用户在那一页（或设置「设备」页）点同意。
4. 命令行取到钥匙，连同服务端地址存进家目录的 `auth.json`（`0600`）；之后的命令默认连它，带着钥匙。

## 和谁打交道

- **门（`Lan`）**：用 `byKey` 认钥匙、用 `pair` 为配对来的设备签钥匙、订阅 `revoked` 断流；把请求方的地址写进 `x-vibevalley-from`。
- **命令行**：`askAt` 和事件流只把钥匙发给 `auth.json` 里的那个服务端（`apps/cli/README.md`）。

## 为什么这样

- **只有一个用户**：多用户要把「一个人」的假设从工单、提及、收件箱、记忆里拿掉；账号表按「用户」建，要团队时不用推倒。
- **本机不登录**：本机的进程本来就能读家目录里的一切，要登录挡不住什么，还让桌面版不再开箱即用。
- **对外只有一道门**：主监听里「来自本机」就是用户，不用分辨反向代理转来的请求；登录、配对、确认码都在门口按来路放行。
- **终端用确认码，不在终端里输密码**：和 `gh auth login` 一样，密码不碰终端，没有浏览器的机器把链接拿到手机上点也行；机器加入（[一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)）用同一套。
- **钥匙长期有效、能收回、久不用作废**：一个人自己用的服务端，用不着短期令牌加刷新令牌；丢了的设备在设备页收回，忘了的 90 天后自己作废。
- **放弃的路**：外接身份（GitHub、OIDC）要服务端能被回调、要配应用，一个人用太重，以后可作为 `came` 的另一种来路；passkey 要 https，等服务端真放到外网时再加。

## 怎么验证

- `apps/server/src/modules/user/user.test.ts`：钥匙的前缀、90 天作废（测试时钟）、请求方的地址、`slow_down`。
- `apps/server/src/gateway/lan/lan.test.ts`：经门的密码登录与锁定、Cookie、登录来的设备的放行、确认码登录与拒绝、请求上限。
- `apps/cli/src/commands/auth.test.ts`：`auth login` 等同意、照 `slow_down` 放慢、存钥匙、只带给那个服务端，`auth logout`。
- `apps/web/test/login.spec.ts`：本机设名字和密码，门外登录、回原处、退出，`/approve` 上同意一个终端。
