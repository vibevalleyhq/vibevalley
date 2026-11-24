# Agent Note: 原生的 VibeValley：真机音频、签名公证与发布主线验收

Status: proposed

## Problem

全原生 macOS 架构（Rust 服务端与命令行、GPUI 窗口与像素农场、`nsh` TSX 工作台、本地 MOSS Live 与媒体任务机）已合入并沉淀至 [架构](docs/architecture.md)、[地基](docs/subsystems/foundation.md)、[客户端](docs/subsystems/app.md)、[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md) 与 [语音](docs/subsystems/voice.md)。公开发布前仍余三项真机与分发验收未完成：

1. **真实音频与麦克风设备验收**：MOSS Flash 流式与 MOSS Live 已通过离线协议与播放队列测试，真实厂商账号、麦克风权限与设备切换尚未在签名包上完成实机验证。
2. **Developer ID 签名与公证**：`.github/workflows/release.yml` 所需的正式 Developer ID 证书与 Apple 公证 profile 尚待配置与实跑。
3. **签名公证包全主线与双主题截图验收**：尚未在签名公证后的安装包上从空家目录走通开场、建仓派单、`/mcp` 汇报、工单追问合并、田头派单、定时任务、CLI 与重启续接八条主线及全路由双主题截图。

## Proposal

### 保留的裁剪边界

- **只接 DeepSeek，不做多厂商路由**（见 [VibeValley 自己的 agent](docs/subsystems/brain.md)）。
- **语音不接声网原生 SDK**，仅在宿主直连 MOSS Live WebSocket 与原生音频（见 [语音](docs/subsystems/voice.md)）。
- **不支持 `cursor` 与 `dsh` 驱动**（见 [档案、农机和技能书](docs/subsystems/agent.md)）。

### 待完成收尾顺序

1. **真实音频验收**：在单独授权后完成 Flash 语音播放、MOSS Live 麦克风权限与输出设备切换实机验收。
2. **发布签名环境**：配置 Apple Developer ID 证书与公证 profile，并在发布工作流（`.github/workflows/release.yml`）中跑通（缺少配置时明确失败，不发布 ad-hoc 包）。
3. **签名公证包全主线验收**：从空家目录在签名公证安装包上走通八条主线并补全工作台全路由双主题截图，完成后删除本 Note。

## Alternatives considered

**跳过真机音频与公证验证直接发 ad-hoc 包**：缺少 Developer ID 签名与公证会触发 macOS Gatekeeper 拦截，且麦克风权限提示与离线测试无法等价替代真实声学设备切换。

## Acceptance criteria

- 真实 MOSS 账号下完成 Flash 语音播放、MOSS Live 麦克风权限与设备切换实机验收并归档证据。
- `vp run package:mac` 搭配 Developer ID 与公证 profile 产出签名公证包，通过 `vp run update-check` 升级与回退验证。
- 签名公证包从空家目录走通八条发布主线与双主题全路由截图，完成后删除本 Note。

## Risks

- **0.x 原生依赖升级**：`nsh`、`gpui-fast` 与 `libghostty-vt` 升级可能引入接口或渲染变化，发版前须执行完整 `vp run release:verify`。
- **只支持 macOS 桌面宿主**：Windows、Linux 与浏览器页面不在支持范围内。
