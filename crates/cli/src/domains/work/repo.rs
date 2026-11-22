//! `repo list|create` and `repo pr submit`.

use clap::{Args, Subcommand};
use vibevalley_protocol::{NewRepo, RepoSummary, SubmitBranch, ops};

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

fn repo_line(repo: &RepoSummary) -> String {
    line(&[
        &repo.name,
        &repo.path,
        if repo.git { "git" } else { "" },
        if repo.pull_request.available { "pr" } else { "" },
    ])
}

pub fn run(client: &Client, cmd: RepoCmd) -> Done {
    match cmd.action {
        RepoAction::List => {
            let repos = client.ask::<ops::RepoList>(&())?;
            client.output.show(&repos, |rs| rs.iter().map(repo_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        RepoAction::Create { name, github } => {
            let request = NewRepo { name, github };
            client.mutate::<ops::RepoCreate>("repo create", &request, repo_line)
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
                let result = client.ask::<ops::RepoPrSubmit>(&request)?;
                client.output.show(&result, |r| match &r.url {
                    Some(url) => format!("{url}\ncheck: {}", r.check.as_str()),
                    None => format!("preview: {} ({}) -> {}", r.branch, r.sha, r.base),
                });
                Ok(())
            }
        },
    }
}
