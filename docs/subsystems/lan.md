# 连接到本机

「连接到本机」（`Lan`）是从外面进农场的唯一一道门。服务端在主回环监听 `127.0.0.1:8787` 之外按需开启这个监听 `0.0.0.0:8790`，认设备钥匙后转发给主监听：在本机点头配对来的设备只放标记了 `remote` 的接口与流，凭密码或确认码登录来的设备是用户本人，放全部给用户的接口，只有设密码不放。账号、设备和钥匙归[用户和设备](docs/subsystems/user.md)（`User`）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 门的监听的启停、状态持久化（`lan` 表）与上游请求转发 | 主监听本身（固定绑定 `127.0.0.1`，[设置和配置](docs/subsystems/setting.md)） |
| 一次性 10 位配对码、挂起等待本机批准，批准后由 `User` 签发钥匙 | 接口表 `endpoints` 中哪些操作标记 `remote`（[核心状态](docs/subsystems/core.md)、[能力表](docs/reference/capabilities.md)） |
| 门口认钥匙、按来路放行、登录和退出时写清 HttpOnly 的 Cookie、设备被收回时断流 | 账号、密码、设备、确认码登录（[用户和设备](docs/subsystems/user.md)）；浏览器 `/pair` 页面与手机壳钥匙串存储（[客户端](docs/subsystems/app.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/gateway/lan/lan.ts` | 门的监听、配对状态机、请求守卫 `guard`、放行表 `remoteMay`、登录和退出时的 Cookie、HTTP/WS 代理转发 |
| `apps/web/src/features/lan/LanPage.tsx`、`PairPage.tsx` | 设置「设备」页里「连接到本机」的卡片与远端设备的 `/pair` 配对页 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`lan.*`）。

## 模型和不变量

- **双监听隔离，按钥匙的来路放行**：
  - 主监听永远只绑 `127.0.0.1`；门开启时绑 `0.0.0.0:<lan.port>`。
  - 非 `/api/v1/` 下的静态页面 `GET`/`HEAD` 直接转发；`/mcp` 与 `/v1/chat/completions` 一律返回 `404`。
  - 不带钥匙只放 `lan.pair`、`user.login`、`user.get`、`user.approval.create`、`user.approval.collect`。
  - 配对来的设备在 `/api/v1/` 下仅放行 `can` 含 `remote` 的接口、三条 SSE 流、附件与网页 Artifact `GET` 以及订阅流 `GET /api/v1/subscribe/<名字>`；这道门不接 WebSocket 升级（语音线路只给本机的页面）；管理「连接到本机」自身及修改本机设置、档案、技能、农机、连接器的接口均不含 `remote`，远端调用返回 `403`。
  - 登录来的设备放行 `/api/v1/` 下的一切，只有 `user.password.set` 返回 `403`。
- **一次性配对码 + 本机点头**：
  - 配对码为 10 位随机码，有效期 2 分钟，输错 5 次即作废，同时只允许一台设备挂起等待。
  - 远端提交配对码后，必须有人在本机点击「让它进来」（`lan.pairing.answer`）才签发钥匙。
- **转发前换掉来路**：剥离原 `Authorization`、`Cookie` 与伪造的门的头，注入已验证的 `x-vibevalley-lan-device`（哪台设备）、`x-vibevalley-outside`（经门来的）和 `x-vibevalley-from`（对端地址；对端是本机的反向代理时取 `X-Forwarded-For` 的第一跳）。
- **Cookie**：`user.login` 的答复由门整个读完，把钥匙写进 HttpOnly、`SameSite=Strict` 的 `vibevalley_device_key`（代理说是 `https` 时加 `Secure`）；`user.logout` 清掉它。配对来的浏览器自己把钥匙写进同一个 Cookie。
- **收回设备或关闭监听当场掐断在途连接**：`User` 收回一台设备时发出 `revoked`，门立即中止该设备名下登记的所有在途 HTTP 请求和 SSE 流；关闭开关时全部中止。退出的请求不登记在设备的连接里，否则会把自己切断。

## 怎么走

1. 用户在本机 `/settings/devices` 打开开关并点击「添加设备」（`lan.pairing.start`），生成配对链接与二维码。
2. 远端设备打开链接输入设备名调用 `POST /api/v1/lan/pair`，请求挂起等待本机批准（限时 2 分钟）。
3. 用户在本机点击批准，远端收到钥匙写入 Cookie 并跳转 `/` 使用农场。

凭密码或确认码登录的流程见[用户和设备](docs/subsystems/user.md#怎么走)。

## 和谁打交道

- **主监听**：`http/app.ts` 接收通过守卫的转发请求；`user.*` 的处理凭门注入的头认出外来的请求、设备和地址。
- **用户（`User`）**：认钥匙（`byKey`）、签发配对的钥匙（`pair`）、收回设备（`revoked` 流）。
- **协议（`packages/protocol`）**：从 `endpoints` 构建 `remoteMay` 放行表，共用 `deviceKeyCookie` 名称。

## 为什么这样

- **独立外网监听 + 路径级白名单，不把主监听暴露到 `0.0.0.0`**：主监听挂着无需鉴权的帮工 `/mcp` 与全部管理接口；代理监听只放行 `remote` 子集，防止局域网攻击者修改农机命令或读取配置。
- **登录也走这道门，不让主监听自己对外**：服务端放到服务器上也只经这道门进来；主监听里「来自本机」就是用户，不用分辨反向代理转来的请求。门放到外网时前面要有 TLS（反向代理）。

## 怎么验证

- `apps/server/src/gateway/lan/lan.test.ts`、`apps/web/src/features/lan/device.test.ts`：配对审批、5 次错码作废、`remote` 权限拦截、登录来的设备的放行和 Cookie、订阅流转发与收回设备断流。
- `apps/web/test/pair.spec.ts`：远端浏览器自动跳转 `/pair`、本机批准后进入工单页。
