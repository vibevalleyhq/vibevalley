# Agent Note: 设计体系的下一步：大纲里还缺的几块

Status: proposed

## Problem

[界面怎么做](docs/style/design.md) 把主人给的八篇大纲逐章对过，「部分」和「缺」的这些还没做：

- **桌面**：极窄的窗口有几处会撑破。

## Proposal

一项一个 PR，按对主人的影响排：


## Alternatives considered

- **一次做完**：每一项都要截图、验收，混在一起审不动；一项一个 PR，做完一项删一项。
- **照搬大纲的玻璃材质、着色器光效、气泡**：见 [界面怎么做](docs/style/design.md) 对照表里「不做」的理由。

## Acceptance criteria

- 每一项做完，[界面怎么做](docs/style/design.md) 对照表里那一行变成「有」，本篇划掉那一项；全部做完删掉本篇。

## Risks

- 语法高亮的库大：放进 Worker，按需加载语言，不进首屏的包。
- 想了多久要服务端带开始的时刻：是核心状态的新字段，照「核心状态只有一份」加在 `shapes.ts` 和 `reduce` 里。
