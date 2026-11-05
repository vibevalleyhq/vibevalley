# 连接到本机

「连接到本机」（`Lan`）允许局域网内的手机或另一台电脑访问本机农场。服务端在主回环监听 `127.0.0.1:8787` 之外按需开启局域网监听 `0.0.0.0:8790`，仅向经主人本机批准配对的设备转发标记了 `remote` 权限的接口与流。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 局域网监听的启停、状态持久化（`lan` 表）与上游请求转发 | 主监听本身（固定绑定 `127.0.0.1`，[设置和配置](docs/subsystems/setting.md)） |
| 一次性 10 位配对码生成、挂起等待本机批准、签发 32 字节设备钥匙 | 接口表 `endpoints` 中哪些操作标记 `remote`（[核心状态](docs/subsystems/core.md)、[能力表](docs/reference/capabilities.md)） |
| 配对设备管理（`lan_device` 表存 SHA-256）、鉴权与移除设备时断流 | 浏览器 `/pair` 页面与手机壳钥匙串存储（[客户端](docs/subsystems/app.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/lan/lan.ts` | 局域网监听管理、配对状态机、请求守卫 `guard`、放行表 `remoteMay` 与 HTTP/WS 代理转发 |
| `apps/server/src/infra/db.ts`（`lan`、`lan_device` 表） | 持久化局域网开关状态与已配对设备的 `key_hash`、`paired_at`、`last_seen` |
| `apps/web/src/features/lan/LanPage.tsx`、`PairPage.tsx` | 工作台「连接到本机」设置页与远端设备 `/pair` 配对页 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`lan.*`）。

## 模型和不变量

- **双监听隔离，按 `can` 含 `remote` 白名单放行**：
  - 主监听永远只绑 `127.0.0.1`；局域网监听开启时绑 `0.0.0.0:<lan.port>`。
  - 非 `/api/v1/` 下的静态页面 `GET`/`HEAD` 直接转发；`/mcp` 与 `/v1/chat/completions` 一律返回 `404`。
  - `/api/v1/` 下仅放行 `can` 含 `remote` 的接口、三条 SSE 流、附件与网页稿子 `GET` 以及 `/api/v1/rpc` WebSocket。
  - 管理「连接到本机」自身及修改本机设置、档案、技能、农机、连接器的接口均不含 `remote`，远端调用返回 `403`。
- **一次性配对码 + 本机主人点头**：
  - 配对码为 10 位随机码，有效期 2 分钟，输错 5 次即作废，同时只允许一台设备挂起等待。
  - 远端提交配对码后，必须由主人在本机点击「让它进来」（`lan.pairing.answer`）才签发钥匙。
- **钥匙只发一次，库里只存 SHA-256**：
  - 配对成功返回 32 字节 base64url 钥匙（浏览器存入 `vibevalley_lan_key` cookie，手机壳存入系统钥匙串）。
  - 数据库仅存钥匙的 SHA-256 哈希并以定长时间比对。
  - 转发前剥离原 `Authorization`、`Cookie` 与伪造设备头，注入已验证的 `x-vibevalley-lan-device` 头。
- **移除设备或关闭监听当场掐断在途连接**：删除设备或关闭开关时，立即中止该设备名下登记的所有在途 HTTP/SSE 流与 WebSocket。

## 怎么走

1. 主人在本机 `/settings/devices` 打开开关并点击「添加设备」（`lan.pairing.start`），生成配对链接与二维码。
2. 远端设备打开链接输入设备名调用 `POST /api/v1/lan/pair`，请求挂起等待本机批准（限时 2 分钟）。
3. 主人在本机点击批准，远端收到钥匙写入 Cookie 并跳转 `/` 使用农场。

## 和谁打交道

- **主监听**：`http/app.ts` 接收通过守卫的转发请求，根据 `x-vibevalley-lan-device` 识别设备（供 `lan.me.get` 查询）。
- **协议（`packages/protocol`）**：从 `endpoints` 构建 `remoteMay` 放行表，共用 `lanKeyCookie` 名称。

## 为什么这样

- **独立外网监听 + 路径级白名单，不把主监听暴露到 `0.0.0.0`**：主监听挂着无需鉴权的帮工 `/mcp` 与全部管理接口；代理监听只放行 `remote` 子集，防止局域网攻击者修改农机命令或读取配置。

## 怎么验证

- `apps/server/src/lan/lan.test.ts`、`apps/web/src/features/lan/device.test.ts`：配对审批、5 次错码作废、`remote` 权限拦截、WebSocket 转发与移除设备断流测试。
- `apps/web/test/pair.spec.ts`：远端浏览器自动跳转 `/pair`、本机批准后进入工单页端到端测试。
