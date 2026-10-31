# Agent Note: 目录调整的启动条件与依赖边界

Status: proposed

## Problem

目录蓝图把物理文件归组与模块深度混为一谈，提出全仓移动，但尚未证明能减少具体需求的改动范围。

## Proposal

暂缓全仓目录迁移。只有 [深模块收口](.agents/notes/proposed/architecture/2026-10-31-deep-module-consolidation.md) 的真实调用方改动证明边界变化后，才同步移动该范围的文件。

- `packages/agent` 保持不认识农场；不为复用短文本函数而依赖 `protocol/rules`。
- `packages/protocol` 保持契约和两端共用规则；服务端专用工单状态与投影不回流到这里。
- `bridge` 是否并入 protocol，依据消费者、宿主依赖和公开接口判断；不以减少一个包为收益。
- `ai`、`agent` 的通配导出可先盘点实际消费者，再决定显式入口；只收紧已证明私有的出口。
- 服务端架构分组与领域目录不要求一对一；页面保持按用户概念组织。

实施顺序见[治理范围](.agents/notes/proposed/process/2026-10-30-code-quality-ratchets-and-boundaries.md)。

## Alternatives considered

**一次迁移到预设的八个包、十个服务目录。** 大量路径改动会掩盖行为改动，且可能破坏 agent 与农场之间的边界。

**把小函数合进 values 文件。** 文件变少，但领域归属更难判断。

## Acceptance criteria

- 每次目录调整关联一个已明确的边界变化和消费者清单。
- import 方向、包导出、测试入口、文档链接一起验证。
- 无边界变化时保留现有目录。

## Risks

目录迁移影响未合并分支；应与行为重构分开，避免把冲突解决当作架构收益。
