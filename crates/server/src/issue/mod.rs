//! Issues domain (`issue/`): the issue board (`Board`), lightweight state
//! coordination (`IssueState`), channel bridges (`IssueChat`, `SessionChat`),
//! pull request publication/polling (`Pull`), and all `Issue*` / `RepoPrSubmit`
//! router handlers.

mod actions;
pub mod board;
pub mod chat;
pub mod edit;
pub mod family;
pub mod pull;
pub mod refine;
mod session_chat;
pub mod starter;
pub mod store;
#[cfg(test)]
mod tests;

pub use actions::next_steps;
pub use board::{Board, NewIssue, Sent};
pub use chat::IssueChat;
pub use family::{ChildDraft, MAX_CHILDREN};
pub use pull::{
    Answer, GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, HostRun, HostedRepo, KnownPullEvent, Network, Publisher, Pull, PullIndex, PullRecord,
    UpsertPullInput, actions_job_of, checks_fingerprint, checks_verdict, hosted_origin,
};
pub use session_chat::SessionChat;
pub use store::{BoardConfig, BoardError, CronOfIssue, IssueChange, IssueState, Opened, PullOfIssue, Result, Step, Undelivered};

fn board_err(err: BoardError) -> vibevalley_protocol::ApiError {
    match err {
        BoardError::Api(e) => e,
        e => vibevalley_protocol::ApiError::new(vibevalley_protocol::BizCode::IssueRefused, e.to_string()),
    }
}

impl crate::context::port::CronBoardPort for Board {
    fn set_cron_of_issue<'a>(&'a self, lookup: crate::context::port::CronLookupFn) -> crate::BoxFuture<'a, ()> {
        Box::pin(self.use_cron_of_issue_async(lookup))
    }

    fn refresh_issue_async<'a>(&'a self, id: &'a str) -> crate::BoxFuture<'a, ()> {
        Box::pin(self.refresh_issue_async(id))
    }

    fn issue_async<'a>(&'a self, id: &'a str) -> crate::BoxFuture<'a, std::result::Result<Option<vibevalley_protocol::Issue>, vibevalley_protocol::ApiError>> {
        Box::pin(async move { Board::issue_async(self, id).await.map_err(board_err) })
    }

    fn issues_async(&self) -> crate::BoxFuture<'_, std::result::Result<Vec<vibevalley_protocol::Issue>, vibevalley_protocol::ApiError>> {
        Box::pin(async move { Board::issues_async(self).await.map_err(board_err) })
    }

    fn sessions_async(&self) -> crate::BoxFuture<'_, std::result::Result<Vec<vibevalley_protocol::Session>, vibevalley_protocol::ApiError>> {
        Box::pin(async move { Board::sessions_async(self).await.map_err(board_err) })
    }

    fn runs_async<'a>(&'a self, issue_id: &'a str) -> crate::BoxFuture<'a, std::result::Result<Vec<vibevalley_protocol::Run>, vibevalley_protocol::ApiError>> {
        Box::pin(async move { Board::runs_async(self, issue_id).await.map_err(board_err) })
    }

    fn create_for_cron_async<'a>(
        &'a self,
        title: &'a str,
        description: &'a str,
        repo: Option<std::path::PathBuf>,
        agent: &'a str,
        cron_id: &'a str,
    ) -> crate::BoxFuture<'a, std::result::Result<vibevalley_protocol::Issue, vibevalley_protocol::ApiError>> {
        Box::pin(async move {
            Board::create_async(
                self,
                NewIssue {
                    title: title.to_string(),
                    description: description.to_string(),
                    repo,
                    agent: agent.to_string(),
                    cron: Some(cron_id.to_string()),
                    ..Default::default()
                },
            )
            .await
            .map_err(board_err)
        })
    }

    fn move_to_todo_async<'a>(&'a self, id: &'a str, words: Option<&'a str>) -> crate::BoxFuture<'a, std::result::Result<(), vibevalley_protocol::ApiError>> {
        Box::pin(async move {
            Board::move_to_async(self, id, vibevalley_protocol::IssueStatus::Todo, words)
                .await
                .map(|_| ())
                .map_err(board_err)
        })
    }

    fn tell_async<'a>(&'a self, id: &'a str, words: &'a str) -> crate::BoxFuture<'a, std::result::Result<(), vibevalley_protocol::ApiError>> {
        Box::pin(async move { Board::tell_async(self, id, words).await.map_err(board_err) })
    }
}
