# 第 3 轮：移除计划的空视图占位

状态：本轮读取/编辑精简、测试和 Gemini 复审完成；此结论不包含 Agent DAG 的目标能力与存储归属。

## 建议与执行

[建议原文](.agents/reviews/argon-six-rounds/round-3-advice.txt)提出把 TaskGraph 的派生读取集中在一处。执行后，`graphFrom` 一次算齐分层、阻塞、花费、动作与文案，状态帧直接使用 `graphsOf`；`graphView()`、`taskView()` 和所有空字段填充调用删除。

内部 `GraphSpec`、`TaskSpec` 只约束写入及编辑所需字段；未给 protocol 新增平行 View 类型。`graph.get/list` 的既有字段由空值变为真实动作与文案，这是有意修正的读取差异，不声称接口答复字节不变。页面仍收到原来的完整帧。

## 技术证据

- 修改前后捕获 700 种计划输入、中文和英文两种语言，共 1,400 份帧图数据，逐结构比较全部相同。规范化 JSON 的共同 SHA-256：`a0ae4810345eccb680f81834e79a453ac9cdab7f8bc4a516796ca7b9bb6ee2bb`。快照在 `/tmp/vv-six-r3-before.json` 和 `/tmp/vv-six-r3-after.json`。
- `golden:update task` 的 1,300 行数据中，只从 42 个节点各删去六个空占位键：blockedBy、stateText、actions、actionText、canEdit、canRemove；其他值零变化。Core 的黄金数据未更新。
- 读取回归测试（历史实现，已移除）验证真实动作、分层、花费、不同语言、输入不变以及把完整读图写回时不混入展示字段。54 项定向测试通过。
- `vp check --fix` 通过；`server:check` 16/16 任务成功，721 测试通过、1 真实模型评测跳过；`web:check` 11/11 成功；死代码、47 区域健康棘轮与文档检查通过。
- 隔离 HTTP 验收使用 `/tmp/vv-six-r3-acceptance.mjs`：拆单、子工单完成、计划合并，同时断言 graph.list/get 有真实动作、与 SSE 帧中的图一致。证据目录 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-pPTViB`，code 为 0、stopped 为 true、cleanupErrors 为空。
- [Gemini 复审](.agents/reviews/argon-six-rounds/round-3-review.txt)：0 项必须修正，核对了类型、locale、事件/审计隔离与依赖方向。

## 用户补充的架构问题

上述证据只证明读取和编辑边界改动的技术行为。用户随后指出 DAG 原本是为 agent 配置的能力，要求 Gemini 判断当前 Task 与工单的关系是否混淆了能力归属与任务载体。专门审查已经交付，确认不能把借用工单存储当成能力归属。去掉假空值与读写边界分离可保留；后续若选择改变 DAG 的数据源，读取投影随目标模块调整。本批不把既有父子工单结构当成目标领域原则。
