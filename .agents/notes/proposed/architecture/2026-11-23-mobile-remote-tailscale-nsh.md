# Agent Note: Tailscale 与 nsh 原生移动远程控制（iOS 优先，Android 就绪）

Status: proposed

## Problem

VibeValley 当前只允许在本机回环地址（`127.0.0.1`）访问服务端，用户离开 Mac 后无法审批执行会话的权限请求、回答收件箱里的提问、在频道里给主助手发消息，也无法查看运行中的任务和轨迹。与此同时，[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)已明确放弃 Web 前端与独立多端适配框架，如果重新引入自建公网中继或单独维护一套移动前端技术栈，会显著扩大安全攻击面并破坏 `crates/protocol` 与 `nsh` 的单一事实源。

## Proposal

基于 **Tailscale 私有组网 + `nsh` 原生移动外壳** 建设远程控制体系（iOS 优先落地，协议、传输层与移动端外壳天然兼容 Android）：Mac 端新增默认关闭的受认证远程 HTTP 监听门，手机端使用独立 `apps/mobile` 4 标签原生应用通过 `HttpRemoteTransport` 订阅核心切片并调用受权限门控的 `/api/v1` 端点。

### 1. 网络与绑定边界（默认关闭）

- **默认关闭**：`vibevalley-server` 启动后默认只保留本机回环监听，除非用户在本机显式调用 `remote.enable`（仅限 `Caller::User`），不开放任何非回环端口。
- **地址约束**：远程监听门优先自动探测本机 Tailscale IPv4（CGNAT 网段 `100.64.0.0/10`）并绑定该地址；开发与 iOS Simulator 调试场景允许显式绑定回环地址（`127.0.0.1`），拒绝绑定 `0.0.0.0` 或公网地址。
- **TLS 与组网信任边界**：跨设备传输依托 Tailscale WireGuard 点对点加密隧道，不暴露公网端口、不引入中心化云中继。

### 2. 配对、持久令牌与调用身份

- **一次性配对码与深链**：本机用户调用 `remote.pair.create` 生成 5 分钟有效、单次使用的高熵配对码，返回 `RemotePairCode`（含 `vibevalley://pair?url=<encoded>&code=<code>` 深链，供 Mac 设置页经 `host.qr` 渲染二维码，或手机手动输入）。
- **令牌交换与哈希落盘**：手机调用 `remote.pair.exchange` 提交配对码、设备名与平台（`RemotePlatform`：`ios` / `android` / `other`），服务端校验后立刻作废配对码，签发 `vv_dev_*` 前缀的持久 Bearer 令牌；数据库仅保存该令牌的 SHA-256 哈希与设备元数据（`RemoteDeviceSummary` 永不含 `token_hash`），并受失败速率限制保护。
- **最小权限调用上下文**：远程请求经 Bearer 令牌认证后，服务端构造 `Caller::Remote` 与 `CallerPrincipal::RemoteDevice { device_id, scope }` 并更新 `last_seen_at`；被 `remote.device.revoke` 撤销的设备立即返回 `401`（`BizCode::Unauthorized`）。
- **端点权限划分**：
  - 远程设备可调用的移动端分拣与回复能力：`channel.*` 读写回复、`session.list` / `session.get` / `session.event.list` / `session.send` / `session.stop` / `session.respondPermission` / `session.respondInteraction`、`issue.list` / `issue.get` / `issue.create` / `issue.status.update` / `issue.comment.create` / `issue.review`、`remote.pair.exchange`、`remote.whoami`，以及切片与实时流 `GET /api/v1/slice/{name}`、`GET /api/v1/live`、`GET /api/v1/subscribe/{name}`。
  - 仅限本机 `Caller::User` 的高危管理端点：`remote.status`、`remote.enable`、`remote.disable`、`remote.pair.create`、`remote.device.revoke`、`setting.update`、`debug.*`、`agent.create` / `agent.update` / `agent.delete`、`provider.*`、`connector.login` / `connector.verify` / `connector.logout` / `connector.channel.set`、`repo.pr.submit`。

### 3. 契约、纯 TS 远程传输层与 5 切片续读

- **强类型契约**：在 [remote.rs](crates/protocol/src/contract/remote.rs) 与 [endpoints.rs](crates/protocol/src/contract/endpoints.rs) 定义 9 个 `Remote*` 线缆类型与 7 个 `remote.*` 端点，生成 `packages/protocol/src/remote/shapes.gen.ts`，在 `packages/protocol/src/remote/{schema,api}.ts` 编写 Zod 边界解码器与端点表，并同步生成 `client.ts` 与 [capabilities.md](docs/reference/capabilities.md)。
- **零平台依赖的 `HttpRemoteTransport`**：通过 `@vibevalley/protocol/remote`（`packages/protocol/src/remote/transport.ts`）导出纯 Web Fetch + `AbortController` + `ReadableStream` + `TextDecoder` 实现，不引入 `nsh` 或 Node 专用依赖，使 Linux CI、macOS、iOS 与 Android 运行同一套传输代码：
  - `call(op, payload)`：`POST /api/v1/<op>`，附带 `Authorization: Bearer <token>` 与 `X-VibeValley-Client: remote`，遇 `401` 通知连接状态转为 `unauthorized`。
  - `slice(kind, listener)`：以 SSE 消费 5 个核心域切片（`board`、`sessions`、`collab`、`inbox`、`ops`），按块增量解码并记录事件序号；断线后以指数退避（`1s`–`8s`）自动重连并附带 `Last-Event-ID: <seq>` 实现无遗漏续读；遇 `401` / `403` 立即停止重连。
  - `live(listener)` 与 `subscribe(name, payload, on, ended)`：复用同一 SSE 增量解码器，支持取消订阅与 `close()` 一键中止全部在途请求与计时器，不留悬挂 Promise。
  - 辅助原语：`parsePairUrl`（严格校验 `vibevalley://pair?url=...&code=...` 且仅允许 `http:` / `https:`）、`normalizeServerUrl` 与 `pairWithServer`。

### 4. 跨载体图标与独立 `apps/mobile` 4 标签原生外壳

- **97 枚 reicons 单源矢量回退**：由 `scripts/gen/icons.ts` 从 [icon.rs](crates/rich/src/icon.rs) 生成矢量路径表，在无 GPUI 原生 `VvIcon` 的载体（`apps/mobile` 及非 GPUI 宿主回退）中用 `<Canvas>` + `Path2D` 按 24×24 坐标系精确绘制填充、描边、线帽、拐角、`evenodd` 与透明度，保持桌面与移动端视觉一致。
- **令牌同步**：`scripts/gen/tokens.ts` 从 [tokens.json](design/tokens.json) 同步写出 `apps/mobile/design/theme.json` 与 `apps/mobile/nsh.json` 的 Tailwind 令牌配置，移动端与桌面工作台共用田间工作台设计系统。
- **`apps/mobile` 原生外壳**：独立 `nsh` 移动端应用，通过 `nsh/mobile` 接入原生 `TabBar`（4 个一级标签：`收件箱`、`频道`、`会话`、`任务`）、`Haptics` 触觉反馈、`Storage` 凭据持久化与 `UrlScheme`（接收 `vibevalley://pair` 深链自动填充配对表单）。首期以 iOS Simulator 与真机为验收基线，所有 `nsh/mobile` API 均面向 Android 兼容层设计。

## Alternatives considered

**自建公网中继或 Cloudflare Tunnel 暴露本机 HTTP 服务**：公网中继需要账号体系、云端运维与端到端加密协议设计，且把本机编码工作台暴露到公网边缘显著抬高风险。Tailscale 已为开发者提供零配置点对点 WireGuard 私有网络，本机只需在 `100.64.0.0/10` 监听并校验设备 Bearer 令牌即可满足远程操控诉求。

**复用 WebView / PWA 浏览器页面替代原生移动外壳**：VibeValley 已移除旧 Web 前端与多套样式管道，重新维护浏览器打包与移动端浏览器兼容层会产生双源漂移；使用 `nsh` 原生移动外壳可直接复用 `@vibevalley/protocol`、`@vibevalley/i18n` 与 [tokens.json](design/tokens.json)，同时获得原生 `TabBar`、`Haptics`、`UrlScheme` 与流畅列表渲染。

**在移动端复用桌面 GPUI 像素农场与工作区全量界面**：手机屏幕不适合承载多终端工作区与 384×256 像素农场，高频 `farm` 切片还会浪费移动网络流量。移动端聚焦 4 个高频分拣与协同标签（收件箱、频道、会话、任务），按需订阅 5 个业务域切片，不订阅 `farm` 切片。

**直接复用本机无认证回环逻辑、仅靠 Tailscale IP 信任设备**：仅靠网络层来源 IP 无法区分同一 tailnet 下的其他设备，也无法单独撤销丢失的手机。引入 5 分钟一次性配对码 + SHA-256 哈希持久 `vv_dev_*` 令牌后，每台手机拥有独立身份、审计时间与即时撤销能力。

## Acceptance criteria

- 协议与传输层：`crates/protocol/src/contract/remote.rs`、`endpoints.rs`、`golden/schema/remote.json`、`packages/protocol/src/remote/{schema,api,transport}.ts` 与 `client.ts`、`capabilities.md` 全部通过 `cargo test`、`vp run protocol:check`、`vp run packages:check`；`transport.test.ts` 覆盖深链解析、地址规范化、配对交换、Bearer 头、跨分片多行 SSE、`Last-Event-ID` 续读重连、`401` 停连、`subscribe` 与 `close()` 清理。
- 服务端远程门：默认不启动远程监听；`remote.enable` 仅允许 Tailscale IPv4 或回环地址；一次性配对码 5 分钟过期且仅可兑换一次；撤销设备后原令牌立即返回 `401`；`Caller::Remote` 调用 `Caller::User` 专属端点返回 `403`。
- 桌面端设置与移动端应用：Mac 设置页提供远程访问开关、Tailscale 状态、二维码配对与设备撤销；`apps/mobile` 通过 `nsh check`、`nsh build` 与组件测试，支持深链／手动配对、4 标签实时切片刷新、审批权限与回复消息，且全部 97 枚图标通过 `<Canvas>` + `Path2D` 正确渲染。

## Risks

- **配对码暴力猜测或局域网重放**：短配对码若缺少频率限制可能被枚举。服务端应对 `remote.pair.exchange` 实施严格失败限流、5 分钟硬过期与单次消费原子作废，并在配对成功后记录设备信息供本机审查撤销。
- **Tailscale 状态变化导致监听地址失效**：Mac 切换网络或重启 Tailscale 时接口 IP 可能变化或短暂下线。远程状态接口应实时反馈 `tailscaleOnline` 与 `listening`，客户端遇断线按指数退避重连，并在权限失效（`401` / `403`）时立即停止重试并提示重新配对。
- **移动端后台切回导致 SSE 陈旧或重复连接**：iOS 应用切入后台后操作系统会挂起 TCP 连接。`HttpRemoteTransport` 必须通过 `Last-Event-ID` 续读最新切片，并在重建连接或卸载时调用 `close()` 中止旧连接，防止连接泄漏。
- **`nsh/mobile` 平台 API 在 iOS 与 Android 间存在行为差异**：首期以 iOS 为主，后续启 Android 时可能遇到深链或安全存储差异。应将 `nsh/mobile` 宿主能力收拢在 `apps/mobile` 的薄适配层中，保持协议层与业务视图零平台分支。
