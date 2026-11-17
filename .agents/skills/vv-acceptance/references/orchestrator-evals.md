# 验收助手的评测

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册，不用沙箱。助手的单元测试使用内存与录好的假模型答复验证 harness（`internal/domain/stack/tools_test.go`、`stack_test.go`）；运行时通过 `/api/v1/orchestrator/eval/create`（`internal/domain/gateway/handlers_work.go`）把错轮录到 `$VIBEVALLEY_WORK_ROOT/evals/<id>.json`。设计和理由见 [助手的错变成评测](docs/subsystems/orchestrator.md)。

## 什么时候用

- 改了 `internal/domain/stack/prompts.go`、`tools.go`、`orchestrator.go` 里助手工具的名字、描述、参数或顺序。
- 改了助手对话预算、权限门槛与压缩机制（`internal/durable/budget.go`、`compaction.go`、`permission.go`）。
- 改了 `/api/v1/orchestrator/eval/create` 的写入格式。

不用它：只改了助手之外的网关转发，跑 `vp run server:check` 即可。

在联网测真模型、消耗额度前，**必须先问用户**。没有钥匙或用户没同意时，只做「准备」和「步骤」的离线检查，并在汇报里写明在线模型重放未运行。

## 准备

1. 跑 Go 类型检查、合约检查与 `stack`/`durable` 单元测试：

   ```bash
   vp run server:check
   env -u GOROOT CGO_ENABLED=0 go test -count=1 ./internal/domain/stack/... ./internal/durable/... ./internal/domain/gateway/...
   ```

2. 如需检查已录下的错轮 JSON，看工作根目录的 `evals/` 目录，去掉私人路径与钥匙后保存到单独证据目录。
3. 如用户同意并提供了测试钥匙，环境变量里只放所需 Provider 钥匙，不写进命令日志或仓库文件。

## 步骤

1. 先运行离线单元测试，确认工具 Schema、提示拼接、权限判断与 `/api/v1/orchestrator/eval/create` 行为全绿：

   ```bash
   env -u GOROOT CGO_ENABLED=0 go test -v -count=1 -run 'TestOrchestrator|TestTools|TestBudget|TestCompaction' ./internal/domain/stack/... ./internal/durable/...
   ```

2. 在沙箱中验证错轮录入接口（需在已结算模型轮次上调用）：

   ```bash
   vpx scripts/release/verify-server.ts --scripted-helper -- sh -c '"$VIBEVALLEY_VERIFY_CLI" doctor --json'
   ```

3. 若用户明确要求联网测试真实模型，经配置好的 Provider 启动独立沙箱复现对比，并记录每轮模型输出与 token 消耗；改完后确认原失败场景不再出现。

## 证据

说「验证过了」时，给用户看：

- 第 1 步 `go test` 的完整通过输出与命令。
- 沙箱 `result.json` 与请求日志；未联网跑真模型时明写「在线重放未运行」。
- 如有失败或边界放宽尝试，列出具体原因，不通过修改断言来凑绿。

## 出错时

- **`cannot evaluate a round that did not complete a model turn`**：`handlers_work.go` 要求目标轮次存在、未失败且含模型回答；确认 `roundId` 与对话轮次状态后再调 `/api/v1/orchestrator/eval/create`。
- **工具参数校验失败**：检查 `internal/domain/stack/tools.go` 的参数 Schema 与 `internal/domain/gateway` 导出定义。
- **网络超时**：检查外部 Provider 端点或代理设置，不私自读取用户真实配置文件里的钥匙。

## 收拾

沙箱跑完自动清理；单独导出的临时证据与录轮文件不放进仓库。
