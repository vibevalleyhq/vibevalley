use super::dates::{DAY_MS, HOUR_MS, MINUTE_MS, MONTHS, SECOND_MS, WEEK_MS, WEEKDAYS, add_days, clip_ms, make_date, split_date, start_of_day, weekday_of};

const MONTH_MS: i64 = 30 * DAY_MS;
const YEAR_MS: i64 = 365 * DAY_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickUnit {
    Millisecond,
    Second,
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Year,
}

#[derive(Clone, Copy)]
struct CalendarSpec {
    unit: TickUnit,
    step: i64,
    week_start: usize,
}

impl CalendarSpec {
    fn base_ms(self) -> f64 {
        match self.unit {
            TickUnit::Millisecond => 1.0,
            TickUnit::Second => SECOND_MS as f64,
            TickUnit::Minute => MINUTE_MS as f64,
            TickUnit::Hour => HOUR_MS as f64,
            TickUnit::Day => DAY_MS as f64,
            TickUnit::Week => WEEK_MS as f64,
            TickUnit::Month => MONTH_MS as f64,
            TickUnit::Year => YEAR_MS as f64,
        }
    }

    fn cycle(self) -> f64 {
        match self.unit {
            TickUnit::Millisecond | TickUnit::Week | TickUnit::Year => f64::INFINITY,
            TickUnit::Second | TickUnit::Minute => 60.0,
            TickUnit::Hour => 24.0,
            TickUnit::Day => 31.0,
            TickUnit::Month => 12.0,
        }
    }

    fn base_floor(self, d: Option<i64>) -> Option<i64> {
        let ms = d?;
        match self.unit {
            TickUnit::Millisecond => Some(ms),
            TickUnit::Second => Some(ms.div_euclid(SECOND_MS) * SECOND_MS),
            TickUnit::Minute => Some(ms.div_euclid(MINUTE_MS) * MINUTE_MS),
            TickUnit::Hour => Some(ms.div_euclid(HOUR_MS) * HOUR_MS),
            TickUnit::Day => Some(start_of_day(ms)),
            TickUnit::Week => {
                let wd = weekday_of(ms);
                let back = (wd + 7 - self.week_start) % 7;
                add_days(start_of_day(ms), -(back as i64))
            }
            TickUnit::Month => {
                let p = split_date(ms);
                make_date(p.year, p.month as i64, 1, 0, 0, 0, 0)
            }
            TickUnit::Year => {
                let p = split_date(ms);
                make_date(p.year, 1, 1, 0, 0, 0, 0)
            }
        }
    }

    fn base_offset(self, d: Option<i64>, n: i64) -> Option<i64> {
        let ms = d?;
        match self.unit {
            TickUnit::Millisecond => clip_ms(ms as i128 + n as i128),
            TickUnit::Second => clip_ms(ms as i128 + (n as i128) * (SECOND_MS as i128)),
            TickUnit::Minute => clip_ms(ms as i128 + (n as i128) * (MINUTE_MS as i128)),
            TickUnit::Hour => clip_ms(ms as i128 + (n as i128) * (HOUR_MS as i128)),
            TickUnit::Day => add_days(ms, n),
            TickUnit::Week => add_days(ms, n.checked_mul(7)?),
            TickUnit::Month => {
                let p = split_date(ms);
                make_date(
                    p.year,
                    p.month as i64 + n,
                    p.day as i64,
                    p.hour as i64,
                    p.minute as i64,
                    p.second as i64,
                    p.ms as i64,
                )
            }
            TickUnit::Year => {
                let p = split_date(ms);
                make_date(
                    p.year + n,
                    p.month as i64,
                    p.day as i64,
                    p.hour as i64,
                    p.minute as i64,
                    p.second as i64,
                    p.ms as i64,
                )
            }
        }
    }

    fn field(self, ms: i64) -> i64 {
        let p = split_date(ms);
        match self.unit {
            TickUnit::Second => p.second as i64,
            TickUnit::Minute => p.minute as i64,
            TickUnit::Hour => p.hour as i64,
            TickUnit::Day => p.day as i64 - 1,
            TickUnit::Month => p.month as i64 - 1,
            TickUnit::Millisecond | TickUnit::Week | TickUnit::Year => 0,
        }
    }

    fn floor(self, d: Option<i64>) -> Option<i64> {
        if self.step <= 1 {
            return self.base_floor(d);
        }
        match self.unit {
            TickUnit::Millisecond => {
                let ms = d?;
                let q = ms.div_euclid(self.step) * self.step;
                clip_ms(q as i128)
            }
            TickUnit::Year => {
                let ms = d?;
                let p = split_date(ms);
                let y = p.year.div_euclid(self.step) * self.step;
                make_date(y, 1, 1, 0, 0, 0, 0)
            }
            TickUnit::Week => {
                let epoch = self.base_floor(Some(0))?;
                let floored = self.base_floor(d)?;
                let weeks = (floored - epoch).div_euclid(WEEK_MS);
                let rem = weeks.rem_euclid(self.step);
                self.base_offset(Some(floored), -rem)
            }
            TickUnit::Second | TickUnit::Minute | TickUnit::Hour | TickUnit::Day | TickUnit::Month => {
                let mut cur = self.base_floor(d)?;
                while self.field(cur) % self.step != 0 {
                    cur = clip_ms(cur as i128 - 1)?;
                    cur = self.base_floor(Some(cur))?;
                }
                Some(cur)
            }
        }
    }

    fn offset(self, d: Option<i64>, n: i64) -> Option<i64> {
        if self.step <= 1 {
            return self.base_offset(d, n);
        }
        match self.unit {
            TickUnit::Millisecond => {
                let ms = d?;
                clip_ms(ms as i128 + (n as i128) * (self.step as i128))
            }
            TickUnit::Year => {
                let ms = d?;
                let p = split_date(ms);
                let dy = (n as i128) * (self.step as i128);
                if dy.abs() > 1_000_000 {
                    return None;
                }
                make_date(
                    p.year + dy as i64,
                    p.month as i64,
                    p.day as i64,
                    p.hour as i64,
                    p.minute as i64,
                    p.second as i64,
                    p.ms as i64,
                )
            }
            TickUnit::Week => {
                let delta = n.checked_mul(self.step)?;
                self.base_offset(d, delta)
            }
            TickUnit::Second | TickUnit::Minute | TickUnit::Hour | TickUnit::Day | TickUnit::Month => {
                let mut cur = d?;
                for _ in 0..n {
                    loop {
                        cur = self.base_offset(Some(cur), 1)?;
                        if self.field(cur) % self.step == 0 {
                            break;
                        }
                    }
                }
                Some(cur)
            }
        }
    }
}

fn range(cal: CalendarSpec, start: i64, stop: i64, limit: usize) -> Option<Vec<i64>> {
    let mut d = clip_ms(start as i128 - 1);
    d = cal.floor(d);
    d = cal.offset(d, 1);
    d = cal.floor(d);
    let mut out = Vec::new();
    let mut previous = i64::MIN;
    while let Some(cur) = d {
        if cur > stop || cur <= previous {
            break;
        }
        if out.len() >= limit {
            return None;
        }
        previous = cur;
        out.push(cur);
        d = cal.offset(Some(cur), 1);
        d = cal.floor(d);
    }
    Some(out)
}

fn tick_step(start: f64, stop: f64, count: usize) -> f64 {
    let step = (stop - start) / (count as f64).max(0.0);
    let power = step.log10().floor();
    let error = step / 10.0f64.powf(power);
    let factor = if error >= 50.0f64.sqrt() {
        10.0
    } else if error >= 10.0f64.sqrt() {
        5.0
    } else if error >= std::f64::consts::SQRT_2 {
        2.0
    } else {
        1.0
    };
    10.0f64.powf(power) * factor
}

const AUTO: [(TickUnit, i64, i64); 18] = [
    (TickUnit::Second, 1, SECOND_MS),
    (TickUnit::Second, 5, 5 * SECOND_MS),
    (TickUnit::Second, 15, 15 * SECOND_MS),
    (TickUnit::Second, 30, 30 * SECOND_MS),
    (TickUnit::Minute, 1, MINUTE_MS),
    (TickUnit::Minute, 5, 5 * MINUTE_MS),
    (TickUnit::Minute, 15, 15 * MINUTE_MS),
    (TickUnit::Minute, 30, 30 * MINUTE_MS),
    (TickUnit::Hour, 1, HOUR_MS),
    (TickUnit::Hour, 3, 3 * HOUR_MS),
    (TickUnit::Hour, 6, 6 * HOUR_MS),
    (TickUnit::Hour, 12, 12 * HOUR_MS),
    (TickUnit::Day, 1, DAY_MS),
    (TickUnit::Day, 2, 2 * DAY_MS),
    (TickUnit::Week, 1, WEEK_MS),
    (TickUnit::Month, 1, MONTH_MS),
    (TickUnit::Month, 3, 3 * MONTH_MS),
    (TickUnit::Year, 1, YEAR_MS),
];

pub fn auto_ticks(start: i64, stop: i64, count: usize) -> Vec<i64> {
    if count == 0 {
        return Vec::new();
    }
    let target = (stop as f64 - start as f64) / count as f64;
    let mut i = 0;
    while i < AUTO.len() && (AUTO[i].2 as f64) <= target {
        i += 1;
    }
    let cal = if i == AUTO.len() {
        let step = tick_step(start as f64 / YEAR_MS as f64, stop as f64 / YEAR_MS as f64, count).clamp(1.0, 1e9) as i64;
        CalendarSpec {
            unit: TickUnit::Year,
            step,
            week_start: 0,
        }
    } else if i == 0 {
        let step = tick_step(start as f64, stop as f64, count).clamp(1.0, 1e15) as i64;
        CalendarSpec {
            unit: TickUnit::Millisecond,
            step,
            week_start: 0,
        }
    } else {
        let prev_ms = AUTO[i - 1].2 as f64;
        let next_ms = AUTO[i].2 as f64;
        let (unit, step, _) = if target / prev_ms < next_ms / target { AUTO[i - 1] } else { AUTO[i] };
        CalendarSpec { unit, step, week_start: 0 }
    };
    range(cal, start, stop, 4 * count + 8).unwrap_or_default()
}

pub fn interval_ticks(interval: &str, weekday: &str, start: i64, stop: i64, limit: usize) -> Option<Vec<i64>> {
    let bytes = interval.as_bytes();
    if bytes.is_empty() || !(b'1'..=b'9').contains(&bytes[0]) {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let step: i64 = interval[..i].parse().ok()?;
    let unit = match &interval[i..] {
        "millisecond" => TickUnit::Millisecond,
        "second" => TickUnit::Second,
        "minute" => TickUnit::Minute,
        "hour" => TickUnit::Hour,
        "day" => TickUnit::Day,
        "week" => TickUnit::Week,
        "month" => TickUnit::Month,
        _ => return None,
    };
    let week_start = match weekday {
        "monday" => 1,
        "tuesday" => 2,
        "wednesday" => 3,
        "thursday" => 4,
        "friday" => 5,
        "saturday" => 6,
        _ => 0,
    };
    let cal = CalendarSpec { unit, step, week_start };
    let est = (stop as f64 - start as f64) / ((step as f64).min(cal.cycle()) * cal.base_ms());
    if est > limit as f64 {
        return None;
    }
    range(cal, start, stop, limit)
}

fn pad_fmt(value: i64, fill: &str, width: usize) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let digits = value.unsigned_abs().to_string();
    if digits.len() < width && !fill.is_empty() {
        format!("{sign}{}{digits}", fill.repeat(width - digits.len()))
    } else {
        format!("{sign}{digits}")
    }
}

fn week_of_year(ms: i64, week_start: usize) -> i64 {
    let week = CalendarSpec {
        unit: TickUnit::Week,
        step: 1,
        week_start,
    };
    let year = CalendarSpec {
        unit: TickUnit::Year,
        step: 1,
        week_start: 0,
    };
    let Some(year_start) = year.floor(Some(ms)) else { return 0 };
    let Some(before) = week.floor(clip_ms(year_start as i128 - 1)) else {
        return 0;
    };
    let Some(cur) = week.floor(Some(ms)) else { return 0 };
    (cur - before).div_euclid(WEEK_MS)
}

fn iso_thursday(ms: i64) -> i64 {
    let thursday = CalendarSpec {
        unit: TickUnit::Week,
        step: 1,
        week_start: 4,
    };
    let day = weekday_of(ms);
    if day >= 4 || day == 0 {
        thursday.floor(Some(ms)).unwrap_or(ms)
    } else {
        let prev = clip_ms(ms as i128 - 1);
        let f = thursday.floor(prev);
        let o = thursday.offset(f, 1);
        thursday.floor(o).unwrap_or(ms)
    }
}

/// Formats a date with a d3-time-format specifier such as `%Y-%m-%d`.
pub fn time_format(specifier: &str, ms: i64) -> String {
    let mut out = String::with_capacity(specifier.len() + 8);
    let bytes = specifier.as_bytes();
    let n = bytes.len();
    let mut from = 0;
    let mut i = 0;
    while i < n {
        if bytes[i] != b'%' {
            i += 1;
            continue;
        }
        out.push_str(&specifier[from..i]);
        i += 1;
        if i >= n {
            from = i;
            break;
        }
        let mut ch = specifier[i..].chars().next().unwrap();
        let fill = match ch {
            '-' => {
                i += 1;
                ch = specifier.get(i..).and_then(|s| s.chars().next()).unwrap_or('\0');
                ""
            }
            '_' => {
                i += 1;
                ch = specifier.get(i..).and_then(|s| s.chars().next()).unwrap_or('\0');
                " "
            }
            '0' => {
                i += 1;
                ch = specifier.get(i..).and_then(|s| s.chars().next()).unwrap_or('\0');
                "0"
            }
            'e' => " ",
            _ => "0",
        };
        if ch != '\0' {
            out.push_str(&directive(ch, ms, fill));
            i += ch.len_utf8();
        }
        from = i;
    }
    if from < n {
        out.push_str(&specifier[from..]);
    }
    out
}

fn directive(c: char, ms: i64, p: &str) -> String {
    let d = split_date(ms);
    match c {
        'a' => WEEKDAYS[d.weekday][..3].to_string(),
        'A' => WEEKDAYS[d.weekday].to_string(),
        'b' => MONTHS[(d.month - 1) as usize][..3].to_string(),
        'B' => MONTHS[(d.month - 1) as usize].to_string(),
        'c' => time_format("%x, %X", ms),
        'd' | 'e' => pad_fmt(d.day as i64, p, 2),
        'f' => format!("{}000", pad_fmt(d.ms as i64, p, 3)),
        'g' => pad_fmt(split_date(iso_thursday(ms)).year % 100, p, 2),
        'G' => pad_fmt(split_date(iso_thursday(ms)).year % 10_000, p, 4),
        'H' => pad_fmt(d.hour as i64, p, 2),
        'I' => pad_fmt(if d.hour.is_multiple_of(12) { 12 } else { (d.hour % 12) as i64 }, p, 2),
        'j' => {
            let year_start = make_date(d.year, 1, 1, 0, 0, 0, 0).unwrap_or(0);
            let day_start = start_of_day(ms);
            pad_fmt(1 + (day_start - year_start).div_euclid(DAY_MS), p, 3)
        }
        'L' => pad_fmt(d.ms as i64, p, 3),
        'm' => pad_fmt(d.month as i64, p, 2),
        'M' => pad_fmt(d.minute as i64, p, 2),
        'p' => (if d.hour >= 12 { "PM" } else { "AM" }).to_string(),
        'q' => (1 + (d.month - 1) / 3).to_string(),
        'Q' => ms.to_string(),
        's' => ms.div_euclid(1000).to_string(),
        'S' => pad_fmt(d.second as i64, p, 2),
        'u' => (if d.weekday == 0 { 7 } else { d.weekday }).to_string(),
        'U' => pad_fmt(week_of_year(ms, 0), p, 2),
        'V' => {
            let thursday = iso_thursday(ms);
            let th_parts = split_date(thursday);
            let year_start = make_date(th_parts.year, 1, 1, 0, 0, 0, 0).unwrap_or(0);
            let week4 = CalendarSpec {
                unit: TickUnit::Week,
                step: 1,
                week_start: 4,
            };
            let first = week4.floor(Some(year_start)).unwrap_or(year_start);
            let extra = i64::from(weekday_of(year_start) == 4);
            pad_fmt((thursday - first).div_euclid(WEEK_MS) + extra, p, 2)
        }
        'w' => d.weekday.to_string(),
        'W' => pad_fmt(week_of_year(ms, 1), p, 2),
        'x' => time_format("%-m/%-d/%Y", ms),
        'X' => time_format("%-I:%M:%S %p", ms),
        'y' => pad_fmt(d.year % 100, p, 2),
        'Y' => pad_fmt(d.year % 10_000, p, 4),
        'Z' => "+0000".to_string(),
        '%' => "%".to_string(),
        other => other.to_string(),
    }
}
