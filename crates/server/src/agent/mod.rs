//! Agent domain facade consolidating profiles, memory, MCP door/resources,
//! tool registry, and durable orchestrator.

pub mod mcp;
pub mod memory;
pub mod orchestrator;
pub mod profile;
pub mod tool;

use std::sync::Arc;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use vibevalley_protocol::{ApiError, BizCode, EndpointId, Op, ops};

use crate::gateway::api::CallerContext;

pub use mcp::{Mcp, Resource, ResourceReadArgs};
pub use memory::{By, FinishedRun, Memory, Note};
pub use orchestrator::{Execution, Input, Orchestrator, Parts as OrchestratorParts, Reply, RuntimeInboxObserver};
pub use profile::{AgentDriver, Profile, ProfileStore, RuntimeFleet, instructions};
pub use tool::{Held, Route, Tool, ToolRegistry, Who, held, helper, orchestrator as orchestrator_tools, unrun};

/// Unified facade grouping all agent-domain sub-services.
pub struct Agent {
    pub profile: Arc<Profile>,
    pub memory: Arc<Memory>,
    pub mcp: Arc<Mcp>,
    pub resource: Arc<Resource>,
    pub tool: Arc<ToolRegistry>,
    pub orchestrator: Arc<Orchestrator>,
}

impl Agent {
    pub fn new(
        profile: Arc<Profile>,
        memory: Arc<Memory>,
        mcp: Arc<Mcp>,
        resource: Arc<Resource>,
        tool: Arc<ToolRegistry>,
        orchestrator: Arc<Orchestrator>,
    ) -> Arc<Self> {
        Arc::new(Self {
            profile,
            memory,
            mcp,
            resource,
            tool,
            orchestrator,
        })
    }

    /// Cooperatively shuts down runtime probes and the orchestrator.
    pub async fn close_async(&self) {
        self.profile.close();
        self.orchestrator.close_async().await;
    }

    /// Domain router dispatch helper for all `Agent*`, `Skill*`, `Runtime*`,
    /// `Memory*`, and `Orchestrator*` endpoints.
    pub(crate) async fn dispatch_endpoint_async(&self, ctx: &CallerContext, id: EndpointId, payload: Value) -> Option<Result<Value, ApiError>> {
        match id {
            EndpointId::AgentList
            | EndpointId::AgentValidate
            | EndpointId::AgentCreate
            | EndpointId::AgentUpdate
            | EndpointId::AgentDelete
            | EndpointId::AgentPreviewDelete
            | EndpointId::AgentTemplateList
            | EndpointId::AgentTemplateInstall
            | EndpointId::AgentTemplateUpdate
            | EndpointId::AgentTemplateAdd
            | EndpointId::AgentTemplateDelete
            | EndpointId::AgentTemplatePreviewDelete
            | EndpointId::SkillList
            | EndpointId::SkillCreate
            | EndpointId::SkillUpdate
            | EndpointId::SkillDelete
            | EndpointId::SkillPreviewDelete
            | EndpointId::RuntimeList
            | EndpointId::RuntimeRefresh
            | EndpointId::RuntimeSettingUpdate => self.dispatch_profile_endpoint_async(id, payload).await,
            EndpointId::MemoryList
            | EndpointId::MemoryRecall
            | EndpointId::MemoryCreate
            | EndpointId::MemorySearch
            | EndpointId::MemoryDelete
            | EndpointId::MemoryPreviewDelete => self.dispatch_memory_endpoint_async(ctx, id, payload).await,
            EndpointId::OrchestratorOpen
            | EndpointId::OrchestratorStop
            | EndpointId::OrchestratorEvalCreate
            | EndpointId::OrchestratorApprovalList
            | EndpointId::OrchestratorApprovalResolve => self.dispatch_orchestrator_endpoint_async(id, payload).await,
            _ => None,
        }
    }

    /// Domain router dispatch helper for `Agent*`, `Skill*`, and `Runtime*` endpoints.
    pub(crate) async fn dispatch_profile_endpoint_async(&self, id: EndpointId, payload: Value) -> Option<Result<Value, ApiError>> {
        match id {
            EndpointId::AgentList => Some(ok_json(self.profile.all())),
            EndpointId::AgentValidate => Some(
                async {
                    let req: <ops::AgentValidate as Op>::Input = decode(payload)?;
                    ok_json(self.profile.validate_async(&req.agents).await)
                }
                .await,
            ),
            EndpointId::AgentCreate => Some(
                async {
                    let req: <ops::AgentCreate as Op>::Input = decode(payload)?;
                    ok_json(self.profile.agent_create_async(req).await?)
                }
                .await,
            ),
            EndpointId::AgentUpdate => Some(
                async {
                    let req: <ops::AgentUpdate as Op>::Input = decode(payload)?;
                    ok_json(self.profile.agent_update_async(req).await?)
                }
                .await,
            ),
            EndpointId::AgentDelete => Some(
                async {
                    let req: <ops::AgentDelete as Op>::Input = decode(payload)?;
                    self.profile.agent_delete_async(&req.id).await?;
                    Ok(Value::Null)
                }
                .await,
            ),
            EndpointId::AgentPreviewDelete => Some(
                async {
                    let req: <ops::AgentPreviewDelete as Op>::Input = decode(payload)?;
                    ok_json(self.profile.agent_preview_delete_async(&req.id).await?)
                }
                .await,
            ),
            EndpointId::AgentTemplateList => Some(ok_json(self.profile.templates())),
            EndpointId::AgentTemplateInstall => Some(
                async {
                    let req: <ops::AgentTemplateInstall as Op>::Input = decode(payload)?;
                    ok_json(self.profile.agent_template_install_async(&req.id, req.runtime.as_deref()).await?)
                }
                .await,
            ),
            EndpointId::AgentTemplateUpdate => Some(
                async {
                    let req: <ops::AgentTemplateUpdate as Op>::Input = decode(payload)?;
                    ok_json(self.profile.agent_template_update_async(&req.agent).await?)
                }
                .await,
            ),
            EndpointId::AgentTemplateAdd => Some(
                async {
                    let req: <ops::AgentTemplateAdd as Op>::Input = decode(payload)?;
                    ok_json(self.profile.agent_template_add_async(&req.path).await?)
                }
                .await,
            ),
            EndpointId::AgentTemplateDelete => Some(
                async {
                    let req: <ops::AgentTemplateDelete as Op>::Input = decode(payload)?;
                    self.profile.agent_template_delete_async(&req.id).await?;
                    Ok(Value::Null)
                }
                .await,
            ),
            EndpointId::AgentTemplatePreviewDelete => Some(
                async {
                    let req: <ops::AgentTemplatePreviewDelete as Op>::Input = decode(payload)?;
                    ok_json(self.profile.agent_template_preview_delete_async(&req.id).await?)
                }
                .await,
            ),
            EndpointId::SkillList => Some(ok_json(self.profile.skills())),
            EndpointId::SkillCreate => Some(
                async {
                    let req: <ops::SkillCreate as Op>::Input = decode(payload)?;
                    ok_json(self.profile.skill_create_async(req).await?)
                }
                .await,
            ),
            EndpointId::SkillUpdate => Some(
                async {
                    let req: <ops::SkillUpdate as Op>::Input = decode(payload)?;
                    ok_json(self.profile.skill_update_async(req).await?)
                }
                .await,
            ),
            EndpointId::SkillDelete => Some(
                async {
                    let req: <ops::SkillDelete as Op>::Input = decode(payload)?;
                    self.profile.skill_delete_async(&req.id).await?;
                    Ok(Value::Null)
                }
                .await,
            ),
            EndpointId::SkillPreviewDelete => Some(
                async {
                    let req: <ops::SkillPreviewDelete as Op>::Input = decode(payload)?;
                    ok_json(self.profile.skill_preview_delete_async(&req.id).await?)
                }
                .await,
            ),
            EndpointId::RuntimeList => Some(ok_json(self.profile.runtimes())),
            EndpointId::RuntimeRefresh => Some(
                async {
                    let req: <ops::RuntimeRefresh as Op>::Input = decode(payload)?;
                    ok_json(self.profile.runtime_refresh_async(&req.id).await?)
                }
                .await,
            ),
            EndpointId::RuntimeSettingUpdate => Some(
                async {
                    let req: <ops::RuntimeSettingUpdate as Op>::Input = decode(payload)?;
                    ok_json(
                        self.profile
                            .runtime_setting_update_async(
                                &req.id,
                                vibevalley_protocol::RuntimeSettings {
                                    enabled: req.enabled,
                                    bin_path: req.bin_path,
                                    default_model: req.default_model,
                                    default_effort: req.default_effort,
                                    env: req.env,
                                    daily_budget: req.daily_budget,
                                    max_working: req.max_working,
                                },
                            )
                            .await?,
                    )
                }
                .await,
            ),
            _ => None,
        }
    }

    /// Domain router dispatch helper for `Memory*` endpoints.
    pub(crate) async fn dispatch_memory_endpoint_async(&self, ctx: &CallerContext, id: EndpointId, payload: Value) -> Option<Result<Value, ApiError>> {
        match id {
            EndpointId::MemoryList => Some(
                async {
                    let req: <ops::MemoryList as Op>::Input = decode(payload)?;
                    ok_json(self.memory.list_endpoint_async(req).await?)
                }
                .await,
            ),
            EndpointId::MemoryRecall => Some(
                async {
                    let req: <ops::MemoryRecall as Op>::Input = decode(payload)?;
                    ok_json(self.memory.recall_endpoint_async(req).await?)
                }
                .await,
            ),
            EndpointId::MemoryCreate => Some(
                async {
                    let req: <ops::MemoryCreate as Op>::Input = decode(payload)?;
                    let client_id = ctx.client.as_ref().map(|c| c.id.as_str());
                    ok_json(self.memory.create_endpoint_async(ctx.caller, client_id, req).await?)
                }
                .await,
            ),
            EndpointId::MemorySearch => Some(
                async {
                    let req: <ops::MemorySearch as Op>::Input = decode(payload)?;
                    ok_json(self.memory.search_endpoint_async(req).await?)
                }
                .await,
            ),
            EndpointId::MemoryDelete => Some(
                async {
                    let req: <ops::MemoryDelete as Op>::Input = decode(payload)?;
                    self.memory.delete_endpoint_async(req).await?;
                    Ok(Value::Null)
                }
                .await,
            ),
            EndpointId::MemoryPreviewDelete => Some(
                async {
                    let req: <ops::MemoryPreviewDelete as Op>::Input = decode(payload)?;
                    ok_json(self.memory.preview_delete_endpoint_async(req).await?)
                }
                .await,
            ),
            _ => None,
        }
    }

    /// Domain router dispatch helper for `Orchestrator*` endpoints.
    pub(crate) async fn dispatch_orchestrator_endpoint_async(&self, id: EndpointId, payload: Value) -> Option<Result<Value, ApiError>> {
        match id {
            EndpointId::OrchestratorOpen => Some(
                async {
                    self.orchestrator.open_endpoint_async().await?;
                    Ok(Value::Null)
                }
                .await,
            ),
            EndpointId::OrchestratorStop => Some(
                async {
                    let req: <ops::OrchestratorStop as Op>::Input = decode(payload)?;
                    self.orchestrator.stop_endpoint_async(req).await?;
                    Ok(Value::Null)
                }
                .await,
            ),
            EndpointId::OrchestratorEvalCreate => Some(
                async {
                    let req: <ops::OrchestratorEvalCreate as Op>::Input = decode(payload)?;
                    ok_json(self.orchestrator.eval_create_endpoint_async(req).await?)
                }
                .await,
            ),
            EndpointId::OrchestratorApprovalList => Some(
                async {
                    let req: <ops::OrchestratorApprovalList as Op>::Input = decode(payload)?;
                    ok_json(self.orchestrator.approvals_endpoint_async(req).await?)
                }
                .await,
            ),
            EndpointId::OrchestratorApprovalResolve => Some(
                async {
                    let req: <ops::OrchestratorApprovalResolve as Op>::Input = decode(payload)?;
                    self.orchestrator.resolve_approval_endpoint_async(req).await?;
                    Ok(Value::Null)
                }
                .await,
            ),
            _ => None,
        }
    }
}

fn ok_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
    serde_path_to_error::deserialize(payload).map_err(|e| {
        let path = e.path().to_string();
        let problem = e.into_inner().to_string();
        let message = if path == "." || path.is_empty() {
            problem
        } else {
            format!("{path}: {problem}")
        };
        ApiError::new(BizCode::InvalidInput, message)
    })
}
