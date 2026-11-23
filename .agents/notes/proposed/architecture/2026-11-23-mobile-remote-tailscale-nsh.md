# Agent Note: Tailscale 与 nsh 原生移动远程控制：真机分发与远程推送

Status: proposed

## Problem

受认证远程 HTTP/SSE 门（`crates/server/src/modules/infra/remote/`）、纯 Web Fetch 传输层（[transport.ts](packages/protocol/src/remote/transport.ts)）、Mac 设置页（[RemoteAccessPage.tsx](apps/mac/ui/features/setting/RemoteAccessPage.tsx)）、97 枚矢量图标生成（[icons.ts](scripts/gen/icons.ts)）以及支持折叠屏双栏自适应的 `apps/mobile` 4 标签原生外壳已落地并沉淀至 [核心状态与接口](docs/subsystems/core.md) 与 [客户端](docs/subsystems/app.md)。目前仍余两项移动端真机上线缺口：

1. **移动端真机签名分发尚未接通**：`apps/mobile` 尚缺 iOS TestFlight / App Store 与 Android 签名发布打包流水线及真机深链配对回归。
2. **后台唤醒与系统远程推送未接入**：应用进入后台、SSE 连接被系统挂起后，尚无面向待审批权限或 `@用户` 提及的系统推送唤醒。

## Proposal

1. **真机分发与深链实测**：在 iOS 与 Android 真机上完成 `vibevalley://pair` 深链拉起、Tailscale 跨设备配对、断网重连 `Last-Event-ID` 续读及设备撤销回归。
2. **后台提醒与推送评估**：评估在不引入中心化云账号体系的前提下，通过本机通知代理或静默重连机制补齐移动端离线待办提醒。

## Alternatives considered

**引入自建公网中继保持长连接**：需要云端账号体系与常驻中继运维，违背 Tailscale 点对点私网与单机零云依赖边界。

## Acceptance criteria

- 完成 iOS / Android 真机签名包构建与 Tailscale 跨设备实机配对、断线续读和权限审批验收。
- 明确后台离线推送取舍并沉淀进 [客户端](docs/subsystems/app.md)，完成后删除本 Note。

## Risks

- **系统挂起后台套接字**：iOS 切入后台后操作系统会回收 SSE TCP 连接，恢复前台时须通过 `Last-Event-ID` 无漏续读。
