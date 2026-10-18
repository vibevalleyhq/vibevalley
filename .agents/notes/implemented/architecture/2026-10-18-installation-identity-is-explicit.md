# Agent Note: 安装选择是探测输入，执行沿用已接受的身份

Status: implemented

## Problem

农机设置的 `BinPath` 通过 `runtime.probe` 写进进程环境变量 `OAR_<RUNTIME>_BIN`。smith 的安装探测再读取它，`Subagents.Spawn` 还会重新探测一次。两个配置实例共用一个进程时会覆盖彼此的选择；即使显示缓存已拒绝旧探测，进程环境仍是另一条可变通道。调用方还必须知道 SDK 的环境变量命名和先探测再启动的顺序。

## Decision

smith 的 `InstallationProbe` 接收显式 `InstallationOptions`。`Binary` 为 nil 时沿用 SDK 的环境变量默认值；指向空字符串时跳过环境覆盖，按 PATH 和默认候选查找；非空时只探测指定的命令。VibeValley 把保存的 `BinPath` 作为显式输入，保留服务端原来的空路径口径，不再修改进程环境。

`runtime.Resolve` 带回配置匹配的已接受安装。`SpawnOptions.Installation` 让 smith 直接用这个安装开会话，省掉第二次身份选择；没有可复用安装时，用这次的显式探测选项查找。拒绝项、执行数量和深度检查照常先做。

## Alternatives considered

**给环境变量读写加锁。** 只能约束参与同一把锁的调用方，独立 SDK 调用和其他包仍可观察或改变进程全局状态。

**把覆盖值塞进 context。** 安装选择是正常输入，不是生命周期；把它藏进 context 会留下另一套隐含调用约定。

**每次执行重建 Runtime wrapper。** 会恢复已经删除的每会话驱动代理。安装身份通过现有 Spawn 输入传递，不修改共享 registry。

## Consequences

独立命令行继续支持原环境覆盖，嵌入式调用者可以并发探测不同配置。`nil` 与显式空值的区别在类型注释和 SDK 文档里固定；指定路径失效不会悄悄选择另一台农机。

## Verification

- SDK 测试覆盖两个并发显式路径、环境变量不变、默认环境覆盖、显式空值和缺失路径不回退。
- runtime 测试同时创建两份配置，分别 Resolve 到各自命令；smith 测试证明已接受身份不重探，拒绝项仍拦住执行。
