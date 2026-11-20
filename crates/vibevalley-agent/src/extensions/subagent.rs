use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ai::types::ToolCall;
use crate::core::engine::{Engine, KIND as GENERATION_KIND, Request};
use crate::core::events::AgentEvent;
use crate::core::extension::{Extension, HookOutcome, ToolCallHookCtx};
use crate::core::inbox::WhenBusy;
use crate::core::pipeline::Transcript;
use crate::core::tool::{ReplayPolicy, Tool, ToolContext, TypedTool, TypedToolAdapter, TypedToolOutput};
use crate::durable::{self, Read, SubmissionStatus, TaskContext, Transition};

const SETTLED_SIGNAL: &str = "pi.submission_settled";

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SpawnAgentArgs {
    /// Clear, self-contained instructions for what the helper should do and report back.
    pub brief: String,
    /// Optional short label for the helper task.
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAgentDetails {
    pub child_conversation_id: String,
    pub output: String,
}

pub struct SpawnAgent {
    pub parent: String,
}

impl TypedTool for SpawnAgent {
    type Args = SpawnAgentArgs;
    type Details = SpawnAgentDetails;

    fn name(&self) -> &'static str {
        "spawn_agent"
    }

    fn description(&self) -> &'static str {
        "派一个帮手去做一件独立的事（查资料、读一片代码、改一个模块、跑一组检查），它做完把结果汇报给你。它看不到你们的对话：brief 里写清楚要做什么、在哪、做到什么程度算完、汇报什么。几件互不相干的事可以在同一步里派几个，它们会同时做。"
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute(&self, _args: Self::Args, _ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String> {
        Err("spawn_agent requires the durable engine dispatcher".into())
    }
}

#[derive(Clone)]
pub struct SubagentExtension {
    parent: String,
    expose_tools: bool,
}

impl Default for SubagentExtension {
    fn default() -> Self {
        Self::new("VibeValley")
    }
}

impl SubagentExtension {
    pub fn new(parent: impl Into<String>) -> Self {
        Self {
            parent: parent.into(),
            expose_tools: true,
        }
    }

    pub fn without_global_tools(mut self) -> Self {
        self.expose_tools = false;
        self
    }

    fn helper_system(&self) -> String {
        format!(
            "你是「{}」派出去的帮手，只做下面交代的这一件事，做完就停。\n- 不能问问题：信息不够就按最合理的理解去做，在汇报里说明你的理解。\n- 最后用一段话汇报：做了什么、结果是什么（要点、改过的文件、关键的数字）、没做成的和原因。你的最后一段话就是交回去的全部内容。",
            self.parent
        )
    }
}

fn last_assistant_answer(tx: &Read<'_>, conv: &str) -> durable::Result<String> {
    let entries = tx.visible_entries(conv)?;
    let tr = Transcript {
        conversation_id: conv.to_owned(),
        provider_affinity: String::new(),
        entries,
        prefix_hash: String::new(),
    };
    Ok(tr
        .agent_messages()
        .into_iter()
        .rev()
        .find(|m| m.kind == "pi.assistant")
        .and_then(|m| m.message.content)
        .unwrap_or_default())
}

impl Extension for SubagentExtension {
    fn name(&self) -> &str {
        "subagent"
    }

    fn tools(&self) -> Vec<Box<dyn Tool>> {
        if self.expose_tools {
            vec![Box::new(TypedToolAdapter(SpawnAgent { parent: self.parent.clone() }))]
        } else {
            vec![]
        }
    }

    fn on_before_tool(&self, ctx: &ToolCallHookCtx<'_>) -> durable::Result<HookOutcome> {
        if ctx.tool_name == "spawn_agent" && ctx.conversation_id.starts_with("subagent:") {
            return Ok(HookOutcome::Deny {
                reason: "helpers cannot nest spawn_agent".into(),
                overridable: false,
            });
        }
        Ok(HookOutcome::Continue)
    }

    fn dispatch_tool(&self, call: &ToolCall, tc: &TaskContext, engine: &Engine) -> Option<durable::Result<Transition>> {
        if call.name != "spawn_agent" {
            return None;
        }
        Some(self.dispatch_spawn(call, tc, engine))
    }
}

impl SubagentExtension {
    fn dispatch_spawn(&self, call: &ToolCall, tc: &TaskContext, engine: &Engine) -> durable::Result<Transition> {
        if let Some(res) = engine.check_dispatched_memo(tc) {
            return res;
        }

        let args: SpawnAgentArgs = match serde_json::from_str(&call.arguments) {
            Ok(args) => args,
            Err(err) => {
                return engine.complete_dispatched_tool(tc, call, format!("invalid arguments for `spawn_agent`: {err}"), true);
            }
        };
        let brief = args.brief.trim().to_owned();
        if brief.is_empty() {
            return engine.complete_dispatched_tool(tc, call, "brief 是空的。".into(), true);
        }

        let parent_conv = &tc.task.conversation_id;
        let tool_task_id = &tc.task.id;
        let request_id = format!("spawn:{tool_task_id}");
        let child_conv = format!("subagent:{tool_task_id}");

        let existing = engine.store().read(|tx| {
            let provider = tx.conversation(parent_conv)?.provider_affinity;
            let owned = tx.conversations_by_owner_task(tool_task_id)?;
            let existing_conv = owned.into_iter().find(|c| c.id == child_conv).map(|c| c.id);
            let sub = match existing_conv {
                Some(ref cid) => tx.submission_by_request(cid, &request_id)?,
                None => None,
            };
            let answer = match &sub {
                Some(s) if s.status == SubmissionStatus::Done => Some(last_assistant_answer(tx, &child_conv)?),
                _ => None,
            };
            let child_task_id = tx
                .tasks_by_conversation(&child_conv)
                .ok()
                .and_then(|tasks| tasks.into_iter().find(|t| t.kind == GENERATION_KIND).map(|t| t.id));
            Ok((provider, sub, answer, child_task_id))
        })?;

        let (provider, sub, answer, existing_child_task_id) = existing;
        if let Some(sub) = sub {
            match sub.status {
                SubmissionStatus::Done => {
                    let answer_text = answer
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| sub.result["output"].as_str().map(str::to_owned))
                        .unwrap_or_default();
                    let child_tid = existing_child_task_id.unwrap_or_else(|| format!("gen-{}", sub.id));
                    if answer_text.trim().is_empty() {
                        engine.emit(
                            parent_conv,
                            tool_task_id,
                            AgentEvent::SubagentStatusChanged {
                                child_conversation_id: child_conv,
                                task_id: child_tid,
                                status: "errored".into(),
                                message: "帮手没有返回内容。".into(),
                            },
                        );
                        return engine.complete_dispatched_tool(tc, call, "帮手没有返回内容。".into(), true);
                    }
                    engine.emit(
                        parent_conv,
                        tool_task_id,
                        AgentEvent::SubagentStatusChanged {
                            child_conversation_id: child_conv,
                            task_id: child_tid,
                            status: "completed".into(),
                            message: answer_text.clone(),
                        },
                    );
                    return engine.complete_dispatched_tool(tc, call, answer_text, false);
                }
                SubmissionStatus::Unanswered => {
                    let child_tid = existing_child_task_id.unwrap_or_else(|| format!("gen-{}", sub.id));
                    let err = sub.result["error"].as_str().unwrap_or("subagent failed").to_owned();
                    engine.emit(
                        parent_conv,
                        tool_task_id,
                        AgentEvent::SubagentStatusChanged {
                            child_conversation_id: child_conv,
                            task_id: child_tid,
                            status: "errored".into(),
                            message: err.clone(),
                        },
                    );
                    return engine.complete_dispatched_tool(tc, call, format!("帮手出错：{err}"), true);
                }
                SubmissionStatus::Queued | SubmissionStatus::Placed => {
                    return Ok(Transition::Sleep {
                        phase: tc.task.phase_name.clone(),
                        checkpoint: None,
                        until_ms: None,
                        signal: Some(SETTLED_SIGNAL.into()),
                    });
                }
            }
        }

        let system = self.helper_system();
        engine.emit(
            parent_conv,
            tool_task_id,
            AgentEvent::ToolStart {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            },
        );
        let (_, child_task, _) = engine.submit(Request {
            conversation: &child_conv,
            provider: &provider,
            request_id: &request_id,
            prompt: &brief,
            source: "subagent",
            system: &system,
            notify_task: Some(tool_task_id),
            owner_task: Some(tool_task_id),
            when_busy: WhenBusy::Reject,
            ..Default::default()
        })?;

        engine.emit(
            parent_conv,
            tool_task_id,
            AgentEvent::SubagentSpawned {
                parent_conversation_id: parent_conv.clone(),
                child_conversation_id: child_conv.clone(),
                task_id: child_task.id.clone(),
                label: args.label.unwrap_or_default(),
                brief,
            },
        );
        engine.emit(
            parent_conv,
            tool_task_id,
            AgentEvent::SubagentStatusChanged {
                child_conversation_id: child_conv,
                task_id: child_task.id,
                status: "running".into(),
                message: String::new(),
            },
        );

        Ok(Transition::Sleep {
            phase: tc.task.phase_name.clone(),
            checkpoint: None,
            until_ms: None,
            signal: Some(SETTLED_SIGNAL.into()),
        })
    }
}
