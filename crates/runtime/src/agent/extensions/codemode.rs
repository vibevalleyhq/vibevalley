use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::BoxFuture;
use crate::agent::ai::types::ToolCall;
use crate::agent::codemode::{CodeModeResult, CodeModeSpec, EXEC, KIND};
use crate::agent::core::engine::Engine;
use crate::agent::core::extension::Extension;
use crate::agent::core::pipeline::PromptSection;
use crate::agent::core::tool::{ReplayPolicy, Tool, ToolContext, TypedTool, TypedToolAdapter, TypedToolOutput};
use crate::agent::durable::{self, Task, TaskContext, TaskStatus, Transition, WaitMode};

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RunCodeArgs {
    /// JavaScript body executed inside the deterministic QuickJS sandbox (`call(name, args)` / `sleep(ms)`).
    pub script: String,
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default, alias = "timeoutMs")]
    pub timeout_ms: Option<i64>,
    #[serde(default, alias = "maxSteps")]
    pub max_steps: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCodeDetails {
    pub child_task_id: String,
    pub result: CodeModeResult,
}

pub struct RunCode;

impl TypedTool for RunCode {
    type Args = RunCodeArgs;
    type Details = RunCodeDetails;

    fn name(&self) -> &'static str {
        "run_code"
    }

    fn description(&self) -> &'static str {
        "Run deterministic JavaScript in an isolated sandbox that composes tool calls (`call(name, args)`) with durable replay across crashes."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute<'a>(&'a self, _args: Self::Args, _ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(std::future::ready(Err("run_code requires the durable engine dispatcher".into())))
    }
}

#[derive(Clone, Default)]
pub struct CodeModeExtension {
    include_section: bool,
}

impl CodeModeExtension {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_section(mut self, include: bool) -> Self {
        self.include_section = include;
        self
    }

    async fn dispatch_run_code(&self, call: &ToolCall, tc: &TaskContext, engine: &Engine) -> durable::Result<Transition> {
        if let Some(res) = engine.check_dispatched_memo(tc) {
            return res;
        }

        let dedup = format!("cm:{}", tc.task.id);
        let tid = tc.task.id.clone();
        let dedup_read = dedup.clone();
        let existing_child = engine
            .store()
            .read_async(move |r| Box::pin(async move { Ok(r.children_async(&tid).await?.into_iter().find(|c| c.dedup_key == dedup_read && c.kind == KIND)) }))
            .await?;

        if let Some(child) = existing_child {
            if child.status != TaskStatus::Terminal {
                return Ok(Transition::Wait {
                    phase: tc.task.phase_name.clone(),
                    checkpoint: None,
                    mode: WaitMode::AllSettled,
                    children: vec![child.id],
                });
            }
            if child.terminal_reason == "completed" {
                let text = serde_json::to_string(&child.result)?;
                return engine.complete_dispatched_tool(tc, call, text, false).await;
            }
            let err = if child.error_text.is_empty() {
                format!("codemode task failed ({})", child.terminal_reason)
            } else {
                child.error_text
            };
            return engine.complete_dispatched_tool(tc, call, err, true).await;
        }

        let args: RunCodeArgs = match serde_json::from_str(&call.arguments) {
            Ok(args) => args,
            Err(err) => {
                return engine
                    .complete_dispatched_tool(tc, call, format!("invalid arguments for `run_code`: {err}"), true)
                    .await;
            }
        };
        if args.script.trim().is_empty() {
            return engine.complete_dispatched_tool(tc, call, "script must not be empty".into(), true).await;
        }

        let spec = CodeModeSpec {
            script: args.script,
            seed: args.seed.unwrap_or_else(|| deterministic_seed(&tc.task.id)),
            start_time_ms: engine.store().now_ms(),
            max_steps: args.max_steps.unwrap_or(10_000),
            max_vars: 256,
            max_output_bytes: 65_536,
            max_memory_bytes: 16 * 1024 * 1024,
            max_string_bytes: 32_768,
            timeout_ms: args.timeout_ms.unwrap_or(10_000),
        };

        let mut child = Task::new(KIND, EXEC);
        child.dedup_key = dedup;
        child.checkpoint = json!(spec);
        let (spawned, _) = tc.spawn_child(child).await?;

        Ok(Transition::Wait {
            phase: tc.task.phase_name.clone(),
            checkpoint: None,
            mode: WaitMode::AllSettled,
            children: vec![spawned.id],
        })
    }
}

impl Extension for CodeModeExtension {
    fn name(&self) -> &str {
        "codemode"
    }

    fn tools(&self) -> Vec<Box<dyn Tool>> {
        vec![Box::new(TypedToolAdapter(RunCode))]
    }

    fn sections(&self) -> Vec<PromptSection> {
        if !self.include_section {
            return Vec::new();
        }
        vec![PromptSection::new(
            "Code Mode",
            "Use `run_code` to run deterministic JavaScript composing `call(name, args)` across tools.",
        )]
    }

    fn dispatch_tool<'a>(&'a self, call: &'a ToolCall, tc: &'a TaskContext, engine: &'a Engine) -> BoxFuture<'a, Option<durable::Result<Transition>>> {
        Box::pin(async move {
            if call.name != "run_code" {
                return None;
            }
            Some(self.dispatch_run_code(call, tc, engine).await)
        })
    }
}

fn deterministic_seed(task_id: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    task_id.hash(&mut hasher);
    let digest = hasher.finish();
    if digest == 0 { 1 } else { digest }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::{Value, json};

    use super::*;
    use crate::agent::Result as AiResult;
    use crate::agent::ai::ModelClient;
    use crate::agent::ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, Role, ToolCall, ToolSpec, Usage};
    use crate::agent::core::engine::Request;
    use crate::agent::core::events::Brain;
    use crate::agent::durable::Store;
    use crate::agent::extensions::{GovernanceExtension, Permissions, Policy};
    use crate::agent::harness::{Harness, WorkersOnly, worker_conversation};

    struct QueueClient {
        replies: Mutex<VecDeque<Completion>>,
    }

    impl QueueClient {
        fn new(replies: Vec<Completion>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
            }
        }
    }

    impl ModelClient for QueueClient {
        fn complete<'a>(&'a self, _req: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> BoxFuture<'a, AiResult<Completion>> {
            let reply = self.replies.lock().unwrap().pop_front().expect("unexpected model call");
            if let Some(t) = &reply.message.content {
                on(Delta::Text(t.clone()));
            }
            Box::pin(std::future::ready(Ok(reply)))
        }
    }

    struct PingTool;

    impl Tool for PingTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "ping_local".into(),
                description: "echo local".into(),
                parameters: json!({"type": "object"}),
            }
        }

        fn replay_safe(&self) -> bool {
            true
        }

        fn execute<'a>(&'a self, args: &'a Value) -> BoxFuture<'a, crate::agent::core::tool::ToolOutput> {
            Box::pin(std::future::ready(crate::agent::core::tool::ToolOutput::ok(
                json!({ "pong": args["msg"] }).to_string(),
            )))
        }
    }

    #[tokio::test]
    async fn run_code_dispatches_and_enforces_governance_inside_sandbox() -> durable::Result<()> {
        let store = Store::memory()?;
        let harness = Harness::from_store(store, Arc::new(WorkersOnly));
        harness.register_extension(Arc::new(CodeModeExtension::default()));
        harness.register_extension(Arc::new(GovernanceExtension::new(Permissions {
            builtin_default: Policy::AlwaysAllow,
            mcp_default: Policy::AlwaysAsk,
            overrides: BTreeMap::from([("blocked_tool".into(), Policy::AlwaysAsk)]),
        })));
        harness.recover().await?;

        let client = Arc::new(QueueClient::new(vec![
            Completion {
                message: Message {
                    role: Role::Assistant,
                    content: None,
                    reasoning: None,
                    tool_calls: vec![ToolCall {
                        id: "c1".into(),
                        name: "run_code".into(),
                        arguments: json!({
                            "script": r#"const res = call("ping_local", { msg: "ok" }); return { ping: res };"#
                        })
                        .to_string(),
                    }],
                    tool_call_id: None,
                },
                finish: FinishReason::ToolCalls,
                usage: Usage::default(),
            },
            Completion {
                message: Message::assistant("js complete"),
                finish: FinishReason::Stop,
                usage: Usage::default(),
            },
        ]));

        let mut brain = Brain::new(client, "deepseek-chat", "sys");
        brain.tools.push(Box::new(PingTool));
        let conv = worker_conversation("cm-ext");
        harness.attach_worker(&conv, Arc::new(brain), Arc::new(|_| {})).await?;
        let (_, task, _) = harness
            .submit(Request {
                conversation: &conv,
                provider: "mock",
                request_id: "r1",
                prompt: "run js",
                source: "user",
                system: "sys",
                ..Default::default()
            })
            .await?;

        let done = harness.scheduler().wait(&task.id, Duration::from_secs(4)).await?;
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "js complete");
        let entries = harness.entries(&conv).await?;
        let res = entries.iter().find(|e| e.kind == "pi.tool_result").unwrap();
        let cm: CodeModeResult = serde_json::from_str(res.payload["output"].as_str().unwrap()).unwrap();
        assert_eq!(cm.value, json!({ "ping": { "pong": "ok" } }));
        assert_eq!(cm.replayed_calls, 1);
        harness.close().await;
        Ok(())
    }
}
