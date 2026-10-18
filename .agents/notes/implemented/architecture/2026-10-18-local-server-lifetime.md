# Agent Note: 主接口的本机身份和就绪顺序归宿主

Status: implemented

## Problem

主接口没有鉴权，依赖只能从本机访问，但 `Config.Host` 可以从 YAML 或环境变量取任意地址。HTTP 监听和帮工的 MCP 地址各自读取这个配置，安全前提变成调用方必须记住的约定。

命令行还手工安排 `Workspace.New`、院门 API 绑定、`Start`、监听、`SetAddress`、HTTP 服务和关闭。`Start` 里面会调用 `OnReady`，定时和排队可能立即派活；这时实际监听地址还没有建立，端口 0 尤其不能用配置里的数字构造 MCP 地址。

两个服务端还可以用不同端口打开同一 Home。SQLite 只协调数据库，档案、核心状态、执行和花费的 JSON 各有一份进程内快照；第二个进程保存另一项设置，也会覆盖第一个进程已确认成功的修改。macOS 按 bundle id 限制应用实例，不能覆盖独立命令行或指向同一 Home 的其他渠道。

## Decision

`Config.ServerAddress` 只构造固定回环地址与端口，删除 Host 这个配置选择。院门仍是独立的有鉴权入口，语音线路也保持独立。

`handler.Listen` 拥有监听、Workspace、Gate API 绑定、MCP 实际地址、HTTP 请求 context 与停机。它先取得监听地址并组装农场；所有 `OnStart` 订阅结束后，`base.BeforeReady` 开始提供 HTTP，再执行各模块的 `OnReady`。命令行只提供配置与生命周期 context，读地址和等待结束。

启动失败释放已取得的监听与数据库；context 取消时先终止请求、关闭 HTTP，再关闭农场。`Wait` 返回表示两者都已停止。

`base.App` 在构造服务前取得 Home 的排他文件租约，持有到全部服务结束停机写入、数据库关闭之后。路径先解析符号链接；同一目录的别名仍争用同一把锁。构造失败释放租约，`Close` 只执行一次。锁由内核持有，进程退出即释放；锁文件保留，删除它会让其他进程锁住另一份 inode。延迟写入的 `FileWriter.Finish` 完成最后一份快照后封口，已触发的计时器不能在租约交出后再落盘。

## Alternatives considered

**只校验 Host。** 可以防止错误配置，却保留一个本来不支持的选择和两个地址构造点。直接删除选择，地址规则只有一个主人。

**只提前 net.Listen。** TCP 端口虽然存在，`OnReady` 发来的请求仍可能等不到处理。传输必须在就绪动作前真正开始服务。

**只把 main 移到另一个函数。** 调用顺序仍是隐含知识，测试也只能看整体成功。本次由生命周期定义传输就绪阶段，并验证 `OnReady` 请求和失败清理。

**只靠端口、桌面单实例或 SQLite。** 它们分别约束网络地址、bundle id 和数据库写事务，都不能代表 Home 中整组文件的唯一主人；改端口或从命令行启动即可绕过。

## Consequences

端口 0 下的帮工拿到实际监听地址。代码和测试不再通过 Host 开启主接口的网络访问；远端设备继续经院门。

`ready_test.go` 验证实际 `OnReady` 可以发 HTTP 请求；`handler/server_test.go` 验证准备阶段的 MCP 初始化、端口身份、取消关闭，以及启动失败释放监听和数据库。

`home_lease_test.go` 验证同 Home 在服务构造前拒绝、不同 Home 可并存、停机写入结束后释放、构造失败释放和符号链接别名；`files_test.go` 验证最后写入完成后迟到回调不再碰文件。
