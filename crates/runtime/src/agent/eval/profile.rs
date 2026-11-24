//! Agent evaluation profiles and autonomous harness wiring aligned with `pi-eval`.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::BoxFuture;
use crate::agent::ai::ModelClient;
use crate::agent::ai::models::DEFAULT_MODEL;
use crate::agent::core::doc::{BudgetConfig, CONVERSATION_SCOPE, GovernanceDoc, update_doc};
use crate::agent::core::engine::BrainProvider;
use crate::agent::core::events::Brain;
use crate::agent::core::tool::{Tool, TypedToolAdapter};
use crate::agent::durable::{Result, Store};
use crate::agent::experiments::ExperimentFlags;
use crate::agent::extensions::budget::BudgetExtension;
use crate::agent::extensions::subagent::{SpawnAgent, SubagentExtension};
use crate::agent::extensions::todo::{TodoExtension, todo_tools};
use crate::agent::harness::Harness;
use crate::agent::tools::{Workspace, coding_tools, read_only_tools};

pub const DEFAULT_EVAL_SYSTEM: &str = "You are a careful software engineer working in the user's repository through tools. \
    Read before you change; keep changes small and focused; run tests when they exist; \
    say plainly what you did and what you could not do.";

fn default_true() -> bool {
    true
}

fn default_model() -> String {
    DEFAULT_MODEL.into()
}

fn default_system_prompt() -> String {
    DEFAULT_EVAL_SYSTEM.into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EvalProfile {
    pub name: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub system_prompt: String,
    pub read_only: bool,
    pub experiments: ExperimentFlags,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_cost_micros: Option<i64>,
    pub enable_todo: bool,
    pub enable_subagents: bool,
}

impl Default for EvalProfile {
    fn default() -> Self {
        Self {
            name: "vanilla".into(),
            model: default_model(),
            effort: None,
            system_prompt: default_system_prompt(),
            read_only: false,
            experiments: ExperimentFlags::default(),
            max_cost_micros: None,
            enable_todo: default_true(),
            enable_subagents: default_true(),
        }
    }
}

impl EvalProfile {
    pub fn vanilla() -> Self {
        Self::default()
    }

    pub fn codemode() -> Self {
        Self {
            name: "codemode".into(),
            experiments: ExperimentFlags {
                codemode: true,
                ..ExperimentFlags::default()
            },
            ..Self::default()
        }
    }
}

/// Builds workspace tools for an evaluation profile without interactive approval gates.
pub fn build_profile_tools(profile: &EvalProfile, workspace: &Path) -> Vec<Box<dyn Tool>> {
    let ws = Workspace::new(workspace);
    let mut tools = if profile.read_only { read_only_tools(&ws) } else { coding_tools(&ws) };
    if profile.enable_todo {
        tools.extend(todo_tools(Default::default()));
    }
    if profile.enable_subagents && !profile.read_only {
        tools.push(Box::new(TypedToolAdapter(SpawnAgent { parent: "VibeValley".into() })));
    }
    tools
}

pub fn mount_profile_extensions(harness: &Harness, profile: &EvalProfile, _workspace: &Path, _client: Arc<dyn ModelClient>) {
    if profile.max_cost_micros.is_some() {
        harness.register_extension(Arc::new(BudgetExtension));
    }
    if profile.enable_todo {
        harness.register_extension(Arc::new(TodoExtension::default().without_global_tools()));
    }
    if profile.enable_subagents && !profile.read_only {
        harness.register_extension(Arc::new(SubagentExtension::new("VibeValley").without_global_tools()));
    }
    harness.with_experiments(&profile.experiments, None);
}

pub(crate) async fn configure_profile_budget(store: &Store, conv_id: &str, profile: &EvalProfile) -> Result<()> {
    let Some(max_cost_micros) = profile.max_cost_micros else {
        return Ok(());
    };
    let conv_id = conv_id.to_owned();
    let model = profile.model.clone();
    store
        .write_async(move |tx| {
            Box::pin(async move {
                if tx.conversation_async(&conv_id).await.is_err() {
                    tx.create_conversation_async(&conv_id, &model).await?;
                }
                update_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, &conv_id, |gov| {
                    gov.budget = Some(BudgetConfig { max_cost_micros });
                    Ok(())
                })
                .await?;
                Ok(())
            })
        })
        .await
}

pub(crate) struct EvalBrainProvider {
    profile: EvalProfile,
    workspace: std::path::PathBuf,
    client: Arc<dyn ModelClient>,
}

impl EvalBrainProvider {
    pub fn new(profile: EvalProfile, workspace: &Path, client: Arc<dyn ModelClient>) -> Self {
        Self {
            profile,
            workspace: workspace.to_path_buf(),
            client,
        }
    }
}

impl BrainProvider for EvalBrainProvider {
    fn resolve_brain<'a>(&'a self, _conv: &'a str, provider: &'a str) -> BoxFuture<'a, Result<Option<Arc<Brain>>>> {
        let model = if provider.is_empty() { self.profile.model.as_str() } else { provider };
        let mut brain = Brain::new(self.client.clone(), model, &self.profile.system_prompt);
        brain.effort = self.profile.effort.clone();
        brain.cwd = Some(self.workspace.clone());
        brain.tools = build_profile_tools(&self.profile, &self.workspace);
        Box::pin(std::future::ready(Ok(Some(Arc::new(brain)))))
    }
}
