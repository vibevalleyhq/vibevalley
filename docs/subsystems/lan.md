# 连接到本机

「连接到本机」（`Lan`）是从外面进农场的唯一一道门。服务端在主回环监听 `127.0.0.1:8787` 之外按需开启这个监听 `0.0.0.0:8790`，认设备钥匙后转发给主监听：在本机点头配对来的设备只放标记了 `remote` 的接口与流，凭密码登录来的设备是用户本人，放全部给用户的接口，只有设密码不放。设备和钥匙归[用户](#和谁打交道)（`User`，`user/user.ts`）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 局域网监听的启停、状态持久化（`lan` 表）与上游请求转发 | 主监听本身（固定绑定 `127.0.0.1`，[设置和配置](docs/subsystems/setting.md)） |
| 一次性 10 位配对码生成、挂起等待本机批准，批准后由 `User` 签发设备钥匙 | 接口表 `endpoints` 中哪些操作标记 `remote`（[核心状态](docs/subsystems/core.md)、[能力表](docs/reference/capabilities.md)） |
| 门口认钥匙、按来路放行、登录时写 HttpOnly Cookie、设备被收回时断流 | 账号、密码、设备表 `user_device`（`User`）；浏览器 `/pair` 页面与手机壳钥匙串存储（[客户端](docs/subsystems/app.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/lan/lan.ts` | 局域网监听管理、配对状态机、请求守卫 `guard`、放行表 `remoteMay`、登录和退出时的 Cookie 与 HTTP/WS 代理转发 |
| `apps/server/src/user/user.ts`（`user_account`、`user_device` 表） | 用户的名字和密码（scrypt）、每台设备的 `key_hash`、来路 `came`（`paired`、`login`）、`added_at`、`last_seen` |
| `apps/web/src/features/lan/LanPage.tsx`、`PairPage.tsx` | 工作台「连接到本机」设置页与远端设备 `/pair` 配对页 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`lan.*`、`user.*`）。

## 模型和不变量

- **双监听隔离，按钥匙的来路放行**：
  - 主监听永远只绑 `127.0.0.1`；局域网监听开启时绑 `0.0.0.0:<lan.port>`。
  - 非 `/api/v1/` 下的静态页面 `GET`/`HEAD` 直接转发；`/mcp` 与 `/v1/chat/completions` 一律返回 `404`。
  - 不带钥匙只放 `lan.pair`、`user.login`、`user.get`；`user.get` 对没钥匙的只说有没有密码，不说名字。
  - 配对来的设备在 `/api/v1/` 下仅放行 `can` 含 `remote` 的接口、三条 SSE 流、附件与网页稿子 `GET` 以及 `/api/v1/rpc` WebSocket；管理「连接到本机」自身及修改本机设置、档案、技能、农机、连接器的接口均不含 `remote`，远端调用返回 `403`。
  - 登录来的设备放行 `/api/v1/` 下的一切，只有 `user.password.set` 返回 `403`：密码只在本机设。
  - 门给转发的每个请求加 `x-vibevalley-outside`，主监听凭它知道请求不是本机发的。
- **一次性配对码 + 本机点头**：
  - 配对码为 10 位随机码，有效期 2 分钟，输错 5 次即作废，同时只允许一台设备挂起等待。
  - 远端提交配对码后，必须有人在本机点击「让它进来」（`lan.pairing.answer`）才签发钥匙。
- **密码登录**：`user.login` 凭密码签一把 `login` 来路的钥匙；输错 5 次锁 60 秒。门把钥匙写进 HttpOnly、`SameSite=Strict` 的 Cookie（代理说是 `https` 时加 `Secure`），答复里也带着给命令行用；`user.logout` 收回当前这把并清掉 Cookie。
- **钥匙只发一次，库里只存 SHA-256**：
  - 配对或登录成功返回 32 字节 base64url 钥匙（浏览器存入 `vibevalley_device_key` cookie，手机壳存入系统钥匙串）。
  - 数据库仅存钥匙的 SHA-256 哈希并以定长时间比对。
  - 转发前剥离原 `Authorization`、`Cookie` 与伪造的设备头、外来头，注入已验证的 `x-vibevalley-lan-device` 与 `x-vibevalley-outside`。
- **收回设备或关闭监听当场掐断在途连接**：`User` 收回一台设备（`user.device.delete`、`lan.device.delete`、`user.logout`）时发出 `revoked`，门立即中止该设备名下登记的所有在途 HTTP/SSE 流与 WebSocket；关闭开关时全部中止。

## 怎么走

1. 用户在本机 `/settings/devices` 打开开关并点击「添加设备」（`lan.pairing.start`），生成配对链接与二维码。
2. 远端设备打开链接输入设备名调用 `POST /api/v1/lan/pair`，请求挂起等待本机批准（限时 2 分钟）。
3. 用户在本机点击批准，远端收到钥匙写入 Cookie 并跳转 `/` 使用农场。

凭密码登录：在本机设过密码（`user.password.set`）后，远端调 `POST /api/v1/user/login`（密码和这台设备叫什么），门写下 Cookie，之后的请求带着它。

## 和谁打交道

- **主监听**：`http/app.ts` 接收通过守卫的转发请求，根据 `x-vibevalley-outside` 和 `x-vibevalley-lan-device` 认出外来的请求和设备（`user.get`、`user.password.set`、`user.logout`、`lan.me.get`）。
- **用户（`User`）**：认钥匙（`byKey`）、签发配对的钥匙（`pair`）、收回设备（`revoked` 流）。
- **协议（`packages/protocol`）**：从 `endpoints` 构建 `remoteMay` 放行表，共用 `deviceKeyCookie` 名称。

## 为什么这样

- **独立外网监听 + 路径级白名单，不把主监听暴露到 `0.0.0.0`**：主监听挂着无需鉴权的帮工 `/mcp` 与全部管理接口；代理监听只放行 `remote` 子集，防止局域网攻击者修改农机命令或读取配置。
- **登录也走这道门，不让主监听自己对外**：服务端放到服务器上也只经这道门进来；主监听里「来自本机」就是用户，不用分辨反向代理转来的请求（[用户登录](.agents/notes/proposed/feature/2026-11-10-user-login.md)）。

## 怎么验证

- `apps/server/src/lan/lan.test.ts`、`apps/web/src/features/lan/device.test.ts`：配对审批、5 次错码作废、`remote` 权限拦截、密码登录与锁定、登录设备的放行和 Cookie、WebSocket 转发与移除设备断流测试。
- `apps/web/test/pair.spec.ts`：远端浏览器自动跳转 `/pair`、本机批准后进入工单页端到端测试。
