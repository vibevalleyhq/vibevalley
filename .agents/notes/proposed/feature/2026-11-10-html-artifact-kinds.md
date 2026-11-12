# Agent Note: 网页 Artifact 的 motion 动画时间轴与导出视频

Status: proposed

## Problem

网页 Artifact（[Artifact](docs/subsystems/artifact.md)）已上线 `display` 字段（`page`、`slides`、`motion`）、`?shell=1` 的 `vv` 消息约定与 `slides` 幻灯片放映/打印，但 `display: "motion"` 尚未实现时间轴驱动与视频导出：帮工交上来的动画页缺少统一的播放条、逐帧定位与导出进[素材库](docs/subsystems/media.md#素材库)的能力。

## Proposal

复用现有的 `@vibevalley/artifact/shell` `postMessage` 通道（`HtmlShellMessage` / `HtmlShellCommand`），补齐 `motion` 运行时与工作台控制条：

1. **确定性时间轴注册（`vv.timeline`）**：
   - 沙箱运行时暴露 `vv.timeline(duration, renderAt)`（并兼容直接传入 GSAP timeline，从白名单 CDN 加载），向外壳上报 `ready`（含总时长 `duration`）与当前时刻 `at`。
   - 响应外壳的 `play`、`pause` 与 `seek(t)`：任意时刻 `seek(t)` 必须确定性画出同一帧画面；不符合约定的页面平滑退回普通 `page` 显示。
2. **外壳播放控制与浏览器录屏导出**：
   - 工作台 `MotionControls` 提供播放/暂停、进度条拖动、逐帧前后步进与循环开关；新增助手与帮工的 `motion` 起手模板与技能说明。
   - 点击「导出视频」时，外壳按固定帧率逐帧 `seek(t)` 截取画面，在浏览器内用 `WebCodecs` / `MediaRecorder` 编码为 `webm`（或 `mp4`，初版限 60 秒以内），作为「生成的」条目存入素材库并记录来源指向该 Artifact 的当前稿。

## Alternatives considered

- **用自定义 JSON 关键帧格式代替 HTML**：帮工手写长 JSON 易错且表达力受限；保持 HTML 优先、只约定 `seek(t)` 时间轴即可复用成熟动画库。
- **在服务端带无头浏览器录屏**：增加服务端体积与打包复杂度；浏览器内逐帧驱动编码已满足短动画导出。

## Acceptance criteria

- `display: "motion"` 的网页 Artifact 在聊天旁栏与 `/artifacts` 页均可播放、暂停、拖动时间轴与逐帧步进；切回 `page` 显示原整页。
- 导出视频后[素材库](docs/subsystems/media.md#素材库)新增对应视频文件，来源指向该 Artifact 版本；超过时长上限时明确提示。
- Playwright 测试验证同一 `t` 两次 `seek(t)` 画面一致、控件可访问性通过 axe；更新 [Artifact](docs/subsystems/artifact.md) 后删除本 Note。

## Risks

- DOM 动画（非单 `<canvas>`）在浏览器内逐帧光栅化受限于页面绘制方式，需规定导出目标容器（`<canvas>` 或 `<svg>` 优先）并对不支持录制的页面给出明确提示。
