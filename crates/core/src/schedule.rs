//! Issue Gantt/calendar schedule derivation: parent-child date rollup,
//! overdue detection, and hierarchical timeline sorting.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use vibevalley_protocol::{BoardSchedule, BoardScheduleEntry, Issue, IssueScheduleSpan, JsNumber, Priority};

pub const DAY_MS: i64 = 86_400_000;

/// Normalizes any Unix millisecond timestamp to UTC midnight (`00:00:00.000Z`).
pub fn utc_day_start(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS) * DAY_MS
}

/// Shifts a UTC day-start timestamp by `days`.
pub fn add_utc_days(day_ms: i64, days: i64) -> i64 {
    day_ms + days * DAY_MS
}

/// Signed integer day distance from `start_ms` to `end_ms` on UTC day boundaries.
pub fn utc_day_diff(start_ms: i64, end_ms: i64) -> i64 {
    (utc_day_start(end_ms) - utc_day_start(start_ms)) / DAY_MS
}

fn positive_js_timestamp(value: Option<JsNumber>) -> Option<i64> {
    value.and_then(|n| {
        let f = n.get();
        (f.is_finite() && f > 0.0).then_some(f.floor() as i64)
    })
}

fn positive_i64_timestamp(value: Option<i64>) -> Option<i64> {
    value.filter(|&v| v > 0)
}

fn priority_weight(priority: Priority) -> u8 {
    match priority {
        Priority::Urgent => 0,
        Priority::High => 1,
        Priority::Medium => 2,
        Priority::Low => 3,
    }
}

#[derive(Clone, Copy)]
struct RawBounds {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    has_explicit_start: bool,
    has_explicit_due: bool,
    rolled_up: bool,
}

fn resolve_bounds(
    issue: &Issue,
    children_by_parent: &HashMap<&str, Vec<&Issue>>,
    resolved: &mut HashMap<String, RawBounds>,
    visiting: &mut HashSet<String>,
) -> RawBounds {
    if let Some(cached) = resolved.get(&issue.id) {
        return *cached;
    }
    if !visiting.insert(issue.id.clone()) {
        return RawBounds {
            start_ms: None,
            end_ms: None,
            has_explicit_start: false,
            has_explicit_due: false,
            rolled_up: false,
        };
    }

    let explicit_start = positive_js_timestamp(issue.start_at);
    let explicit_due = positive_js_timestamp(issue.due_at);
    let has_explicit_start = explicit_start.is_some();
    let has_explicit_due = explicit_due.is_some();
    let mut start_ms = explicit_start.map(utc_day_start);
    let mut end_ms = explicit_due.map(utc_day_start);
    let mut rolled_up = false;

    if let Some(children) = children_by_parent.get(issue.id.as_str())
        && !children.is_empty()
        && (start_ms.is_none() || end_ms.is_none())
    {
        let mut min_child_start: Option<i64> = None;
        let mut max_child_due: Option<i64> = None;
        for &child in children {
            let cb = resolve_bounds(child, children_by_parent, resolved, visiting);
            let c_start = cb.start_ms.or(cb.end_ms);
            let c_end = cb.end_ms.or(cb.start_ms);
            if let Some(cs) = c_start
                && min_child_start.is_none_or(|m| cs < m)
            {
                min_child_start = Some(cs);
            }
            if let Some(ce) = c_end
                && max_child_due.is_none_or(|m| ce > m)
            {
                max_child_due = Some(ce);
            }
        }
        if start_ms.is_none()
            && let Some(ms) = min_child_start
        {
            start_ms = Some(ms);
            rolled_up = true;
        }
        if end_ms.is_none()
            && let Some(ms) = max_child_due
        {
            end_ms = Some(ms);
            rolled_up = true;
        }
    }

    visiting.remove(&issue.id);
    let out = RawBounds {
        start_ms,
        end_ms,
        has_explicit_start,
        has_explicit_due,
        rolled_up,
    };
    resolved.insert(issue.id.clone(), out);
    out
}

/// Computes normalized schedule bounds for every issue, rolling up child start/due
/// bounds onto parents missing explicit dates.
pub fn compute_issue_spans(issues: &[Issue], now_ms: i64) -> BTreeMap<String, IssueScheduleSpan> {
    let mut children_by_parent: HashMap<&str, Vec<&Issue>> = HashMap::new();
    for issue in issues {
        if let Some(parent) = issue.parent.as_deref() {
            children_by_parent.entry(parent).or_default().push(issue);
        }
    }

    let today_day_ms = utc_day_start(now_ms);
    let mut resolved: HashMap<String, RawBounds> = HashMap::with_capacity(issues.len());
    let mut visiting: HashSet<String> = HashSet::new();
    for issue in issues {
        resolve_bounds(issue, &children_by_parent, &mut resolved, &mut visiting);
    }

    let mut spans = BTreeMap::new();
    for issue in issues {
        let Some(b) = resolved.get(&issue.id).copied() else {
            continue;
        };
        if b.start_ms.is_none() && b.end_ms.is_none() {
            continue;
        }

        let (start_ms, end_ms) = match (b.start_ms, b.end_ms) {
            (Some(s), Some(e)) => (s, e.max(s)),
            (Some(s), None) => {
                let closed_day = positive_i64_timestamp(issue.closed_at).map(utc_day_start);
                let e = closed_day.filter(|&cd| cd >= s).unwrap_or(s);
                (s, e)
            }
            (None, Some(e)) => (e, e),
            (None, None) => unreachable!(),
        };

        let duration_days = (utc_day_diff(start_ms, end_ms) + 1).max(1);
        let due_basis = b.end_ms.or(b.has_explicit_due.then_some(end_ms));
        let overdue = !issue.status.is_closed() && due_basis.is_some_and(|d| d < today_day_ms);

        spans.insert(
            issue.id.clone(),
            IssueScheduleSpan {
                start_ms,
                end_ms,
                duration_days,
                has_explicit_start: b.has_explicit_start,
                has_explicit_due: b.has_explicit_due,
                rolled_up: b.rolled_up,
                overdue,
            },
        );
    }
    spans
}

fn compare_scheduled_items(a: (&Issue, &IssueScheduleSpan), b: (&Issue, &IssueScheduleSpan)) -> Ordering {
    a.1.start_ms
        .cmp(&b.1.start_ms)
        .then_with(|| a.1.end_ms.cmp(&b.1.end_ms))
        .then_with(|| priority_weight(a.0.priority).cmp(&priority_weight(b.0.priority)))
        .then_with(|| a.0.number.cmp(&b.0.number))
}

fn emit_hierarchical<'a>(
    issue: &'a Issue,
    depth: i64,
    spans: &BTreeMap<String, IssueScheduleSpan>,
    children_map: &HashMap<&str, Vec<&'a Issue>>,
    total_child_counts: &HashMap<&str, usize>,
    emitted: &mut HashSet<&'a str>,
    ordered: &mut Vec<BoardScheduleEntry>,
) {
    if !emitted.insert(issue.id.as_str()) {
        return;
    }
    let Some(span) = spans.get(&issue.id).cloned() else {
        return;
    };
    let children = children_map.get(issue.id.as_str()).map_or(&[][..], Vec::as_slice);
    let total_children = children.len().max(total_child_counts.get(issue.id.as_str()).copied().unwrap_or(0));
    ordered.push(BoardScheduleEntry {
        issue_id: issue.id.clone(),
        span,
        depth,
        is_parent: total_children > 0,
        child_count: total_children as i64,
    });
    for &child in children {
        emit_hierarchical(child, (depth + 1).min(3), spans, children_map, total_child_counts, emitted, ordered);
    }
}

/// Computes hierarchically sorted scheduled entries, unscheduled issue IDs, and
/// per-issue schedule spans for a board slice.
pub fn compute_board_schedule(issues: &[Issue], now_ms: i64) -> (BoardSchedule, BTreeMap<String, IssueScheduleSpan>) {
    let today_day_ms = utc_day_start(now_ms);
    let spans = compute_issue_spans(issues, now_ms);

    let mut total_child_counts: HashMap<&str, usize> = HashMap::new();
    for issue in issues {
        if let Some(parent) = issue.parent.as_deref() {
            *total_child_counts.entry(parent).or_default() += 1;
        }
    }

    let mut with_span: Vec<&Issue> = Vec::new();
    let mut unscheduled: Vec<&Issue> = Vec::new();
    for issue in issues {
        if spans.contains_key(&issue.id) {
            with_span.push(issue);
        } else {
            unscheduled.push(issue);
        }
    }

    let present_ids: HashSet<&str> = with_span.iter().map(|i| i.id.as_str()).collect();
    let mut children_map: HashMap<&str, Vec<&Issue>> = HashMap::new();
    let mut roots: Vec<&Issue> = Vec::new();
    for &issue in &with_span {
        if let Some(parent) = issue.parent.as_deref()
            && present_ids.contains(parent)
            && parent != issue.id
        {
            children_map.entry(parent).or_default().push(issue);
        } else {
            roots.push(issue);
        }
    }

    roots.sort_by(|a, b| compare_scheduled_items((a, &spans[&a.id]), (b, &spans[&b.id])));
    for list in children_map.values_mut() {
        list.sort_by(|a, b| compare_scheduled_items((a, &spans[&a.id]), (b, &spans[&b.id])));
    }

    let mut scheduled = Vec::with_capacity(with_span.len());
    let mut emitted: HashSet<&str> = HashSet::with_capacity(with_span.len());
    for root in roots {
        emit_hierarchical(root, 0, &spans, &children_map, &total_child_counts, &mut emitted, &mut scheduled);
    }
    // Safety net for disconnected parent-cycle fragments.
    for issue in with_span {
        if !emitted.contains(issue.id.as_str()) {
            emit_hierarchical(issue, 0, &spans, &children_map, &total_child_counts, &mut emitted, &mut scheduled);
        }
    }

    unscheduled.sort_by(|a, b| {
        priority_weight(a.priority)
            .cmp(&priority_weight(b.priority))
            .then_with(|| a.number.cmp(&b.number))
    });
    let unscheduled_ids = unscheduled.into_iter().map(|i| i.id.clone()).collect();

    (
        BoardSchedule {
            today_day_ms,
            scheduled,
            unscheduled_ids,
        },
        spans,
    )
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::IssueStatus;

    use super::*;

    fn utc_ms(year: i16, month: i8, day: i8, hour: i8) -> i64 {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:00:00Z")
            .parse::<jiff::Timestamp>()
            .expect("valid utc date")
            .as_millisecond()
    }

    #[test]
    fn computes_explicit_spans_closed_at_fallback_overdue_flags_and_unscheduled() {
        let now = utc_ms(2026, 11, 20, 12);

        let mut explicit_span = Issue::new("i-span", 1, "Issue 1", utc_ms(2026, 11, 1, 0));
        explicit_span.start_at = Some(JsNumber(utc_ms(2026, 11, 18, 0) as f64));
        explicit_span.due_at = Some(JsNumber(utc_ms(2026, 11, 22, 0) as f64));

        let mut overdue_open = Issue::new("i-overdue", 2, "Issue 2", utc_ms(2026, 11, 1, 0));
        overdue_open.status = IssueStatus::InProgress;
        overdue_open.due_at = Some(JsNumber(utc_ms(2026, 11, 19, 0) as f64));

        let mut closed_past_due = Issue::new("i-closed", 3, "Issue 3", utc_ms(2026, 11, 1, 0));
        closed_past_due.status = IssueStatus::Done;
        closed_past_due.start_at = Some(JsNumber(utc_ms(2026, 11, 10, 0) as f64));
        closed_past_due.due_at = Some(JsNumber(utc_ms(2026, 11, 15, 0) as f64));
        closed_past_due.closed_at = Some(utc_ms(2026, 11, 14, 0));

        let mut start_and_closed = Issue::new("i-start-closed", 4, "Issue 4", utc_ms(2026, 11, 1, 0));
        start_and_closed.status = IssueStatus::Done;
        start_and_closed.start_at = Some(JsNumber(utc_ms(2026, 11, 12, 0) as f64));
        start_and_closed.closed_at = Some(utc_ms(2026, 11, 16, 0));

        let mut unscheduled = Issue::new("i-none", 5, "Issue 5", utc_ms(2026, 11, 1, 0));
        unscheduled.priority = Priority::Urgent;

        let (schedule, _spans) = compute_board_schedule(&[explicit_span, overdue_open, closed_past_due, start_and_closed, unscheduled], now);
        assert_eq!(schedule.today_day_ms, utc_ms(2026, 11, 20, 0));
        assert_eq!(schedule.unscheduled_ids, vec!["i-none".to_string()]);
        let ids: Vec<&str> = schedule.scheduled.iter().map(|s| s.issue_id.as_str()).collect();
        assert_eq!(ids, vec!["i-closed", "i-start-closed", "i-span", "i-overdue"]);

        let by_id: HashMap<&str, &IssueScheduleSpan> = schedule.scheduled.iter().map(|s| (s.issue_id.as_str(), &s.span)).collect();
        assert_eq!(
            by_id["i-span"],
            &IssueScheduleSpan {
                start_ms: utc_ms(2026, 11, 18, 0),
                end_ms: utc_ms(2026, 11, 22, 0),
                duration_days: 5,
                has_explicit_start: true,
                has_explicit_due: true,
                rolled_up: false,
                overdue: false,
            }
        );
        assert_eq!(
            by_id["i-overdue"],
            &IssueScheduleSpan {
                start_ms: utc_ms(2026, 11, 19, 0),
                end_ms: utc_ms(2026, 11, 19, 0),
                duration_days: 1,
                has_explicit_start: false,
                has_explicit_due: true,
                rolled_up: false,
                overdue: true,
            }
        );
        assert!(!by_id["i-closed"].overdue);
        assert_eq!(
            by_id["i-start-closed"],
            &IssueScheduleSpan {
                start_ms: utc_ms(2026, 11, 12, 0),
                end_ms: utc_ms(2026, 11, 16, 0),
                duration_days: 5,
                has_explicit_start: true,
                has_explicit_due: false,
                rolled_up: false,
                overdue: false,
            }
        );
    }

    #[test]
    fn rolls_up_child_dates_onto_parent_and_orders_children_beneath_parent() {
        let now = utc_ms(2026, 11, 20, 0);
        let parent = Issue::new("p-1", 10, "Epic", utc_ms(2026, 11, 1, 0));

        let mut child_a = Issue::new("c-1", 11, "Child A", utc_ms(2026, 11, 1, 0));
        child_a.parent = Some("p-1".to_string());
        child_a.start_at = Some(JsNumber(utc_ms(2026, 11, 25, 0) as f64));
        child_a.due_at = Some(JsNumber(utc_ms(2026, 11, 28, 0) as f64));

        let mut child_b = Issue::new("c-2", 12, "Child B", utc_ms(2026, 11, 1, 0));
        child_b.parent = Some("p-1".to_string());
        child_b.start_at = Some(JsNumber(utc_ms(2026, 11, 21, 0) as f64));
        child_b.due_at = Some(JsNumber(utc_ms(2026, 12, 2, 0) as f64));

        let mut sibling = Issue::new("s-1", 13, "Sibling", utc_ms(2026, 11, 1, 0));
        sibling.start_at = Some(JsNumber(utc_ms(2026, 11, 22, 0) as f64));
        sibling.due_at = Some(JsNumber(utc_ms(2026, 11, 24, 0) as f64));

        let (schedule, _) = compute_board_schedule(&[child_a, parent, sibling, child_b], now);
        assert!(schedule.unscheduled_ids.is_empty());
        let summary: Vec<(&str, i64, bool)> = schedule.scheduled.iter().map(|r| (r.issue_id.as_str(), r.depth, r.is_parent)).collect();
        assert_eq!(summary, vec![("p-1", 0, true), ("c-2", 1, false), ("c-1", 1, false), ("s-1", 0, false)]);
        assert_eq!(schedule.scheduled[0].span.start_ms, utc_ms(2026, 11, 21, 0));
        assert_eq!(schedule.scheduled[0].span.end_ms, utc_ms(2026, 12, 2, 0));
        assert!(schedule.scheduled[0].span.rolled_up);
        assert_eq!(schedule.scheduled[0].span.duration_days, 12);
    }
}
