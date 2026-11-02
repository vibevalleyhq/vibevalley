# 第 4 轮：Brain 只保留 Effect 接口

状态：完成。DAG 的归属、配置和工单模型未改动。

## 建议与裁决

- [最初建议](.agents/reviews/argon-six-rounds/round-4-advice.txt)撤回了把 Issue.start 机械并入 setStatus：自主创建派工与修改既有工单的授权、排队原因答复不同，保留该边界。
- 采纳替代候选，经[补充方案](.agents/reviews/argon-six-rounds/round-4-brain-advice.txt)清理 Brain 的 Promise 镜像和终端死路径。
- 不采纳「未给 owner 时默认建裸 Scope」；农机适配器要求调用者显式给运行器及父 Scope，测试也统一回收父 Scope。

## 执行

- 删除 `BrainHandle`、`BrainOwner`、`openBrain`、`standaloneOwner`。包里只有 Brain 的 Effect 接口。
- [vibevalley 适配器](apps/server/src/runtime/vibevalley.ts)直接运行需要的操作，只保留必需的 Promise SPI；没有复制镜像方法或监听器广播表。大脑与读取器各有父 Scope 下的子 Scope；关闭时排空最终用量和关闭事件，重复 dispose 共用同一 Promise，初始化失败关闭两个子 Scope。
- [终端入口](apps/server/src/cli/chat.ts)在非 vibevalley 分支不再构造永远不会选中的 vibevalley 农机、模型与 owner。
- 在线评测与包内测试直接用 makeBrain 和 Scope。评测仍从发送输入起计五分钟，模型错误和超时走带标签错误，原错误文案保留；没有调用付费模型。
- 上述三个生产文件相对本轮基线净减 73 行。约定更新到[大脑](docs/subsystems/brain.md)和[地基](docs/subsystems/foundation.md)。

## 验证及复审

- 基线包内 39 项、农机 7 项测试通过。迁移后包内 38 项、农机/CLI/离线评测 13 项通过：并发 close 用例从包内迁到真实 oar dispose，另增父 Scope 关闭的农机测试；半截回答与用量断言保留。
- 完整检查最终通过：server:check 16/16 任务，服务端 723 测试通过、1 真实模型评测跳过；类型、Effect、web:check、deadcode、health:verify、docs:verify 通过。日志前缀 `/tmp/vv-six-r4-`。
- 全量检查曾两次卡在未改生产路径的 send-key 测试，单跑通过。原等待条件把两个唯一输入误当成必须产生两次答复，与一个 loop 可消费多条输入的语义冲突。改为等待两条输入进入模型，屏障后仍严格断言各出现一次；20 项管家测试和完整检查通过，没有放宽去重断言。
- [Gemini 主复审](.agents/reviews/argon-six-rounds/round-4-review.txt)未发现生命周期或镜像残留，建议修正评测错误通道与超时文案，已采纳。[补充复核](.agents/reviews/argon-six-rounds/round-5-refined.txt)确认 send-key 等待修正符合语义。
- 隔离服务端验收目录 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-VUCzvP`：农机列表、创建工单、派活、完成合并及状态读取通过；code 为 0，stopped 为 true，cleanupErrors 为空，服务端 stderr 为空。此烟测用脚本农机；vibevalley 自身的 oar SPI 由直接调用真实适配器的离线测试覆盖，不声称测试过在线 DeepSeek。
