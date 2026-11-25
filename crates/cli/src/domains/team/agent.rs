//! `agent list|create|update|delete`.

use clap::{ArgAction, Args, Subcommand, ValueEnum};
use vibevalley_protocol::{Agent, AgentDeleteInput, AgentRole, Build, Head, Look, OrchestratorLook, Outfit, PersonaMode, Species, ops};

use crate::client::{Client, Done, Failure, exit};
use crate::output::line;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum RoleArg {
    Worker,
    Orchestrator,
}

impl From<RoleArg> for AgentRole {
    fn from(value: RoleArg) -> Self {
        match value {
            RoleArg::Worker => AgentRole::Worker,
            RoleArg::Orchestrator => AgentRole::Orchestrator,
        }
    }
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct AgentCmd {
    #[command(subcommand)]
    pub action: AgentAction,
}

#[derive(Debug, Subcommand)]
pub enum AgentAction {
    /// List agent profiles
    #[command(after_help = "Examples:\n  vibevalley agent list")]
    List,
    /// Create a new agent profile
    #[command(after_help = "Examples:\n  vibevalley agent create fox --runtime claude")]
    Create {
        /// Display name for the agent
        name: String,
        /// Coding runtime id
        #[arg(long, default_value = "vibevalley")]
        runtime: String,
        /// Agent role
        #[arg(long, value_enum, default_value_t = RoleArg::Worker)]
        role: RoleArg,
        /// One-sentence responsibility summary
        #[arg(long, default_value = "")]
        duty: String,
        /// Model name override
        #[arg(long, default_value = "")]
        model: String,
        /// Reasoning effort override
        #[arg(long, default_value = "")]
        effort: String,
    },
    /// Update fields on an existing agent profile
    #[command(after_help = "Examples:\n  vibevalley agent update docs --duty 'Maintain docs' --enabled true")]
    Update {
        /// Agent profile id
        agent: String,
        /// New display name
        #[arg(long)]
        name: Option<String>,
        /// New coding runtime id
        #[arg(long)]
        runtime: Option<String>,
        /// New responsibility summary
        #[arg(long)]
        duty: Option<String>,
        /// New model override
        #[arg(long)]
        model: Option<String>,
        /// New reasoning effort override
        #[arg(long)]
        effort: Option<String>,
        /// Enable or disable the profile (true or false)
        #[arg(long, action = ArgAction::Set)]
        enabled: Option<bool>,
    },
    /// Delete an agent profile
    #[command(after_help = "Examples:\n  vibevalley agent delete docs --dry-run")]
    Delete {
        /// Agent profile id
        agent: String,
    },
}

fn agent_line(agent: &Agent) -> String {
    line(&[
        &agent.id,
        &agent.name,
        agent.role.as_str(),
        &agent.runtime,
        if agent.enabled { "" } else { "off" },
    ])
}

fn default_look(role: AgentRole) -> Look {
    Look {
        orchestrator: (role == AgentRole::Orchestrator).then_some(OrchestratorLook::Farmer),
        species: (role == AgentRole::Worker).then_some(Species::Fox),
        outfit: (role == AgentRole::Worker).then_some(Outfit::Farmer),
        build: Build::Biped,
        head: Head::Rounded,
        body: String::new(),
        trim: String::new(),
        hat: String::new(),
        eye: String::new(),
        avatar: None,
    }
}

pub async fn run(client: &Client, cmd: AgentCmd) -> Done {
    match cmd.action {
        AgentAction::List => {
            let agents = client.ask::<ops::AgentList>(&()).await?;
            client.output.show(&agents, |a| a.iter().map(agent_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        AgentAction::Create {
            name,
            runtime,
            role,
            duty,
            model,
            effort,
        } => {
            let role: AgentRole = role.into();
            let profile = Agent {
                id: String::new(),
                name,
                role,
                duty,
                enabled: true,
                runtime,
                machine_id: None,
                model,
                effort,
                persona: String::new(),
                persona_mode: PersonaMode::Append,
                skills: vec![],
                mcp_servers: vec![],
                disallowed_tools: vec![],
                env: Default::default(),
                workdir: String::new(),
                worktree: true,
                tags: vec![],
                look: default_look(role),
                from: None,
            };
            client.mutate::<ops::AgentCreate>("agent create", &profile, agent_line).await
        }
        AgentAction::Update {
            agent,
            name,
            runtime,
            duty,
            model,
            effort,
            enabled,
        } => {
            if name.is_none() && runtime.is_none() && duty.is_none() && model.is_none() && effort.is_none() && enabled.is_none() {
                return Err(Failure::usage("MissingArgument", "provide at least one field to update"));
            }
            let agents = client.ask::<ops::AgentList>(&()).await?;
            let Some(mut profile) = agents.into_iter().find(|a| a.id == agent) else {
                return Err(Failure::new(exit::MISSING, "Missing", format!("agent {agent:?} not found")));
            };
            if let Some(v) = name {
                profile.name = v;
            }
            if let Some(v) = runtime {
                profile.runtime = v;
            }
            if let Some(v) = duty {
                profile.duty = v;
            }
            if let Some(v) = model {
                profile.model = v;
            }
            if let Some(v) = effort {
                profile.effort = v;
            }
            if let Some(v) = enabled {
                profile.enabled = v;
            }
            client.mutate::<ops::AgentUpdate>("agent update", &profile, agent_line).await
        }
        AgentAction::Delete { agent } => {
            let id = agent.clone();
            client
                .mutate::<ops::AgentDelete>("agent delete", &AgentDeleteInput { id: agent }, |_| format!("deleted {id}"))
                .await
        }
    }
}
