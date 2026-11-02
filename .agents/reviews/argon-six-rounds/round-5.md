# 第 5 轮：删除轮询假时钟与等待未来轮询的暂存方式

状态：完成。HTTP 兜底保留，编辑防抖、批次重试和 IME 语义保留。

## 建议与裁决

[原建议](.agents/reviews/argon-six-rounds/round-5-advice.txt)撤回了通用字段意图工厂：不同意图的确认源、去重和失败交互确实不同。对于产出编辑器，不采纳直接删除 HTTP 轮询；WebSocket 不可用时它承担现有可用性。执行[校正方案](.agents/reviews/argon-six-rounds/round-5-refined.txt)，消除的是「轮询次数充当时间」以及「暂缓更新只存 ID、靠未来全量轮询补内容」。

## 执行

- [BlockEditor](apps/web/src/features/artifact/editor.ts) 不再计 polls；按页面收到新版本的时间计算活动窗口，一个到期定时器通知页面重画。块提示 3 秒、整体提示 4 秒，无新推送也会消退。
- 暂存最高版本的完整远端块。失焦且没有本地待发文字时直接应用；dirty、composing、排队和在途块保持本地文字及旧 baseRev，让服务端继续判断冲突。
- 迟到 ack、块及快照不倒退版本；重置快照不提前抬高本地编辑的版本，也不误删在途新增块。别的块正在提交时，不延后未改字块的失焦更新。
- [产出文档](docs/subsystems/artifact.md)删除「还没有广播」和按询问次数保持写入状态的旧描述，明确 WebSocket、HTTP 兜底与真实时间。
- 生产文件由 586 行变为 629 行，净增 43 行。本轮是消除错误状态概念并补全同步边界，不计作删行收益，也未以删除兜底行为换取更少代码。

## 失败证据与验收

- 新回归测试先在原实现上运行：6 项中 3 项失败，分别为提示不消退、失焦仍是旧内容、旧块倒退版本。随后重置快照和 Gemini 指出的两个边界也先补失败测试再修正。
- [编辑器测试](apps/web/src/features/artifact/editor.test.ts)最终 10 项通过：活动到期、最新暂存块、在途批次前后的冲突版本、IME、乱序 ack/块/快照、HTTP 兜底、重置时的新块与脏文字保护。
- [真实页面测试](apps/web/test/artifact-blocks.spec.ts)新增两项回归，覆盖焦点保持后失焦更新和页面计时到期。该文件 11 项通过；页面全套 208 项通过；桌面应用 3 项通过。日志 `/tmp/vv-six-r5-tests.log`、`/tmp/vv-six-r5-focused-e2e.log`、`/tmp/vv-six-r5-e2e-final.log`、`/tmp/vv-six-r5-desktop.log`。
- 截图 `apps/web/.screens/argon-editor-deferred.png` 与 `apps/web/.screens/argon-editor-writing-expired.png` 已打开检查：远端内容可见、提示已消退、页面无空白或溢出。到期截图先等待标题可点击，避免把启动遮罩当成结果。
- 全套页面首跑为 207 通过、1 失败：flow-polish 的绝对计数测试复用了其他文件留下的工单。使用既有独立 farm 选项后，原零计数和后续计数断言保持不变，全套通过。
- 类型、web:check、健康与文档检查通过。模型[首次复审](.agents/reviews/argon-six-rounds/round-5-review.txt)给出两项边界修正，已实现；[补充复核](.agents/reviews/argon-six-rounds/round-6-advice.txt)确认无遗留问题。
