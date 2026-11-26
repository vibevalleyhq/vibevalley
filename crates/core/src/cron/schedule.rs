use std::collections::BTreeSet;
use std::sync::OnceLock;

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use vibevalley_i18n::{Value, t};

const MIN_EVERY_MINUTES: f64 = 1.0;
const DAY_MS: i64 = 86_400_000;
/// Long enough for a 29th of February, even across a century that skips one.
const SEARCH_DAYS: i64 = 366 * 9;
/// A run later than this after it was due was missed (the server was off).
const MISSED_AFTER_MS: i64 = 5 * 60_000;

/// VibeValley's `CronWhen`, told apart by `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CronWhen {
    Once { at: i64 },
    Every { minutes: f64 },
    Daily { time: String },
    Weekly { days: Vec<i64>, time: String },
    Cron { expr: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorKind {
    User,
    Agent,
    System,
}

/// VibeValley's `Cron`, same wire shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cron {
    pub id: String,
    pub name: String,
    pub text: String,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub when: CronWhen,
    pub tz: String,
    pub enabled: bool,
    pub created: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<i64>,
    pub by: ActorKind,
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRequest {
    pub name: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub when: CronWhen,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
}

/// A fixed offset from UTC, or a zone known by name.
#[derive(Debug, Clone)]
pub enum Zone {
    Offset(i64),
    Named(TimeZone),
}

fn time_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^([01]?\d|2[0-3]):([0-5]\d)$").expect("regex"))
}

fn offset_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^(?:GMT)?([+-])([01]\d|2[0-3])(?::?([0-5]\d))?$").expect("regex"))
}

/// IANA or a fixed offset (`+08:00`, `+0800`, `+08`, `GMT+08:00`).
pub fn given_zone(tz: &str) -> Option<Zone> {
    if let Some(c) = offset_re().captures(tz) {
        let sign = if &c[1] == "-" { -1 } else { 1 };
        let hours: i64 = c[2].parse().ok()?;
        let minutes: i64 = c.get(3).map_or(Ok(0), |m| m.as_str().parse()).ok()?;
        return Some(Zone::Offset(sign * (hours * 60 + minutes) * 60_000));
    }
    if tz.starts_with('+') || tz.starts_with('-') || tz.is_empty() || tz == "Local" {
        return None;
    }
    TimeZone::get(tz).ok().map(Zone::Named)
}

fn local_zone() -> Zone {
    Zone::Named(TimeZone::system())
}

const UTC: Zone = Zone::Offset(0);

/// How far the zone's wall clock is ahead of UTC at instant `at` (ms).
fn offset_at(at: i64, zone: &Zone) -> i64 {
    match zone {
        Zone::Offset(ms) => *ms,
        Zone::Named(tz) => {
            let Ok(ts) = Timestamp::from_millisecond(at) else { return 0 };
            i64::from(tz.to_offset(ts).seconds()) * 1000
        }
    }
}

/// A wall time as UTC milliseconds (`Date.UTC`).
fn utc_ms(year: i16, month: i8, day: i8, hour: i8, minute: i8) -> i64 {
    Date::new(year, month, day)
        .and_then(|d| d.at(hour, minute, 0, 0).to_zoned_datetime(TimeZone::UTC))
        .map(|z| z.timestamp().as_millisecond())
        .unwrap_or(i64::MIN)
}

/// The wall clock at an instant, as UTC fields.
fn wall_of(at: i64, zone: &Zone) -> jiff::civil::DateTime {
    let ts = Timestamp::from_millisecond(at + offset_at(at, zone)).unwrap_or(Timestamp::UNIX_EPOCH);
    ts.to_zoned_datetime(TimeZone::UTC).datetime()
}

/// The instant a wall time names: in a fold the earlier; in a gap as if the
/// clock had not moved yet.
fn instant_of(wall: i64, zone: &Zone) -> i64 {
    if let Zone::Offset(ms) = zone {
        return wall - ms;
    }
    let before = offset_at(wall - DAY_MS, zone);
    let after = offset_at(wall + DAY_MS, zone);
    [wall - before, wall - after]
        .into_iter()
        .filter(|at| at + offset_at(*at, zone) == wall)
        .min()
        .unwrap_or(wall - before)
}

/// Empty sets mean any; `and`: both day fields must match, else either.
#[derive(Debug, Clone)]
struct Spec {
    minutes: BTreeSet<i64>,
    hours: BTreeSet<i64>,
    days: BTreeSet<i64>,
    months: BTreeSet<i64>,
    weekdays: BTreeSet<i64>,
    and: bool,
}

fn day_due(spec: &Spec, day: Date) -> bool {
    if !spec.months.is_empty() && !spec.months.contains(&i64::from(day.month())) {
        return false;
    }
    let (dom, dow) = (i64::from(day.day()), i64::from(day.weekday().to_sunday_zero_offset()));
    let (days, weekdays) = (&spec.days, &spec.weekdays);
    if days.is_empty() && weekdays.is_empty() {
        return true;
    }
    if spec.and {
        return (days.is_empty() || days.contains(&dom)) && (weekdays.is_empty() || weekdays.contains(&dow));
    }
    if weekdays.is_empty() {
        return days.contains(&dom);
    }
    if days.is_empty() {
        return weekdays.contains(&dow);
    }
    days.contains(&dom) || weekdays.contains(&dow)
}

fn ascending(set: &BTreeSet<i64>, lo: i64, hi: i64) -> Vec<i64> {
    if set.is_empty() { (lo..=hi).collect() } else { set.iter().copied().collect() }
}

fn next_of(spec: &Spec, zone: &Zone, from: i64) -> Option<i64> {
    let start = wall_of(from, zone).date();
    let hours = ascending(&spec.hours, 0, 23);
    let minutes = ascending(&spec.minutes, 0, 59);
    // From a day early: a fold can put the day before's wall time after from.
    for i in -1..SEARCH_DAYS {
        let Ok(day) = start.checked_add(jiff::Span::new().days(i)) else { continue };
        if !day_due(spec, day) {
            continue;
        }
        for &h in &hours {
            for &mi in &minutes {
                let at = instant_of(utc_ms(day.year(), day.month(), day.day(), h as i8, mi as i8), zone);
                if at > from {
                    return Some(at);
                }
            }
        }
    }
    None
}

fn daily(from: i64, at: &str, days: &[i64], tz: &str) -> Option<i64> {
    let c = time_re().captures(at)?;
    let zone = given_zone(tz)?;
    // Cron reads only 0 to 7 (7 is Sunday again).
    if days.iter().any(|d| *d < 0 || *d > 7) {
        return None;
    }
    let spec = Spec {
        minutes: [c[2].parse().ok()?].into(),
        hours: [c[1].parse().ok()?].into(),
        days: BTreeSet::new(),
        months: BTreeSet::new(),
        weekdays: days.iter().map(|d| d % 7).collect(),
        and: false,
    };
    next_of(&spec, &zone, from)
}

pub(super) fn next_run(s: &Cron) -> Option<i64> {
    if !s.enabled {
        return None;
    }
    let from = s.last_run.unwrap_or(s.created);
    match &s.when {
        CronWhen::Once { at } => s.last_run.is_none().then_some(*at),
        // A fraction of a millisecond is due at the next whole one.
        CronWhen::Every { minutes } => Some((from as f64 + minutes * 60_000.0).ceil() as i64),
        CronWhen::Daily { time } => daily(from, time, &[], &s.tz),
        CronWhen::Weekly { days, time } => daily(from, time, days, &s.tz),
        CronWhen::Cron { expr } => {
            let spec = parse_cron(expr).ok()?;
            next_of(&spec, &given_zone(&s.tz)?, from)
        }
    }
}

const FIELDS: [(i64, i64, &str); 5] = [(0, 59, "0"), (0, 23, "1"), (1, 31, "2"), (1, 12, "3"), (0, 7, "4")];

/// Go's strconv.Atoi: an optional sign and ASCII digits.
fn atoi(s: &str) -> Option<i64> {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Go's strings.Fields.
fn fields(s: &str) -> Vec<&str> {
    s.split(|c: char| c.is_whitespace() || c == '\u{85}').filter(|f| !f.is_empty()).collect()
}

fn cron_field(field: &str, (lo, hi, key): (i64, i64, &str)) -> Result<BTreeSet<i64>, String> {
    let bad = || {
        t(
            "server.cron.expr.badField",
            &[("name", t(&format!("server.cron.expr.fields.{key}"), &[]).into()), ("field", field.into())],
        )
    };
    let mut bits = BTreeSet::new();
    for item in field.split(',') {
        let (span, step) = match item.find('/') {
            Some(at) => {
                let n = atoi(&item[at + 1..]).filter(|n| *n >= 1).ok_or_else(bad)?;
                (&item[..at], Some(n))
            }
            None => (item, None),
        };
        let (mut from, mut to) = (lo, hi);
        if span != "*" {
            match span.find('-') {
                Some(dash) => {
                    from = atoi(&span[..dash]).ok_or_else(bad)?;
                    to = atoi(&span[dash + 1..]).ok_or_else(bad)?;
                }
                None => {
                    from = atoi(span).ok_or_else(bad)?;
                    to = if step.is_some() { hi } else { from };
                }
            }
        }
        if from < lo || to > hi || from > to {
            return Err(bad());
        }
        let mut v = from;
        while v <= to {
            bits.insert(v);
            v += step.unwrap_or(1);
        }
    }
    Ok(bits)
}

fn parse_cron(expr: &str) -> Result<Spec, String> {
    let f = fields(expr);
    if f.len() != 5 {
        return Err(t("server.cron.expr.fiveFields", &[]));
    }
    let minutes = cron_field(f[0], FIELDS[0])?;
    let hours = cron_field(f[1], FIELDS[1])?;
    let days = cron_field(f[2], FIELDS[2])?;
    let months = cron_field(f[3], FIELDS[3])?;
    let mut weekdays = cron_field(f[4], FIELDS[4])?;
    if weekdays.remove(&7) {
        weekdays.insert(0);
    }
    Ok(Spec {
        minutes,
        hours,
        days,
        months,
        weekdays,
        and: f[2].starts_with('*') || f[4].starts_with('*'),
    })
}

fn weekday(d: i64) -> String {
    t(&format!("server.cron.weekdays.{d}"), &[])
}

fn list(items: Vec<String>) -> String {
    vibevalley_i18n::list(&items)
}

/// `M/D HH:MM` in the cron's zone (UTC when the zone is none).
fn clock(at: i64, tz: &str) -> String {
    let w = wall_of(at, &given_zone(tz).unwrap_or(UTC));
    format!("{}/{} {:02}:{:02}", w.month(), w.day(), w.hour(), w.minute())
}

pub fn when_text(when: &CronWhen, tz: &str) -> String {
    match when {
        CronWhen::Once { at } => t("server.cron.when.once", &[("clock", clock(*at, tz).into())]),
        CronWhen::Every { minutes } => {
            if minutes % 60.0 == 0.0 {
                t("server.cron.when.hours", &[("n", Value::Num(minutes / 60.0))])
            } else {
                t("server.cron.when.minutes", &[("n", Value::Num(*minutes))])
            }
        }
        CronWhen::Daily { time } => t("server.cron.when.daily", &[("time", time.as_str().into())]),
        CronWhen::Weekly { days, time } => {
            let set: BTreeSet<i64> = days.iter().copied().collect();
            let words = set.into_iter().map(|d| if (0..7).contains(&d) { weekday(d) } else { d.to_string() }).collect();
            t("server.cron.when.weekly", &[("days", list(words).into()), ("time", time.as_str().into())])
        }
        CronWhen::Cron { expr } => cron_text(expr),
    }
}

/// The common shapes in words, the rest as the expression itself.
fn cron_text(expr: &str) -> String {
    let plain = || t("server.cron.when.cron", &[("expr", expr.into())]);
    if parse_cron(expr).is_err() {
        return plain();
    }
    let f = fields(expr);
    let (f0, f1, f2, f3, f4) = (f[0], f[1], f[2], f[3], f[4]);
    let (mi, h) = (atoi(f0), atoi(f1));
    let clock = match (mi, h) {
        (Some(mi), Some(h)) => format!("{:02}:{:02}", h, mi),
        _ => String::new(),
    };
    if !clock.is_empty() && f2 == "*" && f3 == "*" {
        match f4 {
            "*" => return t("server.cron.when.daily", &[("time", clock.into())]),
            "1-5" => return t("server.cron.when.weekdays", &[("time", clock.into())]),
            "0,6" | "6,0" | "6,7" | "6-7" => return t("server.cron.when.weekend", &[("time", clock.into())]),
            _ => {}
        }
        let mut days = BTreeSet::new();
        for d in f4.split(',') {
            match atoi(d) {
                Some(n) => days.insert(n % 7),
                None => return plain(),
            };
        }
        let words = days.into_iter().map(weekday).collect();
        return t("server.cron.when.weekly", &[("days", list(words).into()), ("time", clock.into())]);
    }
    if !clock.is_empty() && f3 == "*" && f4 == "*" {
        return match atoi(f2) {
            Some(d) => t("server.cron.when.monthly", &[("day", d.into()), ("time", clock.into())]),
            None => plain(),
        };
    }
    if let Some(mi) = mi
        && f1 == "*"
        && f2 == "*"
        && f3 == "*"
        && f4 == "*"
    {
        return t("server.cron.when.hourly", &[("minute", mi.into())]);
    }
    plain()
}

pub fn next_text(s: &Cron) -> String {
    if let Some(next) = next_run(s) {
        return clock(next, &s.tz);
    }
    let key = if s.enabled {
        "server.cron.next.never"
    } else if s.pending {
        "server.cron.next.pending"
    } else if matches!(s.when, CronWhen::Once { .. }) && s.last_run.is_some() {
        "server.cron.next.done"
    } else {
        "server.cron.next.off"
    };
    t(key, &[])
}

/// Each due cron once, however many runs it missed.
pub fn due_crons(all: &[Cron], now: i64) -> Vec<&Cron> {
    all.iter().filter(|s| next_run(s).is_some_and(|n| n <= now)).collect()
}

pub fn is_missed(s: &Cron, now: i64) -> bool {
    now - next_run(s).unwrap_or(now) > MISSED_AFTER_MS
}

/// A one-off runs once: then it is off.
pub fn after_run(s: &Cron, now: i64) -> Cron {
    Cron {
        last_run: Some(now),
        enabled: if matches!(s.when, CronWhen::Once { .. }) { false } else { s.enabled },
        ..s.clone()
    }
}

/// Whether a cron waits for the user's yes. `for_user`: set on the user's
/// own word this turn.
pub fn needs_ok(req: &CronRequest, for_user: bool) -> bool {
    !for_user && (!matches!(req.when, CronWhen::Once { .. }) || !req.agent.as_deref().unwrap_or("").trim().is_empty())
}

/// What is wrong with a request, or "" when nothing is.
pub fn cron_problem(req: &CronRequest, now: i64) -> String {
    if req.name.trim().is_empty() {
        return t("server.cron.problem.noName", &[]);
    }
    if req.text.trim().is_empty() {
        return t("server.cron.problem.noText", &[]);
    }
    if let Some(tz) = &req.tz
        && given_zone(tz).is_none()
    {
        return t("server.cron.problem.zone", &[("tz", tz.as_str().into())]);
    }
    let bad_time = |time: &str| t("server.cron.problem.time", &[("time", time.into())]);
    match &req.when {
        CronWhen::Once { at } => {
            if *at > now {
                String::new()
            } else {
                t("server.cron.problem.past", &[])
            }
        }
        CronWhen::Every { minutes } => {
            if *minutes >= MIN_EVERY_MINUTES {
                String::new()
            } else {
                t("server.cron.problem.every", &[("min", Value::Num(MIN_EVERY_MINUTES))])
            }
        }
        CronWhen::Daily { time } => {
            if time_re().is_match(time) {
                String::new()
            } else {
                bad_time(time)
            }
        }
        CronWhen::Weekly { days, time } => {
            if !time_re().is_match(time) {
                bad_time(time)
            } else if !days.is_empty() && days.iter().all(|d| (0..=6).contains(d)) {
                String::new()
            } else {
                t("server.cron.problem.days", &[])
            }
        }
        CronWhen::Cron { expr } => match parse_cron(expr) {
            Err(e) => e,
            Ok(spec) => {
                let zone = req.tz.as_deref().and_then(given_zone).unwrap_or_else(local_zone);
                if next_of(&spec, &zone, now).is_none() {
                    t("server.cron.expr.never", &[("expr", expr.as_str().into())])
                } else {
                    String::new()
                }
            }
        },
    }
}

pub fn due_text(s: &Cron, missed: bool) -> String {
    t(
        "server.cron.due",
        &[("name", s.name.as_str().into()), ("missed", missed.into()), ("text", s.text.as_str().into())],
    )
}
