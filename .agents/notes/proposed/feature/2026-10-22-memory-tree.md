# Agent Note: 记忆树：接真数据与手艺播种

Status: proposed

## Problem

`/tree` 页面（`apps/web/src/tree/`）目前展示的是静态演示数据（`src/tree/mock.ts`），尚未连接服务端的 `memory` 表与 EverOS 接口，点击「播种」也未真正写入技能书。

## Proposal

1. **协议与接口（`memory.tree`）**：将 `MemoryTree` 移入 `packages/protocol/src/memory/`，新增 `memory.tree` 接口汇总全农场各档案的 `note`（叶）、`issue` / EverOS case（果）、EverOS skill（种子）、`fading` 列表及共现关联边 `links`。
2. **累计计数与成长阶段**：在数据库中持久化只增不减的累计运行轮数与累计召回次数，由服务端算出成长阶段（芽 / 小苗 / 小树 / 大树 / 老树）填入 `MemoryTree.stage`。
3. **手艺播种进技能书**：用户在记忆树面板点击一颗手艺种子的「播种」并确认后，调用技能接口将其写入农场技能书（[档案和农机](docs/subsystems/agent.md)）。

## Alternatives considered

- **每个帮工画一棵独立的树**：成长被分散到多棵树上且同档案多会话归属不清；全局一棵树配合按帮工/仓库筛选更能体现整个农场的积累。
- **把记忆树直接种在农场主院子里**：占院子空间且分散对在办工单的注意力；放在独立 `/tree` 全屏视图更舒展。

## Acceptance criteria

- 打开 `/tree` 从 `memory.tree` 读取真实记忆条目、阶段与共现连线，删除 `src/tree/mock.ts`。
- 点击待播种手艺确认后写入农场技能书。

## Risks

- 记忆条目达数千条时星座连线会过密，需默认只画提炼因果金线，鼠标悬停单颗星时再显示共现淡蓝线。
