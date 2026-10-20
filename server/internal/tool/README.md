# tool

agent 能调的工具都定义在这里，各定义一次：管家在进程里拿（`Manager`），外部农机上的 Session 经 `/mcp` 拿（`Session`，`internal/mcp` 只做传输和认证）。工具的规则在拥有它的服务里；这里只读参数、问是谁在调（`Caller`）、把结果写成给模型看的一句话，拒绝也是一句话。

按事情分文件：`look.go` 看地里（项目、频道、花名册、看进度、看改动、`session_list`），`talk.go` 在频道里说、读、看未读，`memory.go` 记性，`dispatch.go` 派活、带话、收获、叫停、收工，`task.go` 种植计划和定时，`channel.go` 开频道、改频道，`doc.go` 读文档、加一块、改一块的字（只给 Session）。两边共用的工具只有一个定义；真正不一样的（管家替别的档案记、Session 只记自己的）在同一个函数里按调用者选写法（`kind`）。

## 调用者

`Who` 在每次调用时说是谁：管家的调用者跟着它正在回答的那条输入走（在哪个频道、主人选的档案、是不是主人说的）；Session 的由它的令牌定，档案和项目从核心状态里这个 Session 取，不从参数取。只有主人的话能让 `merge`、`graph_action merge` 和 `graph_action start` 动手。

## 参数

参数从 Go 类型和 `json` tags 生成模型 schema（`schema.go`，`jsonschema-go`），`jsonschema` tags 写字段说明。可省略字段用 `omitempty`，省略和显式 `null` 不同。计划动作和定时种类从 protocol 的值表生成。管家的工具按 `Manager` 里的顺序给模型，这个顺序是提示开头的一部分，不随便改。

## 验证

`go test ./internal/tool`：`schema_test.go` 对照 `testdata/tool_schemas.json` 查管家每个工具的参数没变（有意改了就改这份基线，并照 verify-manager-evals 重放管家的样例）；`spentText` 的黄金数据在 `testdata/rules.jsonl.gz`。经 MCP 的行为由 `go test ./internal/mcp` 测，管家用工具的行为由 `go test ./internal/manager` 测。
