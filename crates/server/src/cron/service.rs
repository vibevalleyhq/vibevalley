use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::{ActorKind, ApiError, BizCode, Cron, CronRequest, Millis, NoticeLevel, Preview};

use crate::context::Context;
use crate::context::error::{LookIn, missing};
use crate::service::internal_db;

pub const DEFAULT_CHANNEL: &str = "general";

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::CronRefused, text)
}

/// `$TZ` when it names a zone, else the system's.
fn local_zone() -> String {
    std::env::var("TZ")
        .ok()
        .filter(|tz| !tz.is_empty() && vibevalley_core::cron::given_zone(tz).is_some())
        .or_else(|| jiff::tz::TimeZone::system().iana_name().map(String::from))
        .unwrap_or_else(|| "UTC".into())
}

/// A cron job that became due and had its `last_run` durably advanced.
#[derive(Debug, Clone)]
pub struct DueCron {
    pub cron: Cron,
    pub words: String,
    pub prev_last_run: Option<Millis>,
    pub at: Millis,
}

#[derive(Default)]
struct CronLinks {
    issue_of_cron: HashMap<String, String>,
    cron_of_issue: HashMap<String, String>,
}

impl CronLinks {
    fn link(&mut self, cron_id: &str, issue_id: Option<&str>) -> Option<String> {
        let prev_issue = self.issue_of_cron.remove(cron_id);
        if let Some(prev) = &prev_issue {
            self.cron_of_issue.remove(prev);
        }
        if let Some(issue_id) = issue_id {
            if let Some(prev_cron) = self.cron_of_issue.insert(issue_id.into(), cron_id.into()) {
                self.issue_of_cron.remove(&prev_cron);
            }
            self.issue_of_cron.insert(cron_id.into(), issue_id.into());
        }
        prev_issue
    }
}

/// Pure scheduled cron store and due-job evaluator.
pub struct Scheduler {
    ctx: Arc<Context>,
    crons: Mutex<Vec<Cron>>,
    links: Arc<Mutex<CronLinks>>,
    /// Serializes mutations and due-job claiming across callers and the ticker.
    lock: AsyncMutex<()>,
    closed: AtomicBool,
}

impl Scheduler {
    /// Loads stored crons via `ctx.service.cron`.
    pub async fn open_async(ctx: Arc<Context>) -> Result<Arc<Scheduler>, ApiError> {
        let stored = ctx.service.cron.list().await.map_err(internal_db)?;
        let links = Arc::new(Mutex::new(CronLinks::default()));
        let mut crons = Vec::with_capacity(stored.len());
        let mut has_pending = false;
        {
            let mut map = links.lock();
            for item in stored {
                if let Some(issue_id) = item.issue_id.as_deref() {
                    map.link(&item.cron.id, Some(issue_id));
                }
                has_pending |= item.cron.pending;
                crons.push(item.cron);
            }
        }
        if !crons.is_empty() {
            let mut dirty = SliceMask::OPS;
            if has_pending {
                dirty |= SliceMask::INBOX;
            }
            ctx.mark_dirty(dirty);
        }
        Ok(Arc::new(Scheduler {
            ctx,
            crons: Mutex::new(crons),
            links,
            lock: AsyncMutex::new(()),
            closed: AtomicBool::new(false),
        }))
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Marks the scheduler closed.
    pub async fn close_async(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }

    pub fn list(&self) -> Vec<Cron> {
        self.crons.lock().clone()
    }

    pub fn issue_of(&self, cron_id: &str) -> Option<String> {
        self.links.lock().issue_of_cron.get(cron_id).cloned()
    }

    pub fn cron_of(&self, issue_id: &str) -> Option<String> {
        self.links.lock().cron_of_issue.get(issue_id).cloned()
    }

    /// Persists `cron` (keeping its linked issue, if any) and marks dirty slices.
    async fn put_async(&self, cron: Cron) -> Result<(), ApiError> {
        let issue_id = self.issue_of(&cron.id);
        self.ctx.service.cron.upsert(&cron, issue_id.as_deref()).await.map_err(internal_db)?;
        let (changed, was_pending, is_pending) = {
            let mut list = self.crons.lock();
            let pending_after = cron.pending;
            match list.iter_mut().find(|c| c.id == cron.id) {
                Some(existing) if *existing == cron => (false, existing.pending, pending_after),
                Some(existing) => {
                    let prev = existing.pending;
                    *existing = cron;
                    (true, prev, pending_after)
                }
                None => {
                    list.push(cron);
                    (true, false, pending_after)
                }
            }
        };
        if changed {
            let mut dirty = SliceMask::OPS;
            if was_pending || is_pending {
                dirty |= SliceMask::INBOX;
            }
            self.ctx.mark_dirty(dirty);
        }
        Ok(())
    }

    /// Links (or unlinks) `cron_id` with `issue_id` and marks issue slices dirty.
    pub async fn link_issue_async(&self, cron_id: &str, issue_id: Option<&str>) -> Result<(), ApiError> {
        self.ctx.service.cron.set_issue(cron_id, issue_id).await.map_err(internal_db)?;
        let prev = self.links.lock().link(cron_id, issue_id);
        if prev.as_deref() != issue_id {
            self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM);
        }
        Ok(())
    }

    pub fn find(&self, id: &str) -> Result<Cron, ApiError> {
        self.list()
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| missing(t("server.cron.noCron", &[("id", id.into())]), LookIn::Cron))
    }

    /// Creates a cron job using pre-resolved channel metadata and agent id.
    pub async fn add_resolved_async(
        &self,
        req: CronRequest,
        by: ActorKind,
        channel: String,
        channel_name: String,
        channel_repo: String,
        agent: Option<String>,
    ) -> Result<Cron, ApiError> {
        let _l = self.lock.lock().await;
        let at = self.ctx.now();
        let rules = vibevalley_core::cron_request_to_rules(&req);
        let problem = vibevalley_core::cron::cron_problem(&rules, at);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let repo = req.repo.as_deref().unwrap_or("").trim().to_string();
        if agent.is_some() && repo.is_empty() && channel_repo.is_empty() {
            return Err(refused(t("server.cron.noRepo", &[("channel", channel_name.into())])));
        }
        let pending = vibevalley_core::cron::needs_ok(&rules, by == ActorKind::User);
        let cron = Cron {
            id: uuid::Uuid::now_v7().to_string(),
            name: req.name.trim().into(),
            text: req.text.trim().into(),
            channel,
            agent,
            repo: Some(repo).filter(|r| !r.is_empty()),
            when: req.when,
            tz: req.tz.unwrap_or_else(local_zone),
            enabled: !pending,
            created: at,
            last_run: None,
            by,
            pending,
        };
        self.put_async(cron.clone()).await?;
        Ok(cron)
    }

    /// Turned on is the user's yes; switched back on, it counts from now.
    pub async fn set_enabled_async(&self, id: &str, enabled: bool) -> Result<Cron, ApiError> {
        let _l = self.lock.lock().await;
        let was = self.find(id)?;
        let mut cron = Cron {
            enabled,
            pending: was.pending && !enabled,
            ..was.clone()
        };
        if enabled && !was.enabled && !matches!(was.when, vibevalley_protocol::CronWhen::Once(_)) {
            cron.last_run = Some(self.ctx.now());
        }
        self.put_async(cron.clone()).await?;
        Ok(cron)
    }

    pub async fn remove_async(&self, id: &str) -> Result<Cron, ApiError> {
        let _l = self.lock.lock().await;
        let was = self.find(id)?;
        self.ctx.service.cron.remove(id).await.map_err(internal_db)?;
        let prev_issue = self.links.lock().link(id, None);
        self.crons.lock().retain(|c| c.id != id);
        let mut dirty = SliceMask::OPS;
        if was.pending {
            dirty |= SliceMask::INBOX;
        }
        if prev_issue.is_some() {
            dirty |= SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM;
        }
        self.ctx.mark_dirty(dirty);
        Ok(was)
    }

    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let was = self.find(id)?;
        let rules = vibevalley_core::cron_to_rules(&was);
        Ok(Preview {
            does: vec![t(
                "server.cron.removeWhen",
                &[
                    ("name", was.name.clone().into()),
                    ("when", vibevalley_core::cron::when_text(&rules.when, &rules.tz).into()),
                ],
            )],
        })
    }

    /// Advances `last_run` for every cron due now and returns the claimed runs for
    /// orchestration dispatch.
    pub async fn take_due_async(&self) -> Vec<DueCron> {
        let _l = self.lock.lock().await;
        let at = self.ctx.now();
        let all = self.list();
        let rules: Vec<vibevalley_core::cron::Cron> = all.iter().map(vibevalley_core::cron_to_rules).collect();
        let due_runs: Vec<_> = vibevalley_core::cron::due_crons(&rules, at)
            .into_iter()
            .map(|due| {
                let prev_last_run = due.last_run;
                let missed = vibevalley_core::cron::is_missed(due, at);
                let after = vibevalley_core::cron_from_rules(vibevalley_core::cron::after_run(due, at));
                let words = vibevalley_core::cron::due_text(due, missed);
                (after, words, prev_last_run)
            })
            .collect();
        let mut claimed = Vec::with_capacity(due_runs.len());
        for (after, words, prev_last_run) in due_runs {
            if let Err(e) = self.put_async(after.clone()).await {
                // Not kept: due again at the next tick.
                self.ctx
                    .live
                    .publish_notice(self.ctx.now(), NoticeLevel::Warn, format!("cron {}: {}", after.id, e.message));
                continue;
            }
            claimed.push(DueCron {
                cron: after,
                words,
                prev_last_run,
                at,
            });
        }
        claimed
    }

    pub(crate) async fn list_endpoint_async(&self) -> Result<Vec<Cron>, ApiError> {
        Ok(self.list())
    }

    pub(crate) async fn update_endpoint_async(&self, id: &str, enabled: Option<bool>) -> Result<(), ApiError> {
        match enabled {
            Some(enabled) => {
                self.set_enabled_async(id, enabled).await?;
            }
            None => {
                self.find(id)?;
            }
        }
        Ok(())
    }

    pub(crate) async fn delete_endpoint_async(&self, id: &str) -> Result<(), ApiError> {
        self.remove_async(id).await.map(|_| ())
    }

    pub(crate) async fn preview_delete_endpoint_async(&self, id: &str) -> Result<Preview, ApiError> {
        self.preview_remove(id)
    }
}
