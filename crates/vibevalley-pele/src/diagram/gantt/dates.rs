use crate::util::chars::is_space_char;

pub const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

pub const WEEKDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

pub const SECOND_MS: i64 = 1_000;
pub const MINUTE_MS: i64 = 60 * SECOND_MS;
pub const HOUR_MS: i64 = 60 * MINUTE_MS;
pub const DAY_MS: i64 = 24 * HOUR_MS;
pub const WEEK_MS: i64 = 7 * DAY_MS;

/// ECMAScript `TimeClip` valid range (`±8.64e15` ms around Unix epoch).
pub const MAX_DATE_MS: i64 = 8_640_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationUnit {
    Ms,
    S,
    M,
    H,
    D,
    W,
    Month,
    Y,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateParts {
    pub year: i64,
    /// 1-based month (`1..=12`).
    pub month: u32,
    /// 1-based day of month (`1..=31`).
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub ms: u32,
    /// 0 = Sunday .. 6 = Saturday.
    pub weekday: usize,
}

#[inline]
pub fn clip_ms(ms: i128) -> Option<i64> {
    if (-(MAX_DATE_MS as i128)..=(MAX_DATE_MS as i128)).contains(&ms) {
        Some(ms as i64)
    } else {
        None
    }
}

/// Howard Hinnant's proleptic Gregorian days-from-civil (1-based month, 1-based day; handles arbitrary overflow).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i128 {
    let total_months = (year as i128) * 12 + (month as i128 - 1);
    let y_norm = total_months.div_euclid(12);
    let m_norm = total_months.rem_euclid(12) + 1;
    let y = if m_norm <= 2 { y_norm - 1 } else { y_norm };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m_norm + if m_norm > 2 { -3 } else { 9 }) + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (day as i128 - 1)
}

/// Howard Hinnant's proleptic Gregorian civil-from-days returning `(year, month 1..=12, day 1..=31)`.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days as i128 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y as i64, m as u32, d as u32)
}

/// Builds a clipped UTC timestamp from calendar components (1-based month & day, allowing overflow).
pub fn make_date(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> Option<i64> {
    let days = days_from_civil(year, month, day);
    let total = days * (DAY_MS as i128)
        + (hour as i128) * (HOUR_MS as i128)
        + (minute as i128) * (MINUTE_MS as i128)
        + (second as i128) * (SECOND_MS as i128)
        + (ms as i128);
    clip_ms(total)
}

/// Same as `make_date`, applying JavaScript's `new Date(y, ...)` mapping `0..=99 => 1900 + y`.
fn make_js_date(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> Option<i64> {
    let y = if (0..=99).contains(&year) { 1900 + year } else { year };
    make_date(y, month, day, hour, minute, second, ms)
}

pub fn split_date(ms: i64) -> DateParts {
    let days = ms.div_euclid(DAY_MS);
    let rem = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    let hour = (rem / HOUR_MS) as u32;
    let rem = rem % HOUR_MS;
    let minute = (rem / MINUTE_MS) as u32;
    let rem = rem % MINUTE_MS;
    let second = (rem / SECOND_MS) as u32;
    let milli = (rem % SECOND_MS) as u32;
    let weekday = (days + 4).rem_euclid(7) as usize;
    DateParts {
        year,
        month,
        day,
        hour,
        minute,
        second,
        ms: milli,
        weekday,
    }
}

pub fn weekday_of(ms: i64) -> usize {
    let days = (ms as i128).div_euclid(DAY_MS as i128);
    (days + 4).rem_euclid(7) as usize
}

pub fn iso_weekday(ms: i64) -> i64 {
    let d = weekday_of(ms) as i64;
    if d == 0 { 7 } else { d }
}

pub fn start_of_day(ms: i64) -> i64 {
    ((ms as i128).div_euclid(DAY_MS as i128) * (DAY_MS as i128)).clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

pub fn end_of_day(ms: i64) -> i64 {
    ((ms as i128).div_euclid(DAY_MS as i128) * (DAY_MS as i128) + (DAY_MS as i128) - 1).clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

pub fn days_in_month(year: i64, month: i64) -> u32 {
    (days_from_civil(year, month + 1, 1) - days_from_civil(year, month, 1)) as u32
}

pub fn add_days(ms: i64, days: i64) -> Option<i64> {
    clip_ms(ms as i128 + (days as i128) * (DAY_MS as i128))
}

fn set_calendar_month(ms: i64, year: i64, month: i64) -> Option<i64> {
    let p = split_date(ms);
    let total_months = (year as i128) * 12 + (month as i128 - 1);
    let target_y = total_months.div_euclid(12);
    let target_m = total_months.rem_euclid(12) + 1;
    if !(-300_000..=300_000).contains(&target_y) {
        return None;
    }
    let dim = days_in_month(target_y as i64, target_m as i64);
    let day = p.day.min(dim) as i64;
    make_date(
        target_y as i64,
        target_m as i64,
        day,
        p.hour as i64,
        p.minute as i64,
        p.second as i64,
        p.ms as i64,
    )
}

/// JS `Math.round(x)`: ties toward +∞.
fn js_round(x: f64) -> Option<i64> {
    if !x.is_finite() {
        return None;
    }
    let r = (x + 0.5).floor();
    if r.abs() > 1e15 { None } else { Some(r as i64) }
}

pub fn add(ms: i64, amount: f64, unit: DurationUnit) -> Option<i64> {
    if !amount.is_finite() {
        return None;
    }
    match unit {
        DurationUnit::Month => {
            if amount.abs() > 1e8 {
                return None;
            }
            let p = split_date(ms);
            set_calendar_month(ms, p.year, p.month as i64 + amount.trunc() as i64)
        }
        DurationUnit::Y => {
            if amount.abs() > 1e7 {
                return None;
            }
            let p = split_date(ms);
            set_calendar_month(ms, p.year + amount.trunc() as i64, p.month as i64)
        }
        DurationUnit::D => add_days(ms, js_round(amount)?),
        DurationUnit::W => add_days(ms, js_round(7.0 * amount)?),
        DurationUnit::H => {
            let delta = amount * (HOUR_MS as f64);
            if !delta.is_finite() || delta.abs() > 2.0 * (MAX_DATE_MS as f64) {
                return None;
            }
            clip_ms(ms as i128 + delta.trunc() as i128)
        }
        DurationUnit::M => {
            let delta = amount * (MINUTE_MS as f64);
            if !delta.is_finite() || delta.abs() > 2.0 * (MAX_DATE_MS as f64) {
                return None;
            }
            clip_ms(ms as i128 + delta.trunc() as i128)
        }
        DurationUnit::S => {
            let delta = amount * (SECOND_MS as f64);
            if !delta.is_finite() || delta.abs() > 2.0 * (MAX_DATE_MS as f64) {
                return None;
            }
            clip_ms(ms as i128 + delta.trunc() as i128)
        }
        DurationUnit::Ms => {
            if amount.abs() > 2.0 * (MAX_DATE_MS as f64) {
                return None;
            }
            clip_ms(ms as i128 + amount.trunc() as i128)
        }
    }
}

fn pad_zero(value: i64, length: usize) -> String {
    let s = value.to_string();
    if s.len() >= length {
        s
    } else {
        format!("{}{s}", "0".repeat(length - s.len()))
    }
}

fn ordinal(n: u32) -> String {
    let v = (n % 100) as usize;
    let suffix = match v.checked_sub(20).map(|x| x % 10) {
        Some(1) => "st",
        Some(2) => "nd",
        Some(3) => "rd",
        _ => match v {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        },
    };
    format!("{n}{suffix}")
}

fn week_thursday(ms: i64) -> Option<i64> {
    add_days(ms, 4 - iso_weekday(ms))
}

fn iso_week(ms: i64) -> i64 {
    let Some(thursday) = week_thursday(ms) else { return 1 };
    let th_parts = split_date(thursday);
    let Some(jan1) = make_date(th_parts.year, 1, 1, 0, 0, 0, 0) else { return 1 };
    let wd = iso_weekday(jan1);
    let Some(first) = add_days(jan1, 4 - wd + if wd > 4 { 7 } else { 0 }) else {
        return 1;
    };
    let weeks = (thursday - first) as f64 / (WEEK_MS as f64);
    let whole = if weeks < 0.0 { weeks.ceil() as i64 } else { weeks.floor() as i64 };
    whole + 1
}

pub fn iso_date(ms: i64) -> String {
    let p = split_date(ms);
    let y = if (1000..=9999).contains(&p.year) {
        p.year.to_string()
    } else {
        pad_zero(p.year, 4)
    };
    format!("{y}-{:02}-{:02}", p.month, p.day)
}

const DEFAULT_FORMAT: &str = "YYYY-MM-DDTHH:mm:ssZ";

/// Formats a date using dayjs 1.11 tokens (custom parse format + advanced format + ISO week).
/// Returns `None` for unsupported plugin tokens (`w`, `ww`, `wo`, `gggg`, `z`, `zzz`).
pub fn format_date(ms: Option<i64>, template: &str) -> Option<String> {
    let Some(ms) = ms else {
        return Some("Invalid Date".to_string());
    };
    let str_tpl = if template.is_empty() { DEFAULT_FORMAT } else { template };
    if str_tpl == "YYYY-MM-DD" {
        return Some(iso_date(ms));
    }
    let p = split_date(ms);

    // Pass 1: RE_ADVANCED = /\[([^\]]+)]|Q|wo|ww|w|WW|W|zzz|z|gggg|GGGG|Do|X|x|k{1,2}|S/g
    let mut adv = String::with_capacity(str_tpl.len() + 16);
    let bytes = str_tpl.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &str_tpl[i..];
        if bytes[i] == b'['
            && let Some(rel) = rest[1..].find(']')
            && rel > 0
        {
            adv.push_str(&rest[..rel + 2]);
            i += rel + 2;
            continue;
        }
        if rest.starts_with("gggg") || rest.starts_with("zzz") {
            return None;
        }
        if rest.starts_with("GGGG") {
            let y = week_thursday(ms).map_or(p.year, |t| split_date(t).year);
            adv.push_str(&y.to_string());
            i += 4;
        } else if rest.starts_with("wo") || rest.starts_with("ww") {
            return None;
        } else if rest.starts_with("WW") {
            adv.push_str(&pad_zero(iso_week(ms), 2));
            i += 2;
        } else if rest.starts_with("Do") {
            adv.push('[');
            adv.push_str(&ordinal(p.day));
            adv.push(']');
            i += 2;
        } else if rest.starts_with("kk") {
            let h = if p.hour == 0 { 24 } else { p.hour };
            adv.push_str(&pad_zero(h as i64, 2));
            i += 2;
        } else if bytes[i] == b'Q' {
            adv.push_str(&((p.month - 1) / 3 + 1).to_string());
            i += 1;
        } else if bytes[i] == b'W' {
            adv.push_str(&iso_week(ms).to_string());
            i += 1;
        } else if bytes[i] == b'k' {
            let h = if p.hour == 0 { 24 } else { p.hour };
            adv.push_str(&h.to_string());
            i += 1;
        } else if bytes[i] == b'X' {
            adv.push_str(&ms.div_euclid(1000).to_string());
            i += 1;
        } else if bytes[i] == b'x' {
            adv.push_str(&ms.to_string());
            i += 1;
        } else if bytes[i] == b'w' || bytes[i] == b'z' {
            return None;
        } else {
            let ch = rest.chars().next().unwrap();
            adv.push(ch);
            i += ch.len_utf8();
        }
    }

    // Pass 2: RE_FORMAT = /\[([^\]]+)]|YYYY|YY|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/g
    let mut out = String::with_capacity(adv.len() + 16);
    let ab = adv.as_bytes();
    let mut j = 0;
    while j < ab.len() {
        let rest = &adv[j..];
        if ab[j] == b'['
            && let Some(rel) = rest[1..].find(']')
            && rel > 0
        {
            out.push_str(&rest[1..1 + rel]);
            j += rel + 2;
            continue;
        }
        if rest.starts_with("YYYY") {
            out.push_str(&pad_zero(p.year, 4));
            j += 4;
        } else if rest.starts_with("YY") {
            let s = p.year.to_string();
            let start = s.len().saturating_sub(2);
            out.push_str(&s[start..]);
            j += 2;
        } else if rest.starts_with("MMMM") {
            out.push_str(MONTHS[(p.month - 1) as usize]);
            j += 4;
        } else if rest.starts_with("MMM") {
            out.push_str(&MONTHS[(p.month - 1) as usize][..3]);
            j += 3;
        } else if rest.starts_with("MM") {
            out.push_str(&pad_zero(p.month as i64, 2));
            j += 2;
        } else if ab[j] == b'M' {
            out.push_str(&p.month.to_string());
            j += 1;
        } else if rest.starts_with("DD") {
            out.push_str(&pad_zero(p.day as i64, 2));
            j += 2;
        } else if ab[j] == b'D' {
            out.push_str(&p.day.to_string());
            j += 1;
        } else if rest.starts_with("dddd") {
            out.push_str(WEEKDAYS[p.weekday]);
            j += 4;
        } else if rest.starts_with("ddd") {
            out.push_str(&WEEKDAYS[p.weekday][..3]);
            j += 3;
        } else if rest.starts_with("dd") {
            out.push_str(&WEEKDAYS[p.weekday][..2]);
            j += 2;
        } else if ab[j] == b'd' {
            out.push_str(&p.weekday.to_string());
            j += 1;
        } else if rest.starts_with("HH") {
            out.push_str(&pad_zero(p.hour as i64, 2));
            j += 2;
        } else if ab[j] == b'H' {
            out.push_str(&p.hour.to_string());
            j += 1;
        } else if rest.starts_with("hh") {
            let h12 = if p.hour.is_multiple_of(12) { 12 } else { p.hour % 12 };
            out.push_str(&pad_zero(h12 as i64, 2));
            j += 2;
        } else if ab[j] == b'h' {
            let h12 = if p.hour.is_multiple_of(12) { 12 } else { p.hour % 12 };
            out.push_str(&h12.to_string());
            j += 1;
        } else if ab[j] == b'a' {
            out.push_str(if p.hour < 12 { "am" } else { "pm" });
            j += 1;
        } else if ab[j] == b'A' {
            out.push_str(if p.hour < 12 { "AM" } else { "PM" });
            j += 1;
        } else if rest.starts_with("mm") {
            out.push_str(&pad_zero(p.minute as i64, 2));
            j += 2;
        } else if ab[j] == b'm' {
            out.push_str(&p.minute.to_string());
            j += 1;
        } else if rest.starts_with("ss") {
            out.push_str(&pad_zero(p.second as i64, 2));
            j += 2;
        } else if ab[j] == b's' {
            out.push_str(&p.second.to_string());
            j += 1;
        } else if rest.starts_with("SSS") {
            out.push_str(&pad_zero(p.ms as i64, 3));
            j += 3;
        } else if rest.starts_with("ZZ") {
            out.push_str("+0000");
            j += 2;
        } else if ab[j] == b'Z' {
            out.push_str("+00:00");
            j += 1;
        } else {
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            j += ch.len_utf8();
        }
    }
    Some(out)
}

#[derive(Default)]
struct Fields {
    year: Option<i64>,
    month: Option<i64>,
    day: Option<i64>,
    day_given: bool,
    hours: Option<i64>,
    minutes: Option<i64>,
    seconds: Option<i64>,
    milliseconds: Option<i64>,
    week: Option<i64>,
    offset: Option<i64>,
    afternoon: Option<bool>,
}

#[derive(Clone, Copy)]
enum ReaderKind {
    AmpUpper,
    AmpLower,
    Quarter,
    Ms1,
    Ms2,
    Ms3,
    Sec,
    Min,
    Hour,
    Day12,
    Day2,
    DayOrd,
    Week12,
    Week2,
    Month12,
    Month2,
    MonthShort,
    MonthFull,
    YearSigned,
    Year2,
    Year4,
    Offset,
}

enum Step {
    Literal(usize),
    Read(ReaderKind),
}

fn compile_template(template: &str) -> Option<Vec<Step>> {
    // Reject localized tokens (`L` or `l`) outside `[...]`.
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'['
            && let Some(rel) = template[i + 1..].find(']')
            && rel > 0
        {
            i += rel + 2;
            continue;
        }
        if matches!(bytes[i], b'L' | b'l') {
            return None;
        }
        i += 1;
    }

    // Match RE_TOKENS = /(\[[^[]*\])|([-_:/.,()\s]+)|(A|a|Q|YYYY|YY?|ww?|MM?M?M?|Do|DD?|hh?|HH?|mm?|ss?|S{1,3}|z|ZZ?)/g
    let mut steps = Vec::new();
    let mut p = 0;
    while p < bytes.len() {
        let rest = &template[p..];
        if bytes[p] == b'['
            && let Some(close) = rest[1..].find(']')
            && !rest[1..1 + close].contains('[')
        {
            let inner_len = rest[1..1 + close].chars().count();
            steps.push(Step::Literal(inner_len));
            p += close + 2;
            continue;
        }
        // Separators: [-_:/.,()\s]+
        let mut sep_end = p;
        let mut sep_chars = 0;
        while sep_end < template.len() {
            let ch = template[sep_end..].chars().next().unwrap();
            if matches!(ch, '-' | '_' | ':' | '/' | '.' | ',' | '(' | ')') || is_space_char(ch) {
                sep_end += ch.len_utf8();
                sep_chars += 1;
            } else {
                break;
            }
        }
        if sep_chars > 0 {
            steps.push(Step::Literal(sep_chars));
            p = sep_end;
            continue;
        }
        let (tok_len, step) = if rest.starts_with("YYYY") {
            (4, Step::Read(ReaderKind::Year4))
        } else if rest.starts_with("YY") {
            (2, Step::Read(ReaderKind::Year2))
        } else if bytes[p] == b'Y' {
            (1, Step::Read(ReaderKind::YearSigned))
        } else if rest.starts_with("MMMM") {
            (4, Step::Read(ReaderKind::MonthFull))
        } else if rest.starts_with("MMM") {
            (3, Step::Read(ReaderKind::MonthShort))
        } else if rest.starts_with("MM") {
            (2, Step::Read(ReaderKind::Month2))
        } else if bytes[p] == b'M' {
            (1, Step::Read(ReaderKind::Month12))
        } else if rest.starts_with("Do") {
            (2, Step::Read(ReaderKind::DayOrd))
        } else if rest.starts_with("DD") {
            (2, Step::Read(ReaderKind::Day2))
        } else if bytes[p] == b'D' {
            (1, Step::Read(ReaderKind::Day12))
        } else if rest.starts_with("HH") || rest.starts_with("hh") {
            (2, Step::Read(ReaderKind::Hour))
        } else if bytes[p] == b'H' || bytes[p] == b'h' {
            (1, Step::Read(ReaderKind::Hour))
        } else if rest.starts_with("mm") {
            (2, Step::Read(ReaderKind::Min))
        } else if bytes[p] == b'm' {
            (1, Step::Read(ReaderKind::Min))
        } else if rest.starts_with("ss") {
            (2, Step::Read(ReaderKind::Sec))
        } else if bytes[p] == b's' {
            (1, Step::Read(ReaderKind::Sec))
        } else if rest.starts_with("SSS") {
            (3, Step::Read(ReaderKind::Ms3))
        } else if rest.starts_with("SS") {
            (2, Step::Read(ReaderKind::Ms2))
        } else if bytes[p] == b'S' {
            (1, Step::Read(ReaderKind::Ms1))
        } else if rest.starts_with("ww") {
            (2, Step::Read(ReaderKind::Week2))
        } else if bytes[p] == b'w' {
            (1, Step::Read(ReaderKind::Week12))
        } else if rest.starts_with("ZZ") {
            (2, Step::Read(ReaderKind::Offset))
        } else if bytes[p] == b'Z' {
            (1, Step::Read(ReaderKind::Offset))
        } else if bytes[p] == b'A' {
            (1, Step::Read(ReaderKind::AmpUpper))
        } else if bytes[p] == b'a' {
            (1, Step::Read(ReaderKind::AmpLower))
        } else if bytes[p] == b'Q' {
            (1, Step::Read(ReaderKind::Quarter))
        } else if bytes[p] == b'z' {
            (1, Step::Literal(1))
        } else {
            let ch = rest.chars().next().unwrap();
            p += ch.len_utf8();
            continue;
        };
        steps.push(step);
        p += tok_len;
    }
    if steps.is_empty() { None } else { Some(steps) }
}

fn find_digits(s: &str, min: usize, max: usize) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() && i - start < max {
                i += 1;
            }
            if i - start >= min {
                return Some(&s[start..i]);
            }
        } else {
            i += 1;
        }
    }
    None
}

fn find_signed_digits(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        if matches!(bytes[i], b'+' | b'-') && bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if bytes[i].is_ascii_digit() {
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            return Some(&s[start..i]);
        }
        i += 1;
    }
    None
}

fn is_word_body_char(ch: char) -> bool {
    !matches!(ch, '-' | '_' | ':' | '/' | ',' | '(' | ')') && !is_space_char(ch) && !ch.is_ascii_digit()
}

/// Matches `/\d*[^-_:/,()\s\d]+/`.
fn find_word(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < s.len() {
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let body_start = i;
        while i < s.len() {
            let ch = s[i..].chars().next().unwrap();
            if is_word_body_char(ch) {
                i += ch.len_utf8();
            } else {
                break;
            }
        }
        if i > body_start {
            return Some(&s[start..i]);
        }
        if i == start {
            let ch = s[i..].chars().next().unwrap();
            i += ch.len_utf8();
        }
    }
    None
}

/// Matches `/[+-]\d\d:?(\d\d)?|Z/`.
fn find_offset(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'Z' {
            return Some(&s[i..i + 1]);
        }
        if matches!(bytes[i], b'+' | b'-') && i + 2 < bytes.len() && bytes[i + 1].is_ascii_digit() && bytes[i + 2].is_ascii_digit() {
            let mut end = i + 3;
            if bytes.get(end) == Some(&b':') {
                end += 1;
            }
            if end + 1 < bytes.len() && bytes[end].is_ascii_digit() && bytes[end + 1].is_ascii_digit() {
                end += 2;
            }
            return Some(&s[i..end]);
        }
    }
    None
}

fn apply_reader(kind: ReaderKind, slice: &str, f: &mut Fields) -> Option<String> {
    let matched = match kind {
        ReaderKind::AmpUpper => {
            let m = find_word(slice)?;
            f.afternoon = Some(m == "PM");
            m
        }
        ReaderKind::AmpLower => {
            let m = find_word(slice)?;
            f.afternoon = Some(m == "pm");
            m
        }
        ReaderKind::Quarter => {
            let m = find_digits(slice, 1, 1)?;
            f.month = Some((m.parse::<i64>().ok()? - 1) * 3 + 1);
            m
        }
        ReaderKind::Ms1 => {
            let m = find_digits(slice, 1, 1)?;
            f.milliseconds = Some(m.parse::<i64>().ok()? * 100);
            m
        }
        ReaderKind::Ms2 => {
            let m = find_digits(slice, 2, 2)?;
            f.milliseconds = Some(m.parse::<i64>().ok()? * 10);
            m
        }
        ReaderKind::Ms3 => {
            let m = find_digits(slice, 3, 3)?;
            f.milliseconds = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Sec => {
            let m = find_digits(slice, 1, 2)?;
            f.seconds = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Min => {
            let m = find_digits(slice, 1, 2)?;
            f.minutes = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Hour => {
            let m = find_digits(slice, 1, 2)?;
            f.hours = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Day12 => {
            let m = find_digits(slice, 1, 2)?;
            f.day = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Day2 => {
            let m = find_digits(slice, 2, 2)?;
            f.day = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::DayOrd => {
            let m = find_word(slice)?;
            let digits = find_digits(m, 1, m.len())?;
            let mut d = digits.parse::<i64>().ok()?;
            for cand in 1..=31u32 {
                if ordinal(cand) == m {
                    d = cand as i64;
                    break;
                }
            }
            f.day = Some(d);
            f.day_given = true;
            m
        }
        ReaderKind::Week12 => {
            let m = find_digits(slice, 1, 2)?;
            f.week = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Week2 => {
            let m = find_digits(slice, 2, 2)?;
            f.week = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Month12 => {
            let m = find_digits(slice, 1, 2)?;
            f.month = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Month2 => {
            let m = find_digits(slice, 2, 2)?;
            f.month = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::MonthShort => {
            let m = find_word(slice)?;
            let idx = MONTHS.iter().position(|name| &name[..3] == m)? + 1;
            f.month = Some(idx as i64);
            m
        }
        ReaderKind::MonthFull => {
            let m = find_word(slice)?;
            let idx = MONTHS.iter().position(|&name| name == m)? + 1;
            f.month = Some(idx as i64);
            m
        }
        ReaderKind::YearSigned => {
            let m = find_signed_digits(slice)?;
            f.year = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Year2 => {
            let m = find_digits(slice, 2, 2)?;
            let n = m.parse::<i64>().ok()?;
            f.year = Some(n + if n > 68 { 1900 } else { 2000 });
            m
        }
        ReaderKind::Year4 => {
            let m = find_digits(slice, 4, 4)?;
            f.year = Some(m.parse::<i64>().ok()?);
            m
        }
        ReaderKind::Offset => {
            let m = find_offset(slice)?;
            if m == "Z" {
                f.offset = Some(0);
            } else {
                let sign = &m[..1];
                let digits_only: String = m[1..].chars().filter(char::is_ascii_digit).collect();
                let hh: i64 = digits_only.get(0..2)?.parse().ok()?;
                let mm: i64 = digits_only.get(2..4).and_then(|s| s.parse().ok()).unwrap_or(0);
                let total = hh * 60 + mm;
                f.offset = Some(if total == 0 {
                    0
                } else if sign == "+" {
                    -total
                } else {
                    total
                });
            }
            m
        }
    };
    Some(matched.to_string())
}

fn char_slice_from(s: &str, char_start: usize) -> &str {
    match s.char_indices().nth(char_start) {
        Some((byte_idx, _)) => &s[byte_idx..],
        None => "",
    }
}

fn loose_parse(input: &str, template: &str, now_ms: i64) -> Option<i64> {
    if template == "x" || template == "X" {
        let trimmed = input.trim_matches(is_space_char);
        if trimmed.is_empty() {
            return Some(0);
        }
        let n: f64 = crate::diagram::journey::db::js_number(trimmed);
        if !n.is_finite() {
            return None;
        }
        let mult = if template == "X" { 1000.0 } else { 1.0 };
        let ms = n * mult;
        if ms.abs() > MAX_DATE_MS as f64 {
            return None;
        }
        return clip_ms(ms.trunc() as i128);
    }

    let steps = compile_template(template)?;
    let mut f = Fields::default();
    let mut rest = input.to_string();
    let mut start_chars = 0usize;
    for step in steps {
        match step {
            Step::Literal(n) => start_chars += n,
            Step::Read(kind) => {
                let slice = char_slice_from(&rest, start_chars);
                let matched = apply_reader(kind, slice, &mut f)?;
                if let Some(at) = rest.find(&matched) {
                    rest.replace_range(at..at + matched.len(), "");
                }
            }
        }
    }

    if let (Some(afternoon), Some(hours)) = (f.afternoon, f.hours) {
        if afternoon {
            if hours < 12 {
                f.hours = Some(hours + 12);
            }
        } else if hours == 12 {
            f.hours = Some(0);
        }
    }

    let now = split_date(now_ms);
    let has_year = f.year.is_some_and(|y| y != 0);
    let has_month = f.month.is_some_and(|m| m != 0);
    let has_day = f.day_given || f.day.is_some_and(|d| d != 0);

    let day = if has_day {
        f.day.unwrap_or(0)
    } else if !has_year && !has_month {
        now.day as i64
    } else {
        1
    };
    let year = if has_year { f.year.unwrap() } else { now.year };
    let month = if has_year && !has_month {
        1
    } else if f.month.is_some_and(|m| m > 0) {
        f.month.unwrap()
    } else {
        now.month as i64
    };
    let hours = f.hours.unwrap_or(0);
    let minutes = f.minutes.unwrap_or(0);
    let seconds = f.seconds.unwrap_or(0);
    let ms = f.milliseconds.unwrap_or(0);

    if let Some(offset) = f.offset {
        return make_js_date(year, month, day, hours, minutes, seconds, ms + offset * 60_000);
    }
    if f.week.is_some_and(|w| w != 0) {
        return None;
    }
    make_js_date(year, month, day, hours, minutes, seconds, ms)
}

/// Parses strictly like `dayjs(input, template, true)`.
pub fn parse_strict(input: &str, template: &str, now_ms: i64) -> Option<i64> {
    let date = loose_parse(input, template, now_ms)?;
    if format_date(Some(date), template).as_deref() == Some(input) {
        Some(date)
    } else {
        None
    }
}

/// Pure-Rust fallback matching JavaScript `new Date(str)` for ISO 8601, slash, and English month dates.
pub fn parse_js_date_fallback(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // ISO 8601: YYYY-MM-DD([T ]HH:mm(:ss(.sss)?)?(Z|[+-]HH:mm)?)? or YYYY-MM or YYYY (4 digits)
    if let Some(ms) = parse_iso_like(s) {
        let p = split_date(ms);
        if (-10_000..=10_000).contains(&p.year) {
            return Some(ms);
        }
        return None;
    }
    // Slash dates: YYYY/MM/DD or MM/DD/YYYY
    if s.contains('/')
        && let Some(ms) = parse_slash_date(s)
    {
        let p = split_date(ms);
        if (-10_000..=10_000).contains(&p.year) {
            return Some(ms);
        }
        return None;
    }
    // English month formats: "Jan 5, 2024", "January 5 2024", "5 Jan 2024", RFC2822
    if let Some(ms) = parse_english_date(s) {
        let p = split_date(ms);
        if (-10_000..=10_000).contains(&p.year) {
            return Some(ms);
        }
    }
    None
}

fn parse_iso_like(s: &str) -> Option<i64> {
    let (date_part, time_part) = match s.find(['T', 't', ' ']) {
        Some(idx) => (&s[..idx], Some(s[idx + 1..].trim())),
        None => (s, None),
    };
    let parts: Vec<&str> = date_part.split('-').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    // Reject bare numbers that aren't 4-digit years (e.g. "202304").
    if parts.len() == 1 {
        if parts[0].len() != 4 || !parts[0].bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let y: i64 = parts[0].parse().ok()?;
        return make_date(y, 1, 1, 0, 0, 0, 0);
    }
    if parts[0].len() < 4 || !parts[0].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let y: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    if !(1..=12).contains(&m) {
        return None;
    }
    let d: i64 = if parts.len() == 3 {
        let dv: i64 = parts[2].parse().ok()?;
        let dim = days_in_month(y, m) as i64;
        if !(1..=dim).contains(&dv) {
            return None;
        }
        dv
    } else {
        1
    };

    let (hour, min, sec, ms, tz_offset_min) = match time_part {
        None => (0, 0, 0, 0, 0),
        Some(tp) => parse_time_and_tz(tp)?,
    };
    make_date(y, m, d, hour, min, sec, ms + tz_offset_min * 60_000)
}

fn parse_time_and_tz(raw: &str) -> Option<(i64, i64, i64, i64, i64)> {
    let (time_str, tz_min) = if let Some(stripped) = raw.strip_suffix('Z').or_else(|| raw.strip_suffix('z')) {
        (stripped, 0i64)
    } else if let Some(pos) = raw.rfind(['+', '-'])
        && pos > 0
    {
        let tz = &raw[pos..];
        let sign = if tz.starts_with('+') { -1i64 } else { 1i64 };
        let digits: String = tz[1..].chars().filter(char::is_ascii_digit).collect();
        if digits.len() != 4 {
            return None;
        }
        let hh: i64 = digits[0..2].parse().ok()?;
        let mm: i64 = digits[2..4].parse().ok()?;
        (&raw[..pos], sign * (hh * 60 + mm))
    } else {
        (raw, 0i64)
    };
    let tparts: Vec<&str> = time_str.split(':').collect();
    if tparts.len() < 2 || tparts.len() > 3 {
        return None;
    }
    let hour: i64 = tparts[0].parse().ok()?;
    let min: i64 = tparts[1].parse().ok()?;
    let (sec, ms) = if let Some(s) = tparts.get(2) {
        match s.split_once('.') {
            Some((sec_s, frac_s)) => {
                let sec: i64 = sec_s.parse().ok()?;
                let padded = format!("{frac_s}000");
                let ms: i64 = padded[..3].parse().ok()?;
                (sec, ms)
            }
            None => (s.parse().ok()?, 0),
        }
    } else {
        (0, 0)
    };
    if !(0..=24).contains(&hour) || !(0..=59).contains(&min) || !(0..=59).contains(&sec) {
        return None;
    }
    Some((hour, min, sec, ms, tz_min))
}

fn parse_slash_date(s: &str) -> Option<i64> {
    let (date_part, time_part) = match s.find(' ') {
        Some(idx) => (&s[..idx], Some(s[idx + 1..].trim())),
        None => (s, None),
    };
    let parts: Vec<&str> = date_part.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    let a: i64 = parts[0].parse().ok()?;
    let b: i64 = parts[1].parse().ok()?;
    let c: i64 = parts[2].parse().ok()?;
    let (y, m, d) = if parts[0].len() == 4 { (a, b, c) } else { (c, a, b) };
    if !(1..=12).contains(&m) || !(1..=days_in_month(y, m) as i64).contains(&d) {
        return None;
    }
    let (hour, min, sec, ms, tz) = match time_part {
        None => (0, 0, 0, 0, 0),
        Some(tp) => parse_time_and_tz(tp)?,
    };
    make_date(y, m, d, hour, min, sec, ms + tz * 60_000)
}

fn parse_month_word(w: &str) -> Option<i64> {
    let lower = w.to_ascii_lowercase();
    for (i, &m) in MONTHS.iter().enumerate() {
        let ml = m.to_ascii_lowercase();
        if lower == ml || (lower.len() == 3 && ml.starts_with(&lower)) {
            return Some(i as i64 + 1);
        }
    }
    None
}

fn parse_english_date(s: &str) -> Option<i64> {
    let clean = s.replace(',', " ");
    let tokens: Vec<&str> = clean.split_whitespace().collect();
    if tokens.len() < 3 {
        return None;
    }
    let mut start = 0;
    // Skip optional weekday prefix like "Mon" or "Monday".
    let first_low = tokens[0].to_ascii_lowercase();
    if WEEKDAYS.iter().any(|w| {
        let wl = w.to_ascii_lowercase();
        first_low == wl || (first_low.len() == 3 && wl.starts_with(&first_low))
    }) {
        start = 1;
    }
    if tokens.len() - start < 3 {
        return None;
    }
    let (m, d, y, next) = if let Some(month) = parse_month_word(tokens[start]) {
        let day: i64 = tokens[start + 1].parse().ok()?;
        let year: i64 = tokens[start + 2].parse().ok()?;
        (month, day, year, start + 3)
    } else {
        let month = parse_month_word(tokens[start + 1])?;
        let day: i64 = tokens[start].parse().ok()?;
        let year: i64 = tokens[start + 2].parse().ok()?;
        (month, day, year, start + 3)
    };
    if !(1..=days_in_month(y, m) as i64).contains(&d) {
        return None;
    }
    let (hour, min, sec, ms, tz) = if next < tokens.len() && tokens[next].contains(':') {
        parse_time_and_tz(tokens[next])?
    } else {
        (0, 0, 0, 0, 0)
    };
    make_date(y, m, d, hour, min, sec, ms + tz * 60_000)
}
