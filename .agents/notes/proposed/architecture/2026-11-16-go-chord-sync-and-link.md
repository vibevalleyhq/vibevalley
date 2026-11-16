# Agent Note: Go 版 Chord 状态增量同步与跨进程多路复用链路

Status: proposed

## Problem

在受管平台架构（[总架构路线](.agents/notes/proposed/architecture/2026-11-16-go-managed-platform-roadmap.md)）中，服务端需要同时向多端页面（浏览器、手机壳、[`egoist/mygo`](https://github.com/egoist/mygo) 桌面主窗口与原生 GPU 灵动岛）推送 100 ms 节拍的流式状态，并反向调用处于 NAT 内网后的 `vibe-machine` 节点。

现有基于单向 SSE 的整帧或手工事件拼接方案（[核心状态](docs/subsystems/core.md)）在跨机双向控制与高频局部流式更新下面临三项限制：

1. 单向 SSE 无法承载服务端对远程 `vibe-machine` 的反向文件读写、进程拉起与取消信号传播。
2. 慢网速客户端或后台挂起的手机端积压大量流式吐字分片时，缺少在线操作折叠与快照退化上限，重连时易造成带宽突刺或乱序闪烁。
3. 若桌面端本地通信绑死特定框架私有 IPC（如 `mygo.Bind`），`apps/web` 页面代码将与浏览器及手机宿主分叉。

## Proposal

参考 [`@earendil-works/chord`](https://www.npmjs.com/package/@earendil-works/chord)（源码文档见 [`pi/packages/chord/README.md`](https://github.com/earendil-works/pi/blob/main/packages/chord/README.md)）及其 Go 移植探索 [`dat267/pier/chord`](https://pkg.go.dev/github.com/dat267/pier/chord)（主仓 [`dat267/pier`](https://github.com/dat267/pier)），在 `pkg/chord` 实现零业务依赖的状态增量同步与双向多路复用连接层。保留虚拟对象寻址、严格 JSON `Delta` 折叠与单飞 `Watch` 机制，剔除 JS 专属的运行时动态 Schema 构建器与进程内插件热重载。

## 严格 JSON 模型与 `PendingOps` 增量折叠（`pkg/chord/delta`）

进入同步层的状态快照须符合严格 JSON 值约束（仅允许 `nil`、`bool`、`string`、有限 `int64`/`float64`、`[]any`、`map[string]any`，禁止 `NaN` 与 `±Inf`）。已发布快照视为不可变值，写路径通过写时复制（Copy-on-Write）草稿记录四类紧凑元组操作：

| 操作码 | 线缆 JSON 格式 | 作用机制 |
|---|---|---|
| **`r`（Replace）** | `["r", path, value]` | 替换 `path`（字符串数组路径）处的值；根替换简写为 `["r", value]`。 |
| **`d`（Delete）** | `["d", path]` | 删除映射字段 `path`。 |
| **`a`（AppendText）** | `["a", path, suffix]` | 向字符串末尾追加 `suffix`，专用于模型流式文本与终端输出，避免重传前缀。 |
| **`s`（SpliceArray）** | `["s", path, index, deleteCount, items...]` | 对数组执行尾部追加或滑窗裁剪（维持最新 50–100 条会话记录窗口）。 |

当消费端回调正在执行或底层传输拥塞时，新产生的操作批次推入该订阅专属的 `PendingOps` 队列执行四条在线折叠规则：

1. **相邻追加拼合**：同一 `path` 的连续 `["a", path, s1]` 与 `["a", path, s2]` 合并为 `["a", path, s1 + s2]`。
2. **子树覆盖消除**：新到达 `["r", path, v2]` 时，清除队列内针对 `path` 及其所有子路径 `path/*` 的旧操作。
3. **新建接追加原地合并**：队列内 `["r", path, "a"]` 后接 `["a", path, "b"]` 时直接合并为 `["r", path, "ab"]`。
4. **10,000 条上限根替换熔断**：折叠后若挂起操作数仍超过 `10,000` 条，立即清空队列并标记溢出，下一次推送直接输出单条全量根替换 `[["r", latestRoot]]`，确保慢消费内存恒定且包体积不反超快照。

## 单飞 `Watch` 观察者状态机（`pkg/chord/watch`）

每个可观察资源（空间核心状态、会话实时面板、工作目录同步清单）暴露统一的泛型句柄 `WatchHandle[T]`：

- **串行单飞投递**：同一 `WatchHandle` 在上一次异步消费回调返回前绝不并发重入；期间源端产生的所有提交在 `PendingOps` 内合并，待回调返回后以最新修订号 `rev` 一次性投递。
- **退役与重建连续性**：目标文档在事务中被回收时，投递一次 `retired: true`、保留末次值且无 `ops` 的通知而不断开句柄；后续同地址文档重建时自动以根替换恢复推送。
- **取消上下文对齐**：直接采用 Go 标准库 `context.Context` 表达调用生命周期（对齐 [`dat267/pier/chord`](https://pkg.go.dev/github.com/dat267/pier/chord) 设计）；主动调用 `Stop()` 幂等丢弃待发缓冲并切断对上游状态树的引用。

## 双向多路复用 `Link` 与多宿主传输适配（`pkg/chord/link`）

`Link` 在单一字节帧通道上复用双向带截止时间的 RPC（`rpc_req` / `rpc_res` / `rpc_cancel`）与多路视图订阅（`watch_open` / `watch_push` / `watch_stop` / `watch_end`），握手帧绑定鉴权主体 `Principal`（区分用户设备钥匙、机器钥匙与单会话临时令牌）。

为保证 `apps/web` 一份前端代码零改动运行于所有宿主，底层传输抽象为统一的 `FrameTransport` 接口：

1. **WebSocket 传输适配器**：用于浏览器、手机壳，以及远程 `vibe-machine` 向 `vibe-server` 发起的出站穿透长连接（每 15 秒心跳探测，45 秒超时自动取消该链路上全部在途 RPC `ctx`）。
2. **MyGo 进程内 IPC 传输适配器**：在 `vibe-desktop` 单机模式下，通过 [`egoist/mygo`](https://github.com/egoist/mygo) 的绑定服务与流式通道直接传递 `Link` 帧，无需监听本机回环 TCP 端口，同时保持前端业务层 100% 面向 `Chord Link` 编程。
3. **游标无闪烁重连**：连接闪断恢复后，客户端携带本地最后确认的 `fromRev` 重发 `watch_open`；若落后区间仍在源端修订环缓冲内则仅补发增量，否则平滑回退为最新窗口快照。

## Alternatives considered

- **沿用 REST 加单向 SSE，另起一套 gRPC 管远程机器**：需同时维护两套鉴权、两套序列化与两套连接保活逻辑，且无公网 IP 的个人开发机在反向穿透时配置繁琐。
- **在 Go 中完整移植上游 Chord 的运行时合约 DSL 与插件热替换**：Go 具备编译期强类型检查与毫秒级进程冷启动能力，引入动态 Schema 与热替换会增加反射复杂度并削弱静态分析门禁。
- **在桌面端直接让前端组件调用 `mygo.Bind` 业务函数**：会导致 `apps/web` 与浏览器、手机端彻底分叉，违背一份页面共用原则（[客户端](docs/subsystems/app.md)）。

## Acceptance criteria

- 随机生成 50,000 步嵌套映射修改、流式字符串追加与数组滑窗裁剪的属性测试（Property-Based Test），任意分批经 `PendingOps` 折叠后的结果与逐步直接执行终态 `100%` 深度相等。
- 模拟慢消费阻塞并连续写入 15,000 次细粒度变更，释放后精确收到单次 `[["r", latestRoot]]` 根替换，期间内存无单调泄漏。
- 在 `go test -race` 下对并发 1,000 路双向 RPC 与 200 路 `Watch` 随机注入取消与断连，关闭后 100 ms 内所有派生 Goroutine 归零。
- 同一套前端 `ChordClient` 在 WebSocket 传输与内存管道传输下通过相同的断网重连与增量合并集成测试。

## Risks

- **原地修改破坏不可变假设**：业务代码若跳过草稿直接篡改已发布进追踪器的 `map` 或 `slice`，会导致并发读写竞态与增量漏算；须在测试模式开启快照哈希校验，并在包边界只接收值拷贝或序列化字节。
- **大体积单帧阻塞同链路心跳**：若在 `Link` JSON 帧内直接塞入数 MB 附件会导致队头阻塞；超过 64 KB 的文件读写与快照传输须拆分为带流 ID 的分块帧交错发送。
