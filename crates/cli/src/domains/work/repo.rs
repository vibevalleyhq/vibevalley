//! `repo list|create|mount|unmount` and `repo pr submit`.

use clap::{Args, Subcommand};
use vibevalley_protocol::{MountRepo, NewRepo, RepoHealthStatus, RepoSummary, RepoUnmountInput, SubmitBranch, ops};

use crate::client::{Client, Done};
use crate::output::line;

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct RepoCmd {
    #[command(subcommand)]
    pub action: RepoAction,
}

#[derive(Debug, Subcommand)]
pub enum RepoAction {
    /// List registered repositories
    #[command(after_help = "Examples:\n  vibevalley repo list")]
    List,
    /// Create or clone a repository under the workspace root
    #[command(after_help = "Examples:\n  vibevalley repo create clock\n  vibevalley repo create web --github https://github.com/me/web")]
    Create {
        /// Repository name
        name: String,
        /// Optional GitHub repository URL to clone
        #[arg(long)]
        github: Option<String>,
    },
    /// Mount an existing local repository folder into the workspace
    #[command(after_help = "Examples:\n  vibevalley repo mount /path/to/project\n  vibevalley repo mount /path/to/folder --name demo --init-git")]
    Mount {
        /// Local directory path
        path: String,
        /// Optional repository name override
        #[arg(long)]
        name: Option<String>,
        /// Initialize a Git repository if the folder is not one yet
        #[arg(long)]
        init_git: bool,
    },
    /// Unmount an external local repository without deleting files on disk
    #[command(after_help = "Examples:\n  vibevalley repo unmount demo")]
    Unmount {
        /// Repository name to unmount
        id: String,
    },
    /// Pull request publishing commands
    Pr(RepoPrCmd),
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct RepoPrCmd {
    #[command(subcommand)]
    pub action: RepoPrAction,
}

#[derive(Debug, Subcommand)]
pub enum RepoPrAction {
    /// Push a branch and open a pull request
    #[command(
        after_help = "Examples:\n  vibevalley repo pr submit --cwd /path/to/repo --branch feat/topic --sha <sha> --base main --title <title> --body <body> --dry-run"
    )]
    Submit {
        /// Working tree directory
        #[arg(long)]
        cwd: String,
        /// Branch name to push
        #[arg(long)]
        branch: String,
        /// Expected HEAD commit SHA
        #[arg(long)]
        sha: String,
        /// Target base branch
        #[arg(long)]
        base: String,
        /// Pull request title
        #[arg(long)]
        title: String,
        /// Pull request body
        #[arg(long)]
        body: String,
    },
}

fn health_status_str(status: RepoHealthStatus) -> &'static str {
    match status {
        RepoHealthStatus::OnTrack => "on_track",
        RepoHealthStatus::AtRisk => "at_risk",
        RepoHealthStatus::OffTrack => "off_track",
    }
}

fn repo_line(repo: &RepoSummary) -> String {
    let health = repo.health.as_ref().map(|h| health_status_str(h.status)).unwrap_or("");
    line(&[
        &repo.name,
        &repo.path,
        if repo.git { "git" } else { "" },
        if repo.pull_request.available { "pr" } else { "" },
        health,
    ])
}

pub async fn run(client: &Client, cmd: RepoCmd) -> Done {
    match cmd.action {
        RepoAction::List => {
            let repos = client.ask::<ops::RepoList>(&()).await?;
            client.output.show(&repos, |rs| rs.iter().map(repo_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        RepoAction::Create { name, github } => {
            let request = NewRepo { name, github };
            client.mutate::<ops::RepoCreate>("repo create", &request, repo_line).await
        }
        RepoAction::Mount { path, name, init_git } => {
            let request = MountRepo {
                path,
                name,
                init_git: init_git.then_some(true),
            };
            client.mutate::<ops::RepoMount>("repo mount", &request, repo_line).await
        }
        RepoAction::Unmount { id } => {
            let request = RepoUnmountInput { id: id.clone() };
            client.mutate::<ops::RepoUnmount>("repo unmount", &request, |_| format!("unmounted {id}")).await
        }
        RepoAction::Pr(pr) => match pr.action {
            RepoPrAction::Submit {
                cwd,
                branch,
                sha,
                base,
                title,
                body,
            } => {
                // `repo.pr.submit` handles preview inline via `SubmitBranch.dry_run`.
                let request = SubmitBranch {
                    cwd,
                    branch,
                    sha,
                    base,
                    title,
                    body,
                    dry_run: Some(client.dry_run),
                };
                let result = client.ask::<ops::RepoPrSubmit>(&request).await?;
                client.output.show(&result, |r| match &r.url {
                    Some(url) => format!("{url}\ncheck: {}", r.check.as_str()),
                    None => format!("preview: {} ({}) -> {}", r.branch, r.sha, r.base),
                });
                Ok(())
            }
        },
    }
}
