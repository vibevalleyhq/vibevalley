//! The issue board: the workflow rules of `vibevalley-core` at work on the
//! issues. Creating, moving, telling, queueing and sending, accepting and
//! delivering, closing. Its sessions are [`Sessions`]', its worktrees and
//! merges [`Workplace`]', and every change is written through the
//! [`Ledger`].
//!
//! Every method blocks and may be called from any thread. One process holds
//! a board at a time (a lock file next to its data); others read it with
//! [`Board::snapshot`].

use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use vibevalley_core::{Move, Refusal, status_move};
use vibevalley_oar::Registry;
use vibevalley_protocol::{
    Assignment, Deliverable, Fact, Issue, IssueCanceled, IssueConstraints, IssueStageKind as StageKind, IssueStatus, Priority, Run, RunTriggerKind, Session,
    SpaceState, StateFrame as Frame, StuckReason,
};
use vibevalley_store::Store;

use crate::modules::ledger::{BoardConfig, BoardError, Facts, IssueChange, Ledger, LocalFacts, Result, Undelivered, find, io, lock, now};
use crate::modules::session::{DraftEnd, Drivers, Hire, Rounds, RuntimeDrivers, Sessions, trigger_of};
use crate::modules::workplace::{Changes, Landed, Leave, OnDisk, Workplace};

/// What the user writes down.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewIssue {
    pub title: String,
    pub description: String,
    pub criteria: Vec<String>,
    /// A path inside the repository it changes; none for an answer only.
    pub repo: Option<PathBuf>,
    /// The runtime that does it (`claude`, `codex`, `acp:…`, `scripted`).
    pub agent: String,
    pub deliver: Deliverable,
    #[serde(default)]
    pub priority: Priority,
    /// Its parent issue (id or number); the child works on a branch cut
    /// from the parent's and merges into it.
    #[serde(default)]
    pub parent: Option<String>,
    /// Issues (ids or numbers) it waits for.
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub constraints: Option<IssueConstraints>,
    /// The cron that keeps it (`Issue.cron`).
    #[serde(default)]
    pub cron: Option<String>,
}

/// What became of a request to send an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "sent", rename_all = "snake_case")]
pub enum Sent {
    /// A session works on it.
    Working { session: String },
    /// It waits in todo: for room, or for the issues it is blocked by.
    Queued { blocked_by: Vec<String> },
}

/// Words for an issue not sent yet, waiting for its next round.
const WORDS: &str = "issue-words";

#[derive(Clone)]
pub struct Board(pub(super) Arc<Inner>);

pub(super) struct Inner {
    pub ledger: Arc<Ledger>,
    pub sessions: Sessions,
    pub workplaces: Arc<Workplace>,
    pub drivers: Arc<dyn Drivers>,
    pub config: Arc<BoardConfig>,
    /// Held by every change to the workflow (not by event pumps), so rooms
    /// are counted and issues sent one at a time.
    pub work: Mutex<()>,
    lock: Mutex<Option<File>>,
}

/// The issue module hearing its sessions' rounds end.
struct Heard(Weak<Inner>);

impl Rounds for Heard {
    fn drafted(&self, end: DraftEnd) {
        if let Some(inner) = self.0.upgrade() {
            Board(inner).finish_draft(end);
        }
    }

    fn after(&self) {
        if let Some(inner) = self.0.upgrade() {
            Board(inner).after_round();
        }
    }
}

impl Board {
    /// The board as stored, without taking it: for reading while another
    /// process holds it. Working sessions show as they were last stored.
    pub fn snapshot(store: &Store) -> Result<Frame> {
        Ledger::snapshot(store)
    }

    /// Takes the board and loads it, standing alone with an agent named by
    /// its runtime id. See [`Board::open_with`].
    pub fn open(store: Arc<Store>, registry: Arc<Registry>, config: BoardConfig) -> Result<Board> {
        Board::open_on(store, registry, config, Arc::new(LocalFacts::default()))
    }

    /// `open`, with the board's issues and sessions in `facts` (the server's
    /// state).
    pub fn open_on(store: Arc<Store>, registry: Arc<Registry>, config: BoardConfig, facts: Arc<dyn Facts>) -> Result<Board> {
        let drivers = Arc::new(RuntimeDrivers {
            registry,
            model: config.model.clone(),
        });
        Board::open_with(store, drivers, config, facts)
    }

    /// Takes the board and loads it into `facts`, issues' agents run by
    /// `drivers`. A session that was working when the last process ended
    /// was interrupted: its run is over and it rests until the next words.
    /// A session whose worktree is gone leaves, and its open issue is
    /// canceled as lost. Call `refresh_queue` afterwards to send what waits.
    pub fn open_with(store: Arc<Store>, drivers: Arc<dyn Drivers>, config: BoardConfig, facts: Arc<dyn Facts>) -> Result<Board> {
        std::fs::create_dir_all(config.data_dir.join("reports")).map_err(io)?;
        std::fs::create_dir_all(config.data_dir.join("records")).map_err(io)?;
        let lock_path = config.data_dir.join("board.lock");
        let file = File::create(&lock_path).map_err(io)?;
        // A child process forked while the last holder had it open may hold
        // it a moment longer.
        let deadline = Instant::now() + Duration::from_secs(2);
        while file.try_lock().is_err() {
            if Instant::now() > deadline {
                return Err(BoardError::Busy(lock_path));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let config = Arc::new(config);
        let (ledger, opened) = Ledger::open(store, facts)?;
        let ledger = Arc::new(ledger);
        let workplaces = Arc::new(Workplace::new(config.worktrees_dir.clone(), config.repos_dir.clone(), config.data_dir.clone()));
        let sessions = Sessions::new(ledger.clone(), drivers.clone(), workplaces.clone(), config.clone())?;
        let board = Board(Arc::new(Inner {
            ledger,
            sessions,
            workplaces,
            drivers,
            config,
            work: Mutex::new(()),
            lock: Mutex::new(Some(file)),
        }));
        board.0.sessions.on_rounds(Box::new(Heard(Arc::downgrade(&board.0))));
        board.0.sessions.interrupted(&opened.interrupted)?;
        {
            let _work = lock(&board.0.work);
            for id in opened.lost {
                if let Ok(issue) = board.stored(&id)
                    && !issue.status.is_closed()
                    && issue.latest_session_id().is_some()
                {
                    board.close_issue(&issue, IssueCanceled::Lost)?;
                }
            }
            // A draft cut short leaves its issue as it was.
            for draft in opened.drafts {
                board.0.sessions.dismiss(&draft, Leave::Discard)?;
            }
        }
        Ok(board)
    }

    /// Lets the board go: the agents this process drives stop (their
    /// rounds are recorded as interrupted by the next `open`) and the lock
    /// is released.
    pub fn close(&self) {
        self.0.sessions.close();
        lock(&self.0.lock).take();
    }

    pub fn config(&self) -> &BoardConfig {
        &self.0.config
    }

    /// The board's sessions: hiring, rounds, talk, the helpers' door.
    pub fn sessions(&self) -> &Sessions {
        &self.0.sessions
    }

    /// Where the issues' work happens on disk.
    pub fn workplaces(&self) -> &Workplace {
        &self.0.workplaces
    }

    pub fn frame(&self) -> Frame {
        self.0.ledger.frame()
    }

    /// Reads the state the board's facts went into.
    pub fn read<R>(&self, f: impl FnOnce(&SpaceState) -> R) -> R {
        self.0.ledger.read(f)
    }

    /// The newest frame after every change; a receiver that falls behind
    /// skips to the newest.
    pub fn subscribe(&self) -> flume::Receiver<Frame> {
        self.0.ledger.subscribe()
    }

    /// By id, number or `#number`.
    pub fn issue(&self, reference: &str) -> Option<Issue> {
        self.0.ledger.issue(reference)
    }

    pub fn session(&self, id: &str) -> Option<Session> {
        self.0.ledger.session(id)
    }

    /// A session that left the board, as it was when it did.
    pub fn past_session(&self, id: &str) -> Option<Session> {
        self.0.ledger.past_session(id)
    }

    /// The issue's runs, oldest first.
    pub fn runs(&self, issue: &str) -> Result<Vec<Run>> {
        self.0.sessions.runs(issue)
    }

    pub(super) fn stored(&self, reference: &str) -> Result<Issue> {
        self.issue(reference).ok_or_else(|| BoardError::NoIssue(reference.to_string()))
    }

    pub(super) fn state(&self) -> SpaceState {
        self.0.ledger.state()
    }

    pub(super) fn change(&self, id: &str, change: IssueChange) -> Result<Issue> {
        self.0.ledger.change(id, change)
    }

    // ----- what the user does -----

    pub fn create(&self, new: NewIssue) -> Result<Issue> {
        let _work = lock(&self.0.work);
        let repo = match &new.repo {
            Some(path) => Some(self.0.workplaces.ensure_repo(self.0.workplaces.repo_dir(&path.to_string_lossy()))?),
            None => None,
        };
        if !new.agent.trim().is_empty() {
            self.0.drivers.check(new.agent.trim())?;
        }
        let (title, description) =
            vibevalley_core::brief::issue_words(&new.title, &new.description).ok_or_else(|| BoardError::Other("the issue has no title".into()))?;
        let state = self.state();
        let parent = match &new.parent {
            Some(p) => Some(find(&state.issues, p).cloned().ok_or_else(|| BoardError::NoIssue(p.clone()))?),
            None => None,
        };
        let mut blocked_by = Vec::new();
        for b in &new.blocked_by {
            blocked_by.push(find(&state.issues, b).ok_or_else(|| BoardError::NoIssue(b.clone()))?.id.clone());
        }
        if let Some(p) = &parent
            && p.status.is_closed()
        {
            return Err(BoardError::Other(format!("issue #{} is closed", p.number)));
        }
        let repo_root = match (&repo, &parent) {
            (Some(r), _) => Some(self.0.workplaces.repo_ref(r.root())),
            (None, Some(p)) => p.repo.clone(),
            (None, None) => None,
        };
        let stored_max = state.issues.iter().map(|t| t.number).max().unwrap_or(0);
        let number = self.0.ledger.next("issue", stored_max)?;
        let id = format!("i{number}");
        let mut graph: Vec<(String, Option<String>, Vec<String>)> =
            state.issues.iter().map(|t| (t.id.clone(), t.parent.clone(), t.blocked_by.clone())).collect();
        graph.push((id.clone(), parent.as_ref().map(|p| p.id.clone()), blocked_by.clone()));
        let problems = vibevalley_core::dependency_problems(&graph);
        if !problems.is_empty() {
            return Err(BoardError::Other(format!("the dependencies do not form a DAG: {problems:?}")));
        }
        if new
            .constraints
            .as_ref()
            .is_some_and(|c| c.acceptance && c.check.as_deref().unwrap_or("").is_empty())
        {
            return Err(BoardError::Other("an acceptance issue needs a check command".into()));
        }
        let at = now();
        let mut issue = Issue::new(&id, number, title, at);
        issue.description = description;
        issue.criteria = vibevalley_core::refine::kept(&new.criteria);
        issue.deliver = new.deliver;
        issue.repo = repo_root;
        issue.priority = parent.as_ref().map(|p| p.priority).unwrap_or(new.priority);
        let parent_agent = parent.as_ref().and_then(|p| p.assigned_agent()).map(String::from);
        issue.parent = parent.map(|p| p.id);
        issue.blocked_by = blocked_by;
        issue.constraints = new.constraints;
        issue.cron = new.cron;
        let agent = new.agent.trim().to_string();
        let agent = if agent.is_empty() { parent_agent.unwrap_or_default() } else { agent };
        if !agent.is_empty() {
            issue.assignments = vec![Assignment {
                id: format!("{id}-a1"),
                issue: id.clone(),
                agent,
                assigned_at: at,
                ended_at: None,
                executions: vec![],
            }];
        }
        self.0.ledger.apply(vec![Fact::issue_changed(at, issue)])?;
        self.stored(&id)
    }

    /// The user moves an issue on the board. `words` carry what to do this
    /// time for a round or a reopen.
    pub fn move_to(&self, reference: &str, to: IssueStatus, words: Option<&str>) -> Result<Move> {
        let _work = lock(&self.0.work);
        let issue = self.stored(reference)?;
        let mv = status_move(&issue, to).map_err(BoardError::Refused)?;
        let words = words.map(str::trim).filter(|w| !w.is_empty()).map(String::from);
        match mv {
            Move::Start => {
                if let Some(w) = words {
                    self.keep_words(&issue.id, &w)?;
                }
                self.change(&issue.id, IssueChange::Queued)?;
                self.send(&issue.id, None, RunTriggerKind::Issue)?;
            }
            Move::Unqueue => {
                self.change(&issue.id, IssueChange::Unqueued)?;
            }
            Move::Round | Move::Reopen => {
                // Sending back what was handed in takes the user's findings;
                // the server words the rest (cure, resume, resolve).
                let required = mv == Move::Reopen || issue.stage.state == StageKind::Reviewing;
                let words = match words {
                    Some(w) => w,
                    None if required => return Err(BoardError::WordsRequired),
                    None => default_words(&issue),
                };
                self.room_for_round(&issue)?;
                self.change(&issue.id, IssueChange::Reopened)?;
                self.send(&issue.id, Some(words), RunTriggerKind::Comment)?;
            }
            Move::Revive => {
                self.change(&issue.id, IssueChange::Revived)?;
            }
            Move::Complete => self.complete(&issue)?,
            Move::Cancel | Move::Drop => {
                self.close_issue(&issue, IssueCanceled::Dismissed)?;
                self.refresh_queue_locked();
            }
        }
        Ok(mv)
    }

    /// A round for a session still on the board needs room now (the
    /// delivery is refused); a new session may wait in todo.
    pub(super) fn room_for_round(&self, issue: &Issue) -> Result<()> {
        let Some(session) = self.on_board(issue) else { return Ok(()) };
        let (space, repo) = self.room(issue, &session.id);
        if space == 0 || repo == 0 {
            let busy = self.read(|s| s.sessions.iter().filter(|s| s.phase.is_working()).count());
            let per_repo = self.0.config.per_repo;
            return Err(BoardError::NoRoom(format!(
                "{busy} sessions work in the space (limit {}), {} in this repository",
                self.0.config.space_limit,
                per_repo.saturating_sub(repo.min(per_repo))
            )));
        }
        Ok(())
    }

    /// Words to the issue's session: an answer to its question, or a note.
    /// Steers the running turn when the runtime can; otherwise the next
    /// round starts with them. Words for an issue not sent yet wait for it.
    pub fn tell(&self, reference: &str, words: &str) -> Result<()> {
        let words = words.trim();
        if words.is_empty() {
            return Err(BoardError::WordsRequired);
        }
        let _work = lock(&self.0.work);
        let issue = self.stored(reference)?;
        if issue.status.is_closed() {
            return Err(BoardError::Refused(if issue.was_sent() { Refusal::Reopen } else { Refusal::Revive }));
        }
        if let Some(steered) = self.on_board(&issue).and_then(|s| self.0.sessions.steer(&s, words)) {
            return steered;
        }
        match issue.status {
            IssueStatus::Backlog | IssueStatus::Todo => self.keep_words(&issue.id, words),
            _ => {
                self.room_for_round(&issue)?;
                self.change(&issue.id, IssueChange::Answered)?;
                self.send(&issue.id, Some(words.to_string()), RunTriggerKind::Comment).map(|_| ())
            }
        }
    }

    /// Stops the running turn of the issue's session (its drafter's while
    /// it is drafted).
    pub fn stop(&self, reference: &str) -> Result<()> {
        let issue = self.stored(reference)?;
        let refining = issue.refining.as_ref().map(|r| r.session.clone());
        let session = refining.or_else(|| issue.latest_session_id().cloned());
        self.0.sessions.stop(&session.unwrap_or_default())
    }

    /// Sends queued issues while there is room, in board order. Children in
    /// review are merged into their parents first.
    pub fn refresh_queue(&self) -> Result<()> {
        let _work = lock(&self.0.work);
        self.join_children()?;
        self.refresh_queue_locked();
        Ok(())
    }

    pub(super) fn refresh_queue_locked(&self) {
        let queued: Vec<String> = self
            .state()
            .issues
            .iter()
            .filter(|t| t.status == IssueStatus::Todo && t.queued_at.is_some())
            .map(|t| t.id.clone())
            .collect();
        for id in queued {
            if let Err(e) = self.send(&id, None, RunTriggerKind::Issue) {
                // One that cannot go any more leaves the queue.
                eprintln!("vibevalley: issue {id} could not be sent: {e}");
                let _ = self.change(&id, IssueChange::Unqueued);
            }
        }
    }

    /// After every round: children in review merge into their parents,
    /// then what waits is sent.
    fn after_round(&self) {
        let _work = lock(&self.0.work);
        if let Err(e) = self.join_children() {
            eprintln!("vibevalley: child issues could not be merged: {e}");
        }
        self.refresh_queue_locked();
    }

    // ----- sending -----

    /// The issue's newest session, while it is on the board.
    pub(super) fn on_board(&self, issue: &Issue) -> Option<Session> {
        let id = issue.latest_session_id()?;
        self.session(id)
    }

    /// Room left for one more session on `issue`: in the space, and in its repository.
    pub(super) fn room(&self, issue: &Issue, except: &str) -> (usize, usize) {
        let room = self.read(|s| {
            vibevalley_core::rules::room_left(
                &s.sessions,
                issue.repo.as_deref().unwrap_or(""),
                self.0.config.space_limit,
                self.0.config.per_repo,
                except,
            )
        });
        (room.farm, room.repo.unwrap_or(usize::MAX))
    }

    pub(super) fn keep_words(&self, id: &str, words: &str) -> Result<()> {
        let store = self.0.ledger.store();
        let mut kept: Vec<String> = store.doc(WORDS, id)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        kept.push(words.to_string());
        store.put_doc(WORDS, id, &serde_json::to_value(kept).unwrap_or_default())?;
        Ok(())
    }

    pub(super) fn take_words(&self, id: &str) -> Result<Option<String>> {
        let store = self.0.ledger.store();
        let kept: Vec<String> = store.doc(WORDS, id)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        store.delete_doc(WORDS, id)?;
        Ok((!kept.is_empty()).then(|| kept.join("\n\n")))
    }

    /// Starts (or continues) the issue's session when its blockers are done
    /// and there is room; else it waits in todo and `refresh_queue` sends
    /// it later. Holds `work`.
    pub(super) fn send(&self, id: &str, words: Option<String>, kind: RunTriggerKind) -> Result<Sent> {
        let issue = self.stored(id)?;
        let state = self.state();
        let blocked = vibevalley_core::blocked_issues(&issue, &state.issues);
        let session = self.on_board(&issue);
        let (space, repo) = self.room(&issue, session.as_ref().map(|s| s.id.as_str()).unwrap_or(""));
        if !blocked.is_empty() || space == 0 || repo == 0 {
            if let Some(w) = &words {
                self.keep_words(id, w)?;
            }
            return Ok(Sent::Queued { blocked_by: blocked });
        }
        let kept = self.take_words(id)?;
        let words = match (kept, words) {
            (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
            (a, b) => a.or(b),
        };
        let result = match session {
            Some(s) => {
                let words = words.clone().unwrap_or_else(|| default_words(&issue));
                let trigger = trigger_of(kind, Some(words.clone()));
                let all = &state.issues;
                let again = |words: &str| {
                    format!(
                        "{}\n\nYou are taking this issue up again in its worktree; earlier work is on its branch: \
                         check `git status` and `git log` first.",
                        brief(&issue, all, Some(words))
                    )
                };
                self.0.sessions.next_round(&issue, &s, words, again, trigger)
            }
            None => self.hire(&issue, &state.issues, words.clone(), kind),
        };
        match result {
            Ok(session) => Ok(Sent::Working { session }),
            Err(e) => {
                // Not sent: it leaves the queue, the words stay for the next try.
                if let Some(w) = &words {
                    let _ = self.keep_words(id, w);
                }
                let _ = self.change(id, IssueChange::Unqueued);
                Err(e)
            }
        }
    }

    fn hire(&self, issue: &Issue, all: &[Issue], words: Option<String>, kind: RunTriggerKind) -> Result<String> {
        let drive = self.0.drivers.drive(issue.assigned_agent(), issue)?;
        let wp = &self.0.workplaces;
        let (cwd, branch, base) = match wp.main_repo(issue.repo.as_deref())? {
            Some(main) => {
                let parent = issue.parent.as_ref().and_then(|p| self.issue(p)).map(|p| p.number);
                let base = wp.base(&main, parent)?;
                let (dir, branch) = wp.worktree(&main, issue.number, &base)?;
                (dir, Some(branch), Some(base))
            }
            None => (wp.context(&issue.id)?, None, None),
        };
        let name = format!("{} #{}", drive.name, issue.number);
        self.0.sessions.hire(Hire {
            issue,
            prompt: brief(issue, all, words.as_deref()),
            trigger: trigger_of(kind, words),
            drive,
            cwd,
            branch,
            base,
            name,
            brief: issue.title.clone(),
            drafting: false,
        })
    }

    // ----- delivering -----

    /// The issue's work as it stands.
    pub fn changes(&self, reference: &str) -> Result<Changes> {
        let issue = self.stored(reference)?;
        let wp = &self.0.workplaces;
        let main = wp
            .main_repo(issue.repo.as_deref())?
            .ok_or_else(|| BoardError::Other("the issue has no repository".into()))?;
        let base = self.session_base(&issue, &main)?;
        let worktree = self.on_board(&issue).and_then(|s| s.worktree);
        let at = OnDisk {
            number: issue.number,
            title: &issue.title,
            worktree: worktree.as_deref(),
        };
        wp.changes(&main, &at, base, issue.parent.is_some())
    }

    /// The branch the issue's work forked from: its session's, else its
    /// parent's or the main branch.
    fn session_base(&self, issue: &Issue, main: &vibevalley_git::Repo) -> Result<String> {
        match self.on_board(issue).and_then(|s| self.0.sessions.base_branch(&s.id)) {
            Some(base) => Ok(base),
            None => {
                let parent = issue.parent.as_ref().and_then(|p| self.issue(p)).map(|p| p.number);
                self.0.workplaces.base(main, parent)
            }
        }
    }

    /// Accepted: deliver as the issue says.
    fn complete(&self, issue: &Issue) -> Result<()> {
        let session = self.on_board(issue);
        let wp = &self.0.workplaces;
        if issue.deliver == Deliverable::PullRequest {
            return Err(BoardError::Other("pull requests are not delivered by VibeValley yet".into()));
        }
        let main = wp.main_repo(issue.repo.as_deref())?;
        let landing = match &main {
            _ if issue.deliver == Deliverable::Answer => vibevalley_protocol::Landing::None,
            None => vibevalley_protocol::Landing::None,
            Some(main) => {
                let has_children = self.state().issues.iter().any(|t| t.parent.as_ref() == Some(&issue.id));
                let worktree = session.as_ref().and_then(|s| s.worktree.clone());
                let at = OnDisk {
                    number: issue.number,
                    title: &issue.title,
                    worktree: worktree.as_deref(),
                };
                match wp.land(main, &at, issue.deliver, || self.session_base(issue, main), has_children)? {
                    Landed::Landed(landing) => landing,
                    Landed::Conflict(conflict) => {
                        let (base, files) = (conflict.base.clone(), conflict.files.clone());
                        self.change(&issue.id, IssueChange::Conflicted(conflict))?;
                        return Err(BoardError::NotDelivered(Undelivered::Conflict { base, files }));
                    }
                    Landed::CheckFailed(output) => {
                        let sent_back = session.is_some() && self.room_for_round(issue).is_ok();
                        if sent_back {
                            self.change(&issue.id, IssueChange::Queued)?;
                            let words = format!("The project check failed. Fix it and commit:\n\n{output}");
                            self.send(&issue.id, Some(words), RunTriggerKind::Comment)?;
                        }
                        return Err(BoardError::NotDelivered(Undelivered::CheckFailed { output, sent_back }));
                    }
                }
            }
        };
        if let Some(s) = &session {
            let leave = if issue.deliver == Deliverable::Branch {
                Leave::KeepBranch
            } else {
                Leave::Discard
            };
            self.0.sessions.dismiss(&s.id, leave)?;
        } else if let Some(main) = &main {
            wp.clear_checkout(main, issue.number)?;
        }
        self.change(&issue.id, IssueChange::Delivered(landing))?;
        let _ = self.take_words(&issue.id);
        self.refresh_queue_locked();
        Ok(())
    }

    /// Not done any more: its session goes home (leftovers committed on its
    /// branch, which stays when it has commits), its open children with it.
    pub(super) fn close_issue(&self, issue: &Issue, why: IssueCanceled) -> Result<()> {
        let children: Vec<Issue> = self
            .state()
            .issues
            .into_iter()
            .filter(|t| t.parent.as_ref() == Some(&issue.id) && !t.status.is_closed())
            .collect();
        for child in children {
            self.close_issue(&child, why)?;
        }
        if let Some(r) = &issue.refining {
            self.0.sessions.dismiss(&r.session, Leave::Discard)?;
        }
        if let Some(s) = self.on_board(issue) {
            self.0.sessions.dismiss(&s.id, Leave::KeepBranch)?;
        }
        let _ = self.take_words(&issue.id);
        self.change(&issue.id, IssueChange::Canceled(why))?;
        Ok(())
    }
}

pub(super) fn default_words(issue: &Issue) -> String {
    match issue.stage.stuck {
        Some(StuckReason::Conflict) => {
            let base = issue.conflict.as_ref().map(|c| c.base.as_str()).unwrap_or("the base branch");
            format!(
                "Your branch conflicts with {base}. Merge {base} into your branch, resolve the conflicts, run the \
                 tests and commit."
            )
        }
        Some(StuckReason::Failed) => "The last round failed. Find out why, fix it and try again.".into(),
        Some(StuckReason::Interrupted) => "You were interrupted. Check `git status` and `git log`, then carry on.".into(),
        _ => "Carry on.".into(),
    }
}

/// What the agent is told to do.
fn brief(issue: &Issue, all: &[Issue], words: Option<&str>) -> String {
    let frozen: Vec<String> = vibevalley_core::acceptance_ancestors(issue, all)
        .iter()
        .flat_map(|t| t.constraints.as_ref().map(|c| c.frozen.clone()).unwrap_or_default())
        .collect();
    let brief = vibevalley_core::prompts::issue_brief(&issue.title, &issue.description, &issue.criteria, issue.deliver);
    let constraints = vibevalley_core::work_constraints(issue.constraints.as_ref(), &frozen);
    let brief = [brief, constraints].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
    match words.map(str::trim).filter(|w| !w.is_empty()) {
        Some(words) => format!("{words}{}", vibevalley_i18n::t("server.issue.brief.original", &[("brief", brief.into())])),
        None => brief,
    }
}
