# Agent Note: 对话页次级标签收敛与素材组织方式

Status: proposed

## Problem

全局 `<Desk>` `h-9` 单行居中、`Tabs` `h-6`、`rail-runs-status`、工作区 `ChatPane` `h-8` 动作条、`ContentSidebar`、以及 `ArtifactType::Outline` 全栈收口（并退役独立 `pkm` 平行栈）已全部上线并沉淀至 [客户端](docs/subsystems/app.md)、[Artifact](docs/subsystems/artifact.md) 与 [媒体与素材库](docs/subsystems/media.md)。目前仅余两项后续界面与内容组织评估项：

1. **对话页宽屏双层顶栏**：[ChatPage.tsx](apps/mac/ui/features/channel/views/ChatPage.tsx) 在宽屏下于 `channel-head`（`h-9`）下方另起一行 `Tabs look="line"`（`聊天 / 任务 / 定时任务`），压缩了常规聊天视口高度。
2. **素材按项目或规划的组织方式**：二元内容中心（「作品 + 素材」）落地后，素材按项目、仓库或规划归类的长期组织方式尚未定案。

## Proposal

1. **宽屏收敛对话页次级标签**：在宽屏视口下将 `聊天 / 任务 / 定时任务` 切换收敛为紧凑分段胶囊并入 `channel-head` 中部或右侧（窄窗保持折至次行），释放垂直消息空间。
2. **明确素材归类模型**：评估是否按仓库/任务关联或集合标签为素材库补充归类维度，保持与作品「二元内容中心」一致的筛选心智。

## Alternatives considered

**保留对话页固定两层顶栏**：改动最少，但常规对话中任务/定时任务次级标签长期占用一行垂直高度。

**为素材另建独立顶级导航或第三类内容树**：会破坏已收敛的「作品 + 素材」二元模型，归类应留在素材筛选或元信息维度内。

## Acceptance criteria

- 宽屏下 [ChatPage.tsx](apps/mac/ui/features/channel/views/ChatPage.tsx) 顶栏收拢为单行（`channel-head` 内切换 `聊天 / 任务 / 定时任务`），窄窗保留次行回落，浅/深色截图无截断且 `vp run mac:check` 全绿。
- 拍板素材归类方案（落地或显式不引入），完成后更新 [客户端](docs/subsystems/app.md) 与 [媒体与素材库](docs/subsystems/media.md) 并删除本 Note。

## Risks

- `channel-head` 在中等宽度下若同时放置频道标题、简介、搜索/置顶/成员按钮与分段标签，可能挤压标题文本；需在 720–960px 宽度下验证 `truncate` 与响应断点。
