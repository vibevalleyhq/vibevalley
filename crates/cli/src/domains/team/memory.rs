//! `memory list|search|create|delete`.

use clap::{Args, Subcommand};
use vibevalley_protocol::{Memory, MemoryCreateInput, MemoryDeleteInput, MemoryListInput, MemorySearchInput, ops};

use crate::client::{Client, Done};
use crate::output::{line, one_line};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct MemoryCmd {
    #[command(subcommand)]
    pub action: MemoryAction,
}

#[derive(Debug, Subcommand)]
pub enum MemoryAction {
    /// List memories stored for an agent
    #[command(after_help = "Examples:\n  vibevalley memory list docs")]
    List {
        /// Agent profile id
        agent: String,
    },
    /// Search memories across agents
    #[command(after_help = "Examples:\n  vibevalley memory search release checklist --agent docs")]
    Search {
        /// Search terms
        #[arg(required = true, num_args = 1..)]
        words: Vec<String>,
        /// Filter by agent profile id
        #[arg(long)]
        agent: Option<String>,
        /// Filter by repository name
        #[arg(long)]
        repo: Option<String>,
    },
    /// Record a new memory for an agent
    #[command(after_help = "Examples:\n  vibevalley memory create docs 'write docs in plain English'")]
    Create {
        /// Agent profile id
        agent: String,
        /// Memory text
        #[arg(required = true, num_args = 1..)]
        words: Vec<String>,
        /// Scope memory to a repository
        #[arg(long)]
        repo: Option<String>,
        /// Idempotency key
        #[arg(long)]
        key: Option<String>,
    },
    /// Delete a stored memory
    #[command(after_help = "Examples:\n  vibevalley memory delete docs m1 --dry-run")]
    Delete {
        /// Agent profile id
        agent: String,
        /// Memory id
        memory: String,
    },
}

fn memory_line(memory: &Memory) -> String {
    let repo = memory.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
    line(&[&memory.id, &format!("@{}", memory.agent), memory.kind.as_str(), &repo, &one_line(&memory.text)])
}

pub fn run(client: &Client, cmd: MemoryCmd) -> Done {
    match cmd.action {
        MemoryAction::List { agent } => {
            let found = client.ask::<ops::MemoryList>(&MemoryListInput { agent })?;
            client
                .output
                .show(&found, |list| list.memories.iter().map(memory_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        MemoryAction::Search { words, agent, repo } => {
            let request = MemorySearchInput {
                text: Some(words.join(" ")),
                agent,
                repo,
            };
            let found = client.ask::<ops::MemorySearch>(&request)?;
            client.output.show(&found, |hits| {
                hits.found
                    .iter()
                    .map(|m| {
                        let repo = m.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
                        line(&[&m.id, &format!("@{}", m.agent), m.kind.as_str(), &repo, &one_line(&m.text)])
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            Ok(())
        }
        MemoryAction::Create { agent, words, repo, key } => {
            let request = MemoryCreateInput {
                agent,
                text: words.join(" "),
                repo,
                request_key: key,
            };
            client.mutate::<ops::MemoryCreate>("memory create", &request, memory_line)
        }
        MemoryAction::Delete { agent, memory } => {
            let id = memory.clone();
            client.mutate::<ops::MemoryDelete>("memory delete", &MemoryDeleteInput { agent, memory }, |_| format!("deleted {id}"))
        }
    }
}
