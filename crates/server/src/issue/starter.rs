//! First-boot starter guide issues seeded once into a fresh database.
//!
//! Uses a dedicated `seq_counter` key (`starter_issues_seeded`) as an atomic,
//! migration-free once-only guard so starter cards are never duplicated on
//! restart, never resurrected after the user deletes or closes them, and never
//! injected into an existing database that already has issues.

use vibevalley_protocol::{Deliverable, Issue, Landing, Locale, Priority};

use super::board::Board;
use super::store::Result;
use crate::context::now;

const STARTER_SEED_KEY: &str = "starter_issues_seeded";

struct StarterSpec {
    title: &'static str,
    description: &'static str,
    criteria: &'static [&'static str],
    done: bool,
}

fn starter_specs(locale: Locale) -> [StarterSpec; 3] {
    match locale {
        Locale::Zh => [
            StarterSpec {
                title: "快速上手：挂仓库、建任务、派给编码角色",
                description: "欢迎来到 VibeValley！任务是这里推进开发的基本单位，主流程只有四步：\n\n\
1. **挂载仓库**：在侧栏「仓库」中添加本地 Git 仓库，作为任务的上下文提示；编码角色会自主管理分支或 `git worktree`。\n\
2. **创建任务**：按 `C` 或点右上角「新任务」写下需求，可附带截图、文档等附件。\n\
3. **派发开工**：在任务详情里选择仓库与编码角色，点「确认需求并派发」，或把卡片拖到「处理中」。\n\
4. **验收关单**：执行会话完成后会回报结构化交付凭据（PR、提交、笔记或结论），任务进入「等你看」，满意后点击完成关单。\n\n\
> 这是一张新手引导示例卡，随时可以关闭或删除。",
                criteria: &[
                    "在「仓库」页添加或新建至少一个本地 Git 仓库",
                    "在「引擎」页确认至少一个本机编码引擎已就绪",
                    "创建一条你自己的任务并派发给编码角色体验完整流转",
                ],
                done: false,
            },
            StarterSpec {
                title: "在频道里和主助手一起拆任务与跟进度",
                description: "除了直接在看板建卡，你也可以在频道里自然对话、把繁琐的拆解和跟进交给主助手：\n\n\
- **默认频道 `#general`**：直接说出想做的需求，主助手会帮你澄清范围、起草任务并拆成可执行的子任务。\n\
- **`@提及` 派发**：在消息里 `@角色` 可以点名把任务交由指定编码角色处理。\n\
- **子任务与线程回报**：执行会话开工后会在对应任务线程持续汇报进展、提出问题，并在交回验收时通知你。\n\n\
> 这是一张新手引导示例卡，随时可以关闭或删除。",
                criteria: &["打开「频道」中的 `#general` 与主助手对话一次", "体验让主助手把一项需求拆成子任务或指派角色"],
                done: false,
            },
            StarterSpec {
                title: "通过 MCP 让本机 Coding Agent 直接读取任务与附件",
                description: "VibeValley 内置了本机 MCP 服务（`/mcp`），执行会话和外部编码 Agent 都能直接读取你的任务上下文：\n\n\
- **`issue_list` / `issue_get`**：按状态、仓库或编号检索任务说明、验收标准与当前进度。\n\
- **`vv://issues` 资源**：以结构化资源方式暴露任务列表与附件的本地路径，无需手动复制粘贴需求。\n\
- **开箱即用**：由 VibeValley 派出的执行会话会自动挂载该 MCP 入口，也可以在外部 Claude Code / Codex 中复用。\n\n\
> 这是一张预置在「已关」列的新手引导示例卡，方便你预览已完成任务的样式，随时可以删除。",
                criteria: &[],
                done: true,
            },
        ],
        Locale::En => [
            StarterSpec {
                title: "Quick start: add a repo, create an issue, assign an agent",
                description: "Welcome to VibeValley! Issues drive every coding workflow in four steps:\n\n\
1. **Add a repository**: Open Repos in the sidebar to connect a local Git repository as an optional context hint. Coding agents autonomously manage branches or `git worktree` checkouts.\n\
2. **Create an issue**: Press `C` or click **New issue** to describe what to build, with optional screenshots or spec attachments.\n\
3. **Assign & start**: Pick a repository and coding agent, then click **Confirm and dispatch** (or drag the card to **In progress**).\n\
4. **Review & close**: When a round finishes, inspect the agent's delivery receipt (PR, commit, note, or answer) under **For you to see**, then mark the issue done.\n\n\
> This is a starter example card — feel free to close or delete it anytime.",
                criteria: &[
                    "Add or create at least one local Git repository in Repos",
                    "Verify at least one local coding engine is ready in Runtimes",
                    "Create your first real issue and dispatch it to a coding agent",
                ],
                done: false,
            },
            StarterSpec {
                title: "Collaborate with your orchestrator in channels",
                description: "You don't have to write every ticket by hand — talk through ideas with your orchestrator in channels:\n\n\
- **`#general` channel**: Describe a goal in plain language and let the orchestrator scope it, draft issues, and break large work into sub-issues.\n\
- **`@mention` dispatch**: Mention an agent directly to hand off work or ask for a follow-up.\n\
- **Thread updates**: Running sessions report progress, ask clarifying questions, and notify you in the issue thread when changes are ready to review.\n\n\
> This is a starter example card — feel free to close or delete it anytime.",
                criteria: &[
                    "Open #general in Channels and chat with your orchestrator",
                    "Try splitting a task into sub-issues or dispatching via @mention",
                ],
                done: false,
            },
            StarterSpec {
                title: "Read issues and attachments from local coding agents via MCP",
                description: "VibeValley exposes a built-in local MCP endpoint (`/mcp`) so coding agents can read full issue context directly:\n\n\
- **`issue_list` & `issue_get`**: Query issue descriptions, acceptance criteria, and current status without copy-pasting.\n\
- **`vv://issues` resources**: Browse structured issues along with local paths to any uploaded attachments.\n\
- **Automatic wiring**: Sessions launched by VibeValley receive this MCP server automatically, and external Claude Code / Codex sessions can connect too.\n\n\
> This starter example is pre-placed in Closed so you can see how completed cards look — feel free to delete it anytime.",
                criteria: &[],
                done: true,
            },
        ],
    }
}

impl Board {
    /// Seeds the 3 starter guide issues once on a brand-new database.
    ///
    /// Returns `Ok(true)` if the starter issues were created during this call,
    /// or `Ok(false)` if seeding had already run or the database already
    /// contained issues.
    pub async fn seed_starter_issues_if_fresh_async(&self, locale: Locale) -> Result<bool> {
        let _work = self.work.lock().await;
        let claim = self.state.next_async(STARTER_SEED_KEY, 0).await?;
        if claim > 1 {
            return Ok(false);
        }
        if !self.state.raw_issues_async().await?.is_empty() {
            return Ok(false);
        }

        let base_at = now();
        let specs = starter_specs(locale);
        let mut issues = Vec::with_capacity(specs.len());
        for (idx, spec) in specs.into_iter().enumerate() {
            let number = self.state.next_async("issue", 0).await?;
            let id = format!("i{number}");
            let at = base_at + idx as i64;
            let mut issue = Issue::new(id, number, spec.title, at);
            issue.description = spec.description.into();
            issue.criteria = spec.criteria.iter().map(|c| (*c).to_string()).collect();
            issue.priority = Priority::Medium;
            issue.repo = None;
            issue.assignments = vec![];
            if spec.done {
                issue.deliver = Deliverable::Answer;
                issue.delivered = Some(Landing::None);
                issue.closed_at = Some(at);
            } else {
                issue.deliver = Deliverable::Change;
            }
            issues.push(issue);
        }
        self.state.put_issues_async(&issues).await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use vibevalley_protocol::{IssueStatus, Locale};
    use vibevalley_runtime::oar::Registry;

    use crate::context::{Context, Http, LiveState, Outbox, StateFeed, TaskGroup};
    use crate::issue::{Board, BoardConfig, NewIssue};
    use crate::service::Service;

    async fn open_test_board() -> (tempfile::TempDir, Arc<Context>, Arc<Board>) {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
        let ctx = Arc::new(Context::new(
            service,
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            http.clone(),
            http,
        ));
        let board = Board::open_standalone_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
            .await
            .unwrap();
        (dir, ctx, board)
    }

    #[tokio::test]
    async fn fresh_db_seeds_three_starter_issues_in_zh_and_en() {
        for (locale, first_title, third_title) in [
            (
                Locale::Zh,
                "快速上手：挂仓库、建任务、派给编码角色",
                "通过 MCP 让本机 Coding Agent 直接读取任务与附件",
            ),
            (
                Locale::En,
                "Quick start: add a repo, create an issue, assign an agent",
                "Read issues and attachments from local coding agents via MCP",
            ),
        ] {
            let (_dir, ctx, board) = open_test_board().await;
            assert!(board.seed_starter_issues_if_fresh_async(locale).await.unwrap());

            // `refresh_queue_async` must never try to dispatch or mutate the starter cards.
            board.refresh_queue_async().await.unwrap();

            let issues = board.issues_async().await.unwrap();
            assert_eq!(issues.len(), 3);
            assert_eq!(issues[0].number, 1);
            assert_eq!(issues[1].number, 2);
            assert_eq!(issues[2].number, 3);
            assert_eq!(issues[0].title, first_title);
            assert_eq!(issues[2].title, third_title);
            assert_eq!(issues[0].status, IssueStatus::Backlog);
            assert_eq!(issues[1].status, IssueStatus::Backlog);
            assert_eq!(issues[2].status, IssueStatus::Done);
            assert!(issues.iter().all(|i| i.repo.is_none() && i.assignments.is_empty() && !i.description.is_empty()));
            assert_eq!(issues[0].criteria.len(), 3);

            // Next user-created issue receives #4 without colliding with seeded cards.
            let next = board
                .create_async(NewIssue {
                    title: "User issue".into(),
                    ..Default::default()
                })
                .await
                .unwrap();
            assert_eq!(next.number, 4);

            board.close_async().await;
            let _ = ctx.shutdown(Duration::from_secs(1)).await;
        }
    }

    #[tokio::test]
    async fn seeding_is_idempotent_and_deleted_starters_do_not_resurrect() {
        let (_dir, ctx, board) = open_test_board().await;
        assert!(board.seed_starter_issues_if_fresh_async(Locale::Zh).await.unwrap());
        assert!(!board.seed_starter_issues_if_fresh_async(Locale::Zh).await.unwrap());
        assert_eq!(board.issues_async().await.unwrap().len(), 3);

        // User deletes all 3 starter cards; restarting/re-seeding must NOT recreate them.
        for issue in board.issues_async().await.unwrap() {
            board.remove_async(&issue.id).await.unwrap();
        }
        assert!(board.issues_async().await.unwrap().is_empty());

        assert!(!board.seed_starter_issues_if_fresh_async(Locale::Zh).await.unwrap());
        assert!(board.issues_async().await.unwrap().is_empty());

        board.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn existing_database_with_issues_skips_starter_seeding() {
        let (_dir, ctx, board) = open_test_board().await;
        let existing = board
            .create_async(NewIssue {
                title: "Pre-existing ticket".into(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(!board.seed_starter_issues_if_fresh_async(Locale::En).await.unwrap());
        let issues = board.issues_async().await.unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, existing.id);

        // Even if the user later removes that ticket, starters still stay absent.
        board.remove_async(&existing.id).await.unwrap();
        assert!(!board.seed_starter_issues_if_fresh_async(Locale::En).await.unwrap());
        assert!(board.issues_async().await.unwrap().is_empty());

        board.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
    }
}
