# connector

`Service` 把微信、飞书、QQ 接到一个农场频道；三家的协议由各自 Adapter 翻译。只用出站连接，不开公网 HTTP 接口。

微信和飞书的 `Login` 由各自 SDK 完成一次扫码尝试。SDK 拥有二维码获取、验证码、刷新次数、域切换、轮询间隔和过期；Adapter 只把进度映射到页面，并把最终账号交给连接代际保存。登录取消仍由账号代际发起，SDK 的请求和等待跟随该 context 结束。

`voiceInbox` 拥有收件的接受、去重、游标和交付。Adapter 只交一页消息及下一页游标，或一条推送。接受成功表示消息已进 SQLite；游标与整页消息一起提交。收件工人向管家交付，成功后清空正文、保留去重记录。未完成的收件在重启后重试；管家成功但完成标记尚未写入时，重试可能重复交付。

`voiceConnection` 拥有每个账号的一代任务。协调器在这一代之外，取消并等待旧登录或接收、收件、发件任务结束后，才提交重新登录或退出。重新登录成功、退出成功会清掉旧收件，并退休旧发件；保存失败则恢复旧账号。SDK 在连接结束后回调，不能再接受消息。

`voiceOutbox` 拥有消息分段、积压摘要、串行发送、整批确认和退避。核心事件只入队，新回复打开平台回复窗口；网络发送不阻塞核心事件读取。

规则、页面与平台限制见 [服务端参考](../../../docs/reference/server.md#连接器微信飞书qq)。设计取舍见 [收件与账号代际](../../../.agents/notes/implemented/architecture/2026-10-18-connector-inbox-and-generation.md)。

验证用真实 SQLite、重开数据库和本机假 Adapter，不登录真实外部账号：`go test -race ./internal/connector ./pkg/qq ./pkg/weixin ./pkg/feishu ./migrations`。
