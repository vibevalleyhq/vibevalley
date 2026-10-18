# mcp

给农场里的帮工提供群聊工具和记性工具。注册函数统一从请求中认证 Session 身份并封装 MCP 结果；各工具只接收已认证的 Session id 和参数。拒绝仍按给模型看的文字返回。

`session_list` 的阶段说明来自 `protocol.PhaseText`；此包只排列行和裁剪工单摘要，不重新解释执行阶段、冲突或重试。

`go test ./internal/mcp` 经真实 MCP 请求验证工具行为、全部工具拒绝无身份调用，以及列表中的失败、歇息和冲突状态。

`memory_search`、`memory_add` 的档案和项目从会话本身取（核心状态里这个 Session 的 `agent`、`project`），不从参数取；参数里写了别的档案就拒。读写都经 `memory.Service`，此包不知道有几个来源。
