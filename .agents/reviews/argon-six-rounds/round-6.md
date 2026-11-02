# 第 6 轮：频道标记共用失败回退路径

状态：完成。定向测试、真实页面测试、Gemini 复审及最终汇总检查均通过。

## 建议与执行

采纳[Gemini 方案](.agents/reviews/argon-six-rounds/round-6-advice.txt)：把已读、未读逻辑并入[频道标记](apps/web/src/features/channel/marks.ts)，删除独立的 reading 模块、重复频道查找和两处手写的失败 drop 分支。

各标记继续有自己的确认条件。`markUnread` 复用现有 `setMark` 的报错回调，在失败时先释放 held、再报错；没有新增 hook、通用工厂、测试后门或循环依赖。页面、消息组件、导出和测试同步修改；[客户端约定](docs/subsystems/app.md)更新为同一模块。

原两个模块共 275 行，合并后为 254 行，净减 21 行；调用方还有少量重复导入删除。不靠删除确认规则、断线队列或失败展示取得减少。

## 验证

- 基线标记测试 9 项通过。迁移后标记、意图运行器与层级检查共 20 项通过；新增未读标记失败时的 overlay 回退和报错验证。
- [页面回归](apps/web/test/chat-unread-rollback.spec.ts)通过：使用真实脚本帮工的消息，等待初次已读落盘；标未读被拒后，读取值和错误色恢复；再由另一个 API 客户端标未读，页面自动调用 markRead，证明 held 已释放。没有暴露或直接修改私有 held。
- 类型、健康棘轮、死代码与文档检查通过。[Gemini 复审](.agents/reviews/argon-six-rounds/round-6-review.txt)对本轮和此前实现未发现必须修正项。
- 日志 `/tmp/vv-six-r6-before.log`、`/tmp/vv-six-r6-tests.log`、`/tmp/vv-six-r6-e2e.log`、`/tmp/vv-six-r6-check.log`。
