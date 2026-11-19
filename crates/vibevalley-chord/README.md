# Chord 互通验收

Rust 和 Go 各自使用本语言的 WebSocket、Chord 编解码器及订阅实现。参考提交为 `a2c1851abd67116582d89302533377d802108d54`。从仓库根运行下列命令。[复验脚本](crates/vibevalley-chord/tests/interop/verify.sh)

```sh
crates/vibevalley-chord/tests/interop/verify.sh
crates/vibevalley-chord/tests/interop/verify.sh --app
```

第一条只取参考提交的 Chord 包和 Go 模块清单。第二条还构建参考 Go 服务端及原生服务端。验收使用环回地址、临时数据库和脚本模型。需要 Git 可读该提交、Go 可构建参考模块、Rust 工作区依赖已安装。脚本完成后删除临时目录。

| 真实连接 | 核对条件 |
| --- | --- |
| Go 客户端到 Rust 端点 | 双向检查身份、调用对侧 RPC、收发分块的大字符串。Go 取消已开始的调用后，Rust 释放处理任务。Go 从 Rust 文档收到初始值及字段增量。 |
| Rust 客户端到 Go 端点 | Go 验证 Rust 身份并回调 Rust。两端收发 Chord 心跳。Rust 取消后，Go 的处理函数收到取消。慢读期间提交 12 次后，客户端一次读到最终值。 |
| 断线和订阅 | Go 只保留两个修订。断线时变更一次，Rust 续订收到字段增量。变更四次，Rust 收到根替换。退休和重建各触发一次状态变化。单次提交超过待发操作上限时，客户端同时收到溢出标志和完整快照。 |
| Rust 客户端到 Go 服务端 | 从原版 `/chord/ws` 调用 `issue.create`。核对订阅的新增工单与 `issue.list`、`space.snapshot` 的结果。 |
| Go 客户端到 Rust 服务端 | 机器节点身份遭拒，用户设备通过握手。用原生命令行创建工单，Go 从 `space` 订阅读到修订推进和相同的工单。 |
| Go 客户端批准 Rust 助手的工具 | 脚本模型请求创建工单，真实策略将请求挂起。Go 从订阅读到审批卡，通过 `approval.resolve` 批准，再调用 `budget.raise`。订阅移除审批卡并出现工单。关闭并重开同一隔离库，工单只出现一次。 |

### 领域 RPC 范围

Go 参考服务注册 16 条路由。原生 Chord 入口注册前两行的 5 条，后四行列出其余路由的适配范围。

| Go 参考路由 | 原生分支的边界 |
| --- | --- |
| `health.ping`、`approval.resolve`、`budget.raise` | 已有同形的健康回执、审批回执和预算快照。跨语言用例分别核对其使用的字段。 |
| `space.snapshot`、`issue.list` | 已按 Go 的工作区形状投影。用例核对工单身份、标题、状态、订阅修订及审批卡。Rust 的空 `dreams` 列表没有提案生命周期。 |
| `issue.create`、`issue.queue` | Rust 工单服务支持创建和排队。Go 接受工单对象、可选派发标志并返回派发回执。原生端点的创建入参和状态变更结果不同。 |
| `channel.post`、`channel.events` | Rust 有发送与查询消息的端点。Go 的作者身份、事件种类、游标和投递结果需逐项转换。 |
| `pkm.search`、`pkm.backlinks` | Rust 有页面搜索和按区域分组的反向链接。Go 的向量搜索权重、排名及路径结果需要单独定义映射。 |
| `memory.dream.run`、`memory.dream.approve`、`memory.dream.rollback`、`artifact.publish`、`vault.token.issue` | Rust 的现有端点未提供等价的梦境提案生命周期、Go 交付物的文件发布契约或带能力范围的出站令牌。 |

跨语言断线测试保留服务进程与同一份文档。更换服务进程后，如果新文档从相同或更低的修订开始，两端还需约定如何识别新文档。原生桌面当前从桥读取核心帧。[原生客户端](docs/subsystems/app.md)
