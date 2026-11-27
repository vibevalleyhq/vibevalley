//! Personal event push routing, quiet hours, deduplication, and rate limiting
//! for linked chat connectors (primarily WeChat iLink Bot).

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use parking_lot::Mutex;
use vibevalley_core::cron::{Zone, given_zone};
use vibevalley_protocol::{ApiError, ConnectorID, Issue, Millis, Notify, Session};

use super::digest::{PersonalEvent, format_personal_event, personal_event_for_issue};
use crate::context::{Context, OutboxConnectorNotify, OutboxEvent};

const MAX_DEDUPE_ENTRIES: usize = 2048;

/// Local wall-clock quiet window during which non-urgent pushes are suppressed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuietHours {
    /// Minutes since local midnight `[0, 1440)` when quiet hours begin (inclusive).
    pub start_minute: u16,
    /// Minutes since local midnight `[0, 1440)` when quiet hours end (exclusive).
    /// When `start_minute > end_minute`, the window wraps across midnight.
    pub end_minute: u16,
    /// IANA zone or fixed offset (e.g. `"Asia/Shanghai"`, `"+08:00"`, `"UTC"`).
    pub tz: String,
    /// When true, urgent events (`Asking`, `Conflict`, `Interrupted`, `Failed`) still push immediately.
    pub allow_urgent: bool,
}

impl QuietHours {
    pub fn new(start_hour: u8, start_minute: u8, end_hour: u8, end_minute: u8, tz: impl Into<String>, allow_urgent: bool) -> Self {
        Self {
            start_minute: u16::from(start_hour % 24) * 60 + u16::from(start_minute % 60),
            end_minute: u16::from(end_hour % 24) * 60 + u16::from(end_minute % 60),
            tz: tz.into(),
            allow_urgent,
        }
    }

    pub fn contains(&self, at_ms: Millis) -> bool {
        if self.start_minute == self.end_minute {
            return false;
        }
        let minute_of_day = local_minute_of_day(at_ms, &self.tz);
        if self.start_minute < self.end_minute {
            self.start_minute <= minute_of_day && minute_of_day < self.end_minute
        } else {
            minute_of_day >= self.start_minute || minute_of_day < self.end_minute
        }
    }
}

fn local_minute_of_day(at_ms: Millis, tz: &str) -> u16 {
    let offset_ms = match given_zone(tz) {
        Some(Zone::Offset(ms)) => ms,
        Some(Zone::Named(named)) => Timestamp::from_millisecond(at_ms)
            .map(|ts| i64::from(named.to_offset(ts).seconds()) * 1000)
            .unwrap_or(0),
        None => Timestamp::from_millisecond(at_ms)
            .map(|ts| i64::from(TimeZone::system().to_offset(ts).seconds()) * 1000)
            .unwrap_or(0),
    };
    let local_ts = Timestamp::from_millisecond(at_ms.saturating_add(offset_ms)).unwrap_or(Timestamp::UNIX_EPOCH);
    let dt = local_ts.to_zoned_datetime(TimeZone::UTC).datetime();
    u16::from(dt.hour() as u8) * 60 + u16::from(dt.minute() as u8)
}

/// Configuration controlling personal push targets, quiet rules, dedupe, and rate limits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyOptions {
    pub push_targets: Vec<ConnectorID>,
    pub digest_targets: Vec<ConnectorID>,
    pub rate_limit_max: usize,
    pub rate_limit_window: Duration,
    pub issue_cooldown: Duration,
    pub dedupe_ttl: Duration,
    pub quiet_hours: Option<QuietHours>,
}

impl Default for NotifyOptions {
    fn default() -> Self {
        Self {
            push_targets: vec![ConnectorID::Weixin],
            digest_targets: vec![ConnectorID::Weixin],
            rate_limit_max: 5,
            rate_limit_window: Duration::from_secs(60),
            issue_cooldown: Duration::from_secs(30),
            dedupe_ttl: Duration::from_secs(24 * 60 * 60),
            quiet_hours: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuppressReason {
    QuietChannel,
    QuietHours,
    ChildIssueReview,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyDecision {
    Allow,
    DeferUntil(Millis),
    Suppress(SuppressReason),
}

/// Pure, `Clock`-driven gate enforcing quiet rules, deduplication, cooldown, and sliding-window rate limiting.
pub struct NotifyGate {
    options: NotifyOptions,
    dedupe: HashMap<String, Millis>,
    issue_last_at: HashMap<(String, &'static str), Millis>,
    recent_sent: VecDeque<Millis>,
}

impl NotifyGate {
    pub fn new(options: NotifyOptions) -> Self {
        Self {
            options,
            dedupe: HashMap::new(),
            issue_last_at: HashMap::new(),
            recent_sent: VecDeque::new(),
        }
    }

    pub fn options(&self) -> &NotifyOptions {
        &self.options
    }

    fn prune_dedupe(&mut self, now_ms: Millis) {
        let ttl_ms = self.options.dedupe_ttl.as_millis().min(i64::MAX as u128) as i64;
        self.dedupe.retain(|_, ts| now_ms.saturating_sub(*ts) < ttl_ms);
        while self.dedupe.len() >= MAX_DEDUPE_ENTRIES {
            if let Some(oldest_key) = self.dedupe.iter().min_by_key(|(_, ts)| **ts).map(|(k, _)| k.clone()) {
                self.dedupe.remove(&oldest_key);
            } else {
                break;
            }
        }
    }

    pub fn evaluate(&mut self, event: &PersonalEvent, channel_notify: Notify, now_ms: Millis) -> NotifyDecision {
        if event.is_child_review {
            return NotifyDecision::Suppress(SuppressReason::ChildIssueReview);
        }
        if channel_notify == Notify::None {
            return NotifyDecision::Suppress(SuppressReason::QuietChannel);
        }
        if let Some(qh) = &self.options.quiet_hours
            && qh.contains(now_ms)
            && (!qh.allow_urgent || !event.is_urgent())
        {
            return NotifyDecision::Suppress(SuppressReason::QuietHours);
        }

        self.prune_dedupe(now_ms);
        if self.dedupe.contains_key(&event.dedupe_key) {
            return NotifyDecision::Suppress(SuppressReason::Duplicate);
        }

        let cooldown_ms = self.options.issue_cooldown.as_millis().min(i64::MAX as u128) as i64;
        let window_ms = self.options.rate_limit_window.as_millis().min(i64::MAX as u128) as i64;
        while self.recent_sent.front().is_some_and(|ts| *ts <= now_ms.saturating_sub(window_ms)) {
            self.recent_sent.pop_front();
        }

        let mut scheduled_at = now_ms;
        if cooldown_ms > 0
            && let Some(issue_id) = &event.issue_id
            && let Some(&last_at) = self.issue_last_at.get(&(issue_id.clone(), event.kind.category()))
            && last_at.saturating_add(cooldown_ms) > scheduled_at
        {
            scheduled_at = last_at.saturating_add(cooldown_ms);
        }

        if self.options.rate_limit_max == 0 {
            return NotifyDecision::Suppress(SuppressReason::QuietChannel);
        }
        if self.recent_sent.len() >= self.options.rate_limit_max {
            let slot_idx = self.recent_sent.len() - self.options.rate_limit_max;
            if let Some(&pivot) = self.recent_sent.get(slot_idx) {
                scheduled_at = scheduled_at.max(pivot.saturating_add(window_ms));
            }
        }

        self.dedupe.insert(event.dedupe_key.clone(), scheduled_at);
        if let Some(issue_id) = &event.issue_id {
            self.issue_last_at.insert((issue_id.clone(), event.kind.category()), scheduled_at);
        }
        self.recent_sent.push_back(scheduled_at);

        if scheduled_at > now_ms {
            NotifyDecision::DeferUntil(scheduled_at)
        } else {
            NotifyDecision::Allow
        }
    }
}

/// Coordinates issue stage tracking and durable Outbox submission for personal event pushes.
pub struct NotifyRouter {
    gate: Mutex<NotifyGate>,
    seen_issue_keys: Mutex<HashMap<String, String>>,
}

impl NotifyRouter {
    pub fn new(options: NotifyOptions) -> Self {
        Self {
            gate: Mutex::new(NotifyGate::new(options)),
            seen_issue_keys: Mutex::new(HashMap::new()),
        }
    }

    pub fn options(&self) -> NotifyOptions {
        self.gate.lock().options().clone()
    }

    /// Seeds initial issue fingerprints on boot so existing backlog is not pushed as new alerts.
    pub fn seed_issues(&self, issues: &[Issue], sessions: &[Session], now_ms: Millis) {
        let mut seen = self.seen_issue_keys.lock();
        let mut gate = self.gate.lock();
        for issue in issues {
            let summary = issue
                .latest_session_id()
                .and_then(|sid| sessions.iter().find(|s| &s.id == sid))
                .and_then(|s| s.last_run.as_ref())
                .map(|r| r.summary.as_str());
            if let Some(ev) = personal_event_for_issue(issue, summary, now_ms, None) {
                seen.insert(issue.id.clone(), ev.dedupe_key.clone());
                gate.dedupe.insert(ev.dedupe_key, now_ms);
            }
        }
    }

    /// Computes newly entered actionable events and exact superseded push `message_id`s
    /// (`"push:<dedupe_key>"`) whose issue stage settled or changed.
    pub fn diff_board_issues(
        &self,
        issues: &[Issue],
        sessions: &[Session],
        now_ms: Millis,
        channel_for_issue: impl Fn(&Issue) -> Option<String>,
    ) -> (Vec<PersonalEvent>, Vec<String>) {
        let mut seen = self.seen_issue_keys.lock();
        let mut new_events = Vec::new();
        let mut settled_messages = Vec::new();
        let mut live_ids = HashMap::with_capacity(issues.len());

        for issue in issues {
            let channel_id = channel_for_issue(issue);
            let summary = issue
                .latest_session_id()
                .and_then(|sid| sessions.iter().find(|s| &s.id == sid))
                .and_then(|s| s.last_run.as_ref())
                .map(|r| r.summary.as_str());
            if let Some(ev) = personal_event_for_issue(issue, summary, now_ms, channel_id) {
                live_ids.insert(issue.id.clone(), ev.dedupe_key.clone());
                match seen.get(&issue.id) {
                    Some(prev_key) if prev_key == &ev.dedupe_key => {}
                    Some(prev_key) => {
                        settled_messages.push(format!("push:{prev_key}"));
                        new_events.push(ev);
                    }
                    None => {
                        new_events.push(ev);
                    }
                }
            } else if let Some(prev_key) = seen.get(&issue.id) {
                settled_messages.push(format!("push:{prev_key}"));
            }
        }

        for (id, prev_key) in seen.iter() {
            if !live_ids.contains_key(id) {
                let msg_id = format!("push:{prev_key}");
                if !settled_messages.contains(&msg_id) {
                    settled_messages.push(msg_id);
                }
            }
        }
        *seen = live_ids;
        (new_events, settled_messages)
    }

    /// Evaluates quiet/dedupe/rate-limit rules and durably enqueues [`OutboxEvent::ConnectorNotify`].
    pub async fn submit_event_async(
        &self,
        ctx: &Context,
        target: Option<ConnectorID>,
        event: &PersonalEvent,
        channel_notify: Notify,
    ) -> Result<NotifyDecision, ApiError> {
        let now_ms = ctx.now();
        let decision = self.gate.lock().evaluate(event, channel_notify, now_ms);
        let available_at = match decision {
            NotifyDecision::Allow => now_ms,
            NotifyDecision::DeferUntil(at) => at,
            NotifyDecision::Suppress(_) => return Ok(decision),
        };
        let body = format_personal_event(event);
        let payload = OutboxEvent::ConnectorNotify(OutboxConnectorNotify {
            connector: target,
            dedupe_key: event.dedupe_key.clone(),
            message_id: event.outbox_message_id(),
            issue_id: event.issue_id.clone(),
            channel_id: event.channel_id.clone(),
            body,
            created_at: now_ms,
            urgent: event.is_urgent(),
        });
        ctx.outbox.enqueue_event_at(&payload, available_at).await?;
        if available_at <= now_ms {
            ctx.outbox.wake();
        }
        Ok(decision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::digest::PersonalEventKind;

    fn sample_event(issue: &str, key: &str, kind: PersonalEventKind) -> PersonalEvent {
        PersonalEvent {
            dedupe_key: key.into(),
            issue_id: Some(issue.into()),
            issue_number: Some(24),
            issue_title: Some("WeChat Push".into()),
            session_id: Some("s1".into()),
            channel_id: Some("general".into()),
            is_child_review: false,
            at: 1_700_000_000_000,
            kind,
        }
    }

    #[test]
    fn quiet_hours_handles_normal_and_midnight_wrap_and_urgency() {
        // 23:00..08:00 Asia/Shanghai (+08:00)
        let qh = QuietHours::new(23, 0, 8, 0, "Asia/Shanghai", true);
        // 2023-11-14T15:30:00Z == 23:30:00+08:00 (inside quiet hours)
        let night_ms = "2023-11-14T15:30:00Z".parse::<Timestamp>().unwrap().as_millisecond();
        // 2023-11-15T01:00:00Z == 09:00:00+08:00 (outside quiet hours)
        let morning_ms = "2023-11-15T01:00:00Z".parse::<Timestamp>().unwrap().as_millisecond();

        let mut gate = NotifyGate::new(NotifyOptions {
            quiet_hours: Some(qh),
            ..Default::default()
        });

        let review = sample_event("i1", "k-review", PersonalEventKind::IssueReviewing { summary: "done".into() });
        assert_eq!(
            gate.evaluate(&review, Notify::All, night_ms),
            NotifyDecision::Suppress(SuppressReason::QuietHours)
        );

        // Urgent asking still pushes immediately during quiet hours when `allow_urgent` is true.
        let asking = sample_event(
            "i1",
            "k-ask",
            PersonalEventKind::IssueAsking {
                question: "proceed?".into(),
                question_count: 1,
            },
        );
        assert_eq!(gate.evaluate(&asking, Notify::All, night_ms), NotifyDecision::Allow);

        // Next morning, non-urgent review is allowed.
        assert_eq!(gate.evaluate(&review, Notify::All, morning_ms), NotifyDecision::Allow);
    }

    #[test]
    fn dedupe_channel_quiet_cooldown_and_rate_limit_are_deterministic() {
        let mut gate = NotifyGate::new(NotifyOptions {
            rate_limit_max: 2,
            rate_limit_window: Duration::from_secs(60),
            issue_cooldown: Duration::from_secs(30),
            dedupe_ttl: Duration::from_secs(120),
            ..Default::default()
        });

        let e1 = sample_event("i1", "k1", PersonalEventKind::IssueReviewing { summary: "a".into() });
        assert_eq!(gate.evaluate(&e1, Notify::None, 1_000), NotifyDecision::Suppress(SuppressReason::QuietChannel));

        let mut child_review = e1.clone();
        child_review.is_child_review = true;
        assert_eq!(
            gate.evaluate(&child_review, Notify::All, 1_000),
            NotifyDecision::Suppress(SuppressReason::ChildIssueReview)
        );

        // First allow + duplicate suppressed.
        assert_eq!(gate.evaluate(&e1, Notify::All, 1_000), NotifyDecision::Allow);
        assert_eq!(gate.evaluate(&e1, Notify::All, 2_000), NotifyDecision::Suppress(SuppressReason::Duplicate));

        // Same (issue, category) within 30s cooldown defers until 31_000.
        let e1_b = sample_event("i1", "k1-b", PersonalEventKind::IssueReviewing { summary: "b".into() });
        assert_eq!(gate.evaluate(&e1_b, Notify::All, 5_000), NotifyDecision::DeferUntil(31_000));

        // Third notification within 60s window (rate_limit_max = 2) defers past oldest + 60s = 61_000.
        let e2 = sample_event("i2", "k2", PersonalEventKind::IssueReviewing { summary: "c".into() });
        assert_eq!(gate.evaluate(&e2, Notify::All, 10_000), NotifyDecision::DeferUntil(61_000));

        // After dedupe TTL (120s), k1 can be sent again.
        assert_eq!(gate.evaluate(&e1, Notify::All, 125_000), NotifyDecision::Allow);
    }

    #[tokio::test]
    async fn notify_router_submits_to_outbox_with_rate_limit_schedule_and_manual_clock() {
        use std::sync::Arc;

        use vibevalley_core::{Clock, ManualClock};

        use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
        use crate::service::Service;

        vibevalley_i18n::set_locale("zh");
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let outbox = Arc::new(Outbox::new(service.clone()).with_clock(clock.clone()));
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox.clone(),
            Arc::new(StateFeed::new()),
            clock.clone(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));

        let delivered = Arc::new(Mutex::new(Vec::<String>::new()));
        let delivered_tx = delivered.clone();
        outbox.register(crate::context::OUTBOX_CONNECTOR_NOTIFY, move |item| {
            let delivered_tx = delivered_tx.clone();
            async move {
                let p: OutboxConnectorNotify = item.decode().map_err(|e| e.to_string())?;
                delivered_tx.lock().push(p.message_id);
                Ok::<(), String>(())
            }
        });

        let router = NotifyRouter::new(NotifyOptions {
            rate_limit_max: 1,
            rate_limit_window: Duration::from_secs(60),
            issue_cooldown: Duration::from_secs(0),
            ..Default::default()
        });

        let e1 = sample_event("i1", "k1", PersonalEventKind::IssueReviewing { summary: "ready".into() });
        let e2 = sample_event("i2", "k2", PersonalEventKind::IssueReviewing { summary: "ready 2".into() });

        assert_eq!(
            router.submit_event_async(&ctx, Some(ConnectorID::Weixin), &e1, Notify::All).await.unwrap(),
            NotifyDecision::Allow
        );
        // Second event within 60s window is deferred in Outbox until now + 60s.
        assert_eq!(
            router.submit_event_async(&ctx, Some(ConnectorID::Weixin), &e2, Notify::All).await.unwrap(),
            NotifyDecision::DeferUntil(1_700_000_060_000)
        );
        // Duplicate is suppressed before touching Outbox.
        assert_eq!(
            router.submit_event_async(&ctx, Some(ConnectorID::Weixin), &e1, Notify::All).await.unwrap(),
            NotifyDecision::Suppress(SuppressReason::Duplicate)
        );

        // Drain at t=0 only delivers e1; e2 waits until t+60s.
        assert_eq!(outbox.drain_once(clock.now_ms()).await.unwrap(), 1);
        assert_eq!(delivered.lock().len(), 1);

        clock.advance(Duration::from_secs(59));
        assert_eq!(outbox.drain_once(clock.now_ms()).await.unwrap(), 0);

        clock.advance(Duration::from_secs(1));
        assert_eq!(outbox.drain_once(clock.now_ms()).await.unwrap(), 1);
        assert_eq!(delivered.lock().len(), 2);

        let _ = ctx.shutdown(Duration::from_secs(1)).await;
        service.close().await;
    }

    #[tokio::test]
    async fn notify_router_pushes_urgent_permission_requests_with_push_perm_id() {
        use std::sync::Arc;

        use vibevalley_core::{Clock, ManualClock};

        use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
        use crate::service::Service;

        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let outbox = Arc::new(Outbox::new(service.clone()).with_clock(clock.clone()));
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox.clone(),
            Arc::new(StateFeed::new()),
            clock.clone(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));

        let delivered = Arc::new(Mutex::new(Vec::<String>::new()));
        let delivered_tx = delivered.clone();
        outbox.register(crate::context::OUTBOX_CONNECTOR_NOTIFY, move |item| {
            let delivered_tx = delivered_tx.clone();
            async move {
                let p: OutboxConnectorNotify = item.decode().map_err(|e| e.to_string())?;
                delivered_tx.lock().push(p.message_id);
                Ok::<(), String>(())
            }
        });

        let router = NotifyRouter::new(NotifyOptions {
            quiet_hours: Some(QuietHours::new(0, 0, 23, 59, "UTC", true)),
            ..Default::default()
        });

        let perm = PersonalEvent {
            dedupe_key: "perm:sess-42:req-7".into(),
            issue_id: None,
            issue_number: None,
            issue_title: None,
            session_id: Some("sess-42".into()),
            channel_id: None,
            is_child_review: false,
            at: clock.now_ms(),
            kind: PersonalEventKind::PermissionRequest {
                request_id: "req-7".into(),
                session_name: "Workspace".into(),
                tool: "shell".into(),
                summary: "Run tests".into(),
                input: None,
            },
        };

        assert_eq!(
            router.submit_event_async(&ctx, Some(ConnectorID::Weixin), &perm, Notify::All).await.unwrap(),
            NotifyDecision::Allow
        );
        assert_eq!(
            router.submit_event_async(&ctx, Some(ConnectorID::Weixin), &perm, Notify::All).await.unwrap(),
            NotifyDecision::Suppress(SuppressReason::Duplicate)
        );
        assert_eq!(outbox.drain_once(clock.now_ms()).await.unwrap(), 1);
        assert_eq!(*delivered.lock(), vec!["push:perm:sess-42:req-7".to_string()]);

        let _ = ctx.shutdown(Duration::from_secs(1)).await;
        service.close().await;
    }
}
