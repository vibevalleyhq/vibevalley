# mcp

在 `/mcp` 上把 `tool.Service` 给 Session 的工具交给外部农机。每个请求从 Bearer 令牌认出是哪个 Session，从核心状态找到它的档案和项目，放进调用的 context 里交给工具；没认出的一律拒绝，不调工具。参数先按工具的 schema 检查。拒绝和出错都按给模型看的文字返回（「没成：……」）。

工具本身、说明和参数都在 [tool](../tool/README.md)，此包不定义工具。

`go test ./internal/mcp` 经真实 MCP 请求验证工具列表和行为、全部工具拒绝无身份调用、记性只认 Session 自己的档案，以及 `session_list` 里的失败、歇息和冲突状态。
