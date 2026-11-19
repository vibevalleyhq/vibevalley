use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::diagram::timeline::scan::{collapse_newline_ws, trim_leading_ws};
use crate::error::{ErrorCode, PeleError};
use crate::util::chars::{is_space_char, is_word};
use crate::util::url::safe_url;

use super::dates::{DurationUnit, WEEKDAYS, add, add_days, clip_ms, format_date, iso_date, parse_js_date_fallback, parse_strict, start_of_day, weekday_of};
use super::types::{GanttRaw, GanttTask};

const WORK_LIMIT: usize = 400_000_000;
const DAY_STEP: usize = 400;
const DATED_STEP: usize = 200;
const FORMAT_STEP: usize = 400;

pub fn clock(now_ms: Option<i64>) -> i64 {
    if let Some(ms) = now_ms.and_then(|m| clip_ms(m as i128)) {
        return ms;
    }
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Parses a duration such as `"3d"`, `"1.5w"`, `"500ms"`.
pub fn parse_duration(raw: &str) -> Option<(f64, DurationUnit)> {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_digit() {
        return None;
    }
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let frac = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == frac {
            return None;
        }
    }
    let value: f64 = s[..i].parse().ok()?;
    let unit = match &s[i..] {
        "ms" => DurationUnit::Ms,
        "s" => DurationUnit::S,
        "m" => DurationUnit::M,
        "h" => DurationUnit::H,
        "d" => DurationUnit::D,
        "w" => DurationUnit::W,
        "M" => DurationUnit::Month,
        "y" => DurationUnit::Y,
        _ => return None,
    };
    Some((value, unit))
}

fn is_numeric_format(fmt: &str) -> bool {
    fmt.bytes().all(|b| {
        matches!(
            b,
            b'Y' | b'M' | b'D' | b'H' | b'h' | b'm' | b's' | b'S' | b'Z' | b'X' | b'x' | b'-' | b'/' | b'.' | b':' | b',' | b' ' | b'T'
        )
    })
}

fn is_day_name(token: &str) -> bool {
    matches!(token, "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday")
}

fn merge_tokens(existing: &mut Vec<String>, txt: &str) {
    let mut seen: HashSet<String> = existing.iter().cloned().collect();
    for piece in txt.to_ascii_lowercase().split(|c: char| is_space_char(c) || c == ',') {
        if !piece.is_empty() && seen.insert(piece.to_string()) {
            existing.push(piece.to_string());
        }
    }
}

fn extract_ref_list<'a>(str_val: &'a str, kw: &str) -> Option<&'a str> {
    let rest = str_val.strip_prefix(kw)?;
    let trimmed = rest.trim_start_matches(is_space_char);
    if trimmed.len() == rest.len() {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let mut end = 0;
    while end < bytes.len() && (is_word(bytes[end] as u32) || bytes[end] == b'-' || bytes[end] == b' ') {
        end += 1;
    }
    (end > 0).then_some(&trimmed[..end])
}

#[derive(Debug, Clone)]
pub struct GanttDb {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub date_format: String,
    pub axis_format: String,
    pub tick_interval: Option<String>,
    pub today_marker: String,
    pub includes: Vec<String>,
    pub excludes: Vec<String>,
    pub inclusive_end_dates: bool,
    pub top_axis: bool,
    pub display_mode: String,
    pub weekday: Option<String>,
    pub weekend: String,
    pub sections: Vec<String>,
    pub links: IndexMap<String, String>,
    pub tasks: Vec<GanttTask>,
    by_id: HashMap<String, usize>,
    current_section: String,
    task_count: usize,
    last_order: isize,
    last_task_id: Option<String>,
}

impl Default for GanttDb {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ScheduleContext {
    pub tasks: Vec<GanttTask>,
    date_format: String,
    include_set: HashSet<String>,
    exclude_set: HashSet<String>,
    excluded_days: [bool; 7],
    dated_tokens: bool,
    work: usize,
}

impl ScheduleContext {
    pub fn is_invalid_date(&mut self, date_ms: i64) -> Result<bool, PeleError> {
        let wd = self.excluded_days[weekday_of(date_ms)];
        if !self.dated_tokens {
            return Ok(wd);
        }
        let date_only = iso_date(date_ms);
        let mut formatted = Some(date_only.clone());
        let needs_custom_format = self.date_format.trim() != "YYYY-MM-DD";
        let template_len = self.date_format.trim().len();
        self.spend(DATED_STEP)?;
        if needs_custom_format {
            self.spend(FORMAT_STEP + template_len * 8)?;
            formatted = format_date(Some(date_ms), self.date_format.trim());
        }
        let listed = |set: &HashSet<String>| set.contains(&date_only) || formatted.as_deref().is_some_and(|f| set.contains(f));
        if listed(&self.include_set) {
            return Ok(false);
        }
        Ok(wd || listed(&self.exclude_set))
    }

    fn spend(&mut self, units: usize) -> Result<(), PeleError> {
        self.work = self.work.saturating_add(units);
        if self.work > WORK_LIMIT {
            return Err(PeleError::new("The gantt chart takes too much work to schedule.", ErrorCode::Limit).with_diagram_type(DiagramType::Gantt));
        }
        Ok(())
    }
}

impl GanttDb {
    pub fn new() -> Self {
        Self {
            title: None,
            acc_title: None,
            acc_descr: None,
            date_format: String::new(),
            axis_format: String::new(),
            tick_interval: None,
            today_marker: String::new(),
            includes: Vec::new(),
            excludes: Vec::new(),
            inclusive_end_dates: false,
            top_axis: false,
            display_mode: String::new(),
            weekday: None,
            weekend: "saturday".to_string(),
            sections: Vec::new(),
            links: IndexMap::new(),
            tasks: Vec::new(),
            by_id: HashMap::new(),
            current_section: String::new(),
            task_count: 0,
            last_order: 0,
            last_task_id: None,
        }
    }

    pub fn set_date_format(&mut self, txt: &str) {
        self.date_format = txt.to_string();
    }

    pub fn enable_inclusive_end_dates(&mut self) {
        self.inclusive_end_dates = true;
    }

    pub fn enable_top_axis(&mut self) {
        self.top_axis = true;
    }

    pub fn set_axis_format(&mut self, txt: &str) {
        self.axis_format = txt.to_string();
    }

    pub fn set_tick_interval(&mut self, txt: &str) {
        self.tick_interval = Some(txt.to_string());
    }

    pub fn set_today_marker(&mut self, txt: &str) {
        self.today_marker = txt.to_string();
    }

    pub fn set_includes(&mut self, txt: &str) {
        merge_tokens(&mut self.includes, txt);
    }

    pub fn set_excludes(&mut self, txt: &str) {
        merge_tokens(&mut self.excludes, txt);
    }

    pub fn set_weekday(&mut self, txt: &str) {
        self.weekday = Some(txt.to_string());
    }

    pub fn set_weekend(&mut self, start_day: &str) {
        self.weekend = start_day.to_string();
    }

    pub fn set_diagram_title(&mut self, txt: &str) {
        self.title = Some(txt.to_string());
    }

    pub fn set_acc_title(&mut self, txt: &str) {
        self.acc_title = Some(trim_leading_ws(txt));
    }

    pub fn set_acc_description(&mut self, txt: &str) {
        self.acc_descr = Some(collapse_newline_ws(txt));
    }

    pub fn add_section(&mut self, txt: &str) {
        self.current_section = txt.to_string();
        self.sections.push(txt.to_string());
    }

    pub fn add_task(&mut self, descr: &str, data_str: &str) -> Result<(), PeleError> {
        let stripped = data_str.strip_prefix(':').unwrap_or(data_str);
        let mut data: Vec<&str> = stripped.split(',').collect();
        let mut active = false;
        let mut done = false;
        let mut crit = false;
        let mut milestone = false;
        let mut vert = false;
        while let Some(&first) = data.first() {
            match first.trim() {
                "active" => {
                    active = true;
                    data.remove(0);
                }
                "done" => {
                    done = true;
                    data.remove(0);
                }
                "crit" => {
                    crit = true;
                    data.remove(0);
                }
                "milestone" => {
                    milestone = true;
                    data.remove(0);
                }
                "vert" => {
                    vert = true;
                    data.remove(0);
                }
                _ => break,
            }
        }
        if data.is_empty() {
            return Err(
                PeleError::new(format!(r#"Task "{}" needs a duration or an end date."#, descr.trim()), ErrorCode::Semantic)
                    .with_diagram_type(DiagramType::Gantt),
            );
        }
        if data.len() > 3 {
            return Err(PeleError::new(
                format!(
                    r#"Task "{}" has too many fields. A task takes an id, a start, and an end or duration."#,
                    descr.trim(),
                ),
                ErrorCode::Semantic,
            )
            .with_diagram_type(DiagramType::Gantt));
        }
        let fields: Vec<String> = data.into_iter().map(|s| s.trim().to_string()).collect();
        let id = if fields.len() == 3 {
            fields[0].clone()
        } else {
            self.task_count += 1;
            format!("task{}", self.task_count)
        };
        let raw_start = if fields.len() > 1 { Some(fields[fields.len() - 2].clone()) } else { None };
        let raw_end = fields[fields.len() - 1].clone();
        let order = if vert {
            -1
        } else {
            let o = self.last_order;
            self.last_order += 1;
            o
        };
        let idx = self.tasks.len();
        self.tasks.push(GanttTask {
            id: id.clone(),
            task: descr.to_string(),
            section: self.current_section.clone(),
            start_time: None,
            end_time: None,
            render_end_time: None,
            manual_end_time: false,
            processed: false,
            active,
            done,
            crit,
            milestone,
            vert,
            order,
            classes: Vec::new(),
            prev_task_id: self.last_task_id.clone(),
            raw: GanttRaw {
                data: data_str.to_string(),
                start: raw_start,
                end: raw_end,
            },
        });
        self.last_task_id = Some(id.clone());
        self.by_id.insert(id, idx);
        Ok(())
    }

    pub fn set_link(&mut self, ids: &str, link: &str) {
        let href = safe_url(link);
        for id in ids.split(',') {
            if self.by_id.contains_key(id) {
                self.links.insert(id.to_string(), href.clone());
            }
        }
        self.set_class(ids, "clickable");
    }

    pub fn set_click_event(&mut self, ids: &str, _function_name: &str, _function_args: Option<&str>) {
        self.set_class(ids, "clickable");
    }

    pub fn set_class(&mut self, ids: &str, class_name: &str) {
        for id in ids.split(',') {
            if let Some(&idx) = self.by_id.get(id) {
                self.tasks[idx].classes.push(class_name.to_string());
            }
        }
    }

    pub fn get_tasks(&self, now_ms: Option<i64>) -> Result<Vec<GanttTask>, PeleError> {
        Ok(self.schedule(now_ms)?.tasks)
    }

    /// Schedules all tasks against `now_ms` without mutating `self`.
    pub fn schedule(&self, now_ms: Option<i64>) -> Result<ScheduleContext, PeleError> {
        let now = clock(now_ms);
        let today = start_of_day(now);
        let include_set: HashSet<String> = self.includes.iter().cloned().collect();
        let exclude_set: HashSet<String> = self.excludes.iter().cloned().collect();
        let weekend_start: Option<i64> = match self.weekend.as_str() {
            "friday" => Some(5),
            "saturday" => Some(6),
            _ => None,
        };
        let weekends = exclude_set.contains("weekends");
        let mut excluded_days = [false; 7];
        for (day, name) in WEEKDAYS.iter().enumerate() {
            let iso = if day == 0 { 7 } else { day as i64 };
            excluded_days[day] = (weekends && weekend_start.is_some_and(|ws| iso == ws || iso == ws + 1)) || exclude_set.contains(&name.to_ascii_lowercase());
        }
        let mut dated_tokens = !self.includes.is_empty() || !is_numeric_format(self.date_format.trim());
        for tok in &self.excludes {
            if tok != "weekends" && !is_day_name(tok) {
                dated_tokens = true;
            }
        }

        let mut tasks = self.tasks.clone();
        for t in &mut tasks {
            t.start_time = None;
            t.end_time = None;
            t.render_end_time = None;
            t.processed = false;
            t.manual_end_time = false;
        }

        let mut sched = ScheduleContext {
            tasks,
            date_format: self.date_format.clone(),
            include_set,
            exclude_set,
            excluded_days,
            dated_tokens,
            work: 0,
        };

        let mut all_processed = self.compile_tasks(&mut sched, now, today)?;
        for _ in 0..10 {
            if all_processed {
                break;
            }
            all_processed = self.compile_tasks(&mut sched, now, today)?;
        }
        Ok(sched)
    }

    fn parse_date_with_budget(&self, sched: &mut ScheduleContext, str_val: &str, template: &str, now: i64) -> Result<Option<i64>, PeleError> {
        sched.spend((template.len() + 1).saturating_mul(str_val.len() + 1))?;
        Ok(parse_strict(str_val, template, now))
    }

    fn compile_tasks(&self, sched: &mut ScheduleContext, now: i64, today: i64) -> Result<bool, PeleError> {
        let mut all_processed = true;
        for idx in 0..sched.tasks.len() {
            self.compile_task(sched, idx, now, today)?;
            all_processed = all_processed && sched.tasks[idx].processed;
        }
        Ok(all_processed)
    }

    fn compile_task(&self, sched: &mut ScheduleContext, idx: usize, now: i64, today: i64) -> Result<(), PeleError> {
        let raw_start = sched.tasks[idx].raw.start.clone();
        let raw_end = sched.tasks[idx].raw.end.clone();
        let prev_id = sched.tasks[idx].prev_task_id.clone();

        if let Some(start_str) = raw_start {
            if let Some(st) = self.get_start_date(sched, &start_str, now, today)? {
                sched.tasks[idx].start_time = Some(st);
            }
        } else {
            let st = match prev_id.as_deref().and_then(|id| self.by_id.get(id).copied()) {
                Some(prev_idx) => sched.tasks[prev_idx].end_time,
                None => Some(today),
            };
            sched.tasks[idx].start_time = st;
        }

        let Some(start_time) = sched.tasks[idx].start_time else {
            return Ok(());
        };
        let end_time = self.get_end_date(sched, start_time, &raw_end, now, today)?;
        sched.tasks[idx].end_time = end_time;
        let Some(_) = end_time else {
            return Ok(());
        };
        sched.tasks[idx].processed = true;
        sched.tasks[idx].manual_end_time = self.parse_date_with_budget(sched, &raw_end, "YYYY-MM-DD", now)?.is_some();
        self.check_task_dates(sched, idx)?;
        Ok(())
    }

    fn references(&self, list: &str) -> Vec<usize> {
        let mut found = Vec::new();
        for id in list.split(' ') {
            if id.is_empty() {
                continue;
            }
            if let Some(&idx) = self.by_id.get(id) {
                found.push(idx);
            }
        }
        found
    }

    fn get_start_date(&self, sched: &mut ScheduleContext, raw: &str, now: i64, today: i64) -> Result<Option<i64>, PeleError> {
        let s = raw.trim();
        let template = self.date_format.trim();

        if (template == "x" || template == "X") && !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            let num = crate::diagram::journey::db::js_number(s);
            let ms = if num.is_finite() { clip_ms(num.trunc() as i128) } else { None };
            return match ms {
                Some(v) => Ok(Some(v)),
                None => Err(PeleError::new(format!("Invalid date:{s}"), ErrorCode::Semantic).with_diagram_type(DiagramType::Gantt)),
            };
        }

        if let Some(after_list) = extract_ref_list(s, "after") {
            let refs = self.references(after_list);
            let mut latest: Option<usize> = None;
            for &t_idx in &refs {
                let replace = match latest {
                    None => true,
                    Some(l_idx) => match (sched.tasks[t_idx].end_time, sched.tasks[l_idx].end_time) {
                        (Some(te), Some(le)) => te > le,
                        _ => false,
                    },
                };
                if replace {
                    latest = Some(t_idx);
                }
            }
            return Ok(match latest {
                Some(l_idx) => sched.tasks[l_idx].end_time,
                None => Some(today),
            });
        }

        if let Some(parsed) = self.parse_date_with_budget(sched, s, template, now)? {
            return Ok(Some(parsed));
        }

        if let Some(fallback) = parse_js_date_fallback(s) {
            return Ok(Some(fallback));
        }
        Err(PeleError::new(format!("Invalid date:{s}"), ErrorCode::Semantic).with_diagram_type(DiagramType::Gantt))
    }

    fn get_end_date(&self, sched: &mut ScheduleContext, start_time: i64, raw: &str, now: i64, today: i64) -> Result<Option<i64>, PeleError> {
        let s = raw.trim();

        if let Some(until_list) = extract_ref_list(s, "until") {
            let refs = self.references(until_list);
            let mut earliest: Option<usize> = None;
            for &t_idx in &refs {
                let replace = match earliest {
                    None => true,
                    Some(e_idx) => match (sched.tasks[t_idx].start_time, sched.tasks[e_idx].start_time) {
                        (Some(ts), Some(es)) => ts < es,
                        _ => false,
                    },
                };
                if replace {
                    earliest = Some(t_idx);
                }
            }
            return Ok(match earliest {
                Some(e_idx) => sched.tasks[e_idx].start_time,
                None => Some(today),
            });
        }

        let template = self.date_format.trim();
        if let Some(parsed) = self.parse_date_with_budget(sched, s, template, now)? {
            return Ok(if self.inclusive_end_dates { add_days(parsed, 1) } else { Some(parsed) });
        }

        let Some((value, unit)) = parse_duration(s) else {
            return Ok(Some(start_time));
        };
        Ok(Some(add(start_time, value, unit).unwrap_or(start_time)))
    }

    fn check_task_dates(&self, sched: &mut ScheduleContext, idx: usize) -> Result<(), PeleError> {
        if self.excludes.is_empty() || sched.tasks[idx].manual_end_time {
            return Ok(());
        }
        let Some(start_time) = sched.tasks[idx].start_time else { return Ok(()) };
        let Some(mut end_time) = sched.tasks[idx].end_time else { return Ok(()) };
        let Some(mut cursor) = add_days(start_time, 1) else { return Ok(()) };
        let max_end_time = add_days(end_time, 10_000);
        let mut invalid = false;
        let mut render_end_time: Option<i64> = None;
        while cursor <= end_time {
            sched.spend(DAY_STEP)?;
            if !invalid {
                render_end_time = Some(end_time);
            }
            invalid = sched.is_invalid_date(cursor)?;
            if invalid {
                let Some(next_end) = add_days(end_time, 1) else {
                    break;
                };
                end_time = next_end;
                if max_end_time.is_some_and(|max| end_time > max) {
                    return Err(PeleError::new(
                        "Failed to find a valid date that was not excluded by `excludes` after 10,000 iterations.",
                        ErrorCode::Semantic,
                    )
                    .with_diagram_type(DiagramType::Gantt));
                }
            }
            let Some(next_cursor) = add_days(cursor, 1) else {
                break;
            };
            cursor = next_cursor;
        }
        sched.tasks[idx].end_time = Some(end_time);
        sched.tasks[idx].render_end_time = render_end_time;
        Ok(())
    }
}
