use std::collections::BTreeSet;

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use thiserror::Error;

const DAY_MS: i64 = 86_400_000;
const SEARCH_DAYS: i64 = 366 * 9;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CronError {
    #[error("cron expression must have 5 whitespace-separated fields")]
    WrongFieldCount,
    #[error("invalid cron field `{field}`: {reason}")]
    InvalidField { field: &'static str, reason: String },
    #[error("invalid timezone `{0}`")]
    InvalidZone(String),
}

/// A fixed UTC offset in milliseconds or an IANA timezone name.
#[derive(Debug, Clone)]
pub enum Zone {
    Offset(i64),
    Named(TimeZone),
}

impl Zone {
    pub const UTC: Self = Self::Offset(0);

    /// Parses an IANA zone (`Asia/Shanghai`, `UTC`) or fixed offset (`+08:00`, `-0500`, `GMT+08`).
    pub fn parse(raw: &str) -> Result<Self, CronError> {
        let s = raw.trim();
        if s.is_empty() || s == "Local" {
            return Err(CronError::InvalidZone(raw.to_owned()));
        }
        if let Some(offset_ms) = parse_fixed_offset(s) {
            return Ok(Self::Offset(offset_ms));
        }
        if s.starts_with('+') || s.starts_with('-') {
            return Err(CronError::InvalidZone(raw.to_owned()));
        }
        TimeZone::get(s).map(Self::Named).map_err(|_| CronError::InvalidZone(raw.to_owned()))
    }

    pub fn system() -> Self {
        Self::Named(TimeZone::system())
    }

    fn offset_ms_at(&self, at_ms: i64) -> i64 {
        match self {
            Self::Offset(ms) => *ms,
            Self::Named(tz) => {
                let Ok(ts) = Timestamp::from_millisecond(at_ms) else {
                    return 0;
                };
                i64::from(tz.to_offset(ts).seconds()) * 1000
            }
        }
    }

    fn wall_of(&self, at_ms: i64) -> jiff::civil::DateTime {
        let ts = Timestamp::from_millisecond(at_ms + self.offset_ms_at(at_ms)).unwrap_or(Timestamp::UNIX_EPOCH);
        ts.to_zoned_datetime(TimeZone::UTC).datetime()
    }

    fn instant_of(&self, wall_ms: i64) -> i64 {
        if let Self::Offset(ms) = self {
            return wall_ms - ms;
        }
        let before = self.offset_ms_at(wall_ms - DAY_MS);
        let after = self.offset_ms_at(wall_ms + DAY_MS);
        [wall_ms - before, wall_ms - after]
            .into_iter()
            .filter(|at| at + self.offset_ms_at(*at) == wall_ms)
            .min()
            .unwrap_or(wall_ms - before)
    }
}

fn parse_fixed_offset(s: &str) -> Option<i64> {
    let body = s.strip_prefix("GMT").unwrap_or(s);
    let (sign, rest) = if let Some(r) = body.strip_prefix('+') {
        (1i64, r)
    } else {
        let r = body.strip_prefix('-')?;
        (-1i64, r)
    };
    let (hours_str, mins_str) = match rest.split_once(':') {
        Some((h, m)) if h.len() == 2 && m.len() == 2 => (h, m),
        None if rest.len() == 2 => (rest, "00"),
        None if rest.len() == 4 => (&rest[..2], &rest[2..]),
        _ => return None,
    };
    let hours: i64 = hours_str.parse().ok()?;
    let mins: i64 = mins_str.parse().ok()?;
    if hours > 23 || mins > 59 {
        return None;
    }
    Some(sign * (hours * 60 + mins) * 60_000)
}

fn utc_ms(year: i16, month: i8, day: i8, hour: i8, minute: i8) -> i64 {
    Date::new(year, month, day)
        .and_then(|d| d.at(hour, minute, 0, 0).to_zoned_datetime(TimeZone::UTC))
        .map(|z| z.timestamp().as_millisecond())
        .unwrap_or(i64::MIN)
}

/// Pure 5-field POSIX cron expression (`minute hour day-of-month month day-of-week`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronExpr {
    minutes: BTreeSet<i64>,
    hours: BTreeSet<i64>,
    days: BTreeSet<i64>,
    months: BTreeSet<i64>,
    weekdays: BTreeSet<i64>,
}

fn parse_field(raw: &str, name: &'static str, min: i64, max: i64, map_seven_to_zero: bool) -> Result<BTreeSet<i64>, CronError> {
    let mut set = BTreeSet::new();
    for part in raw.split(',') {
        let (range_part, step) = match part.split_once('/') {
            Some((r, s)) => {
                let step: i64 = s.parse().map_err(|_| CronError::InvalidField {
                    field: name,
                    reason: format!("bad step `{s}`"),
                })?;
                if step <= 0 {
                    return Err(CronError::InvalidField {
                        field: name,
                        reason: "step must be > 0".to_owned(),
                    });
                }
                (r, step)
            }
            None => (part, 1),
        };

        let (start, end) = if range_part == "*" {
            (min, max)
        } else if let Some((lo_s, hi_s)) = range_part.split_once('-') {
            let lo: i64 = lo_s.parse().map_err(|_| CronError::InvalidField {
                field: name,
                reason: format!("bad range start `{lo_s}`"),
            })?;
            let hi: i64 = hi_s.parse().map_err(|_| CronError::InvalidField {
                field: name,
                reason: format!("bad range end `{hi_s}`"),
            })?;
            if lo < min || hi > max || lo > hi {
                return Err(CronError::InvalidField {
                    field: name,
                    reason: format!("range `{lo}-{hi}` out of bounds `{min}..={max}`"),
                });
            }
            (lo, hi)
        } else {
            let single: i64 = range_part.parse().map_err(|_| CronError::InvalidField {
                field: name,
                reason: format!("bad number `{range_part}`"),
            })?;
            if single < min || single > max {
                return Err(CronError::InvalidField {
                    field: name,
                    reason: format!("value `{single}` out of bounds `{min}..={max}`"),
                });
            }
            let end = if part.contains('/') { max } else { single };
            (single, end)
        };

        let mut v = start;
        while v <= end {
            set.insert(if map_seven_to_zero && v == 7 { 0 } else { v });
            v += step;
        }
    }
    if set.is_empty() {
        return Err(CronError::InvalidField {
            field: name,
            reason: "empty field".to_owned(),
        });
    }
    Ok(set)
}

impl CronExpr {
    pub fn parse(expr: &str) -> Result<Self, CronError> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(CronError::WrongFieldCount);
        }
        let minutes = parse_field(fields[0], "minute", 0, 59, false)?;
        let hours = parse_field(fields[1], "hour", 0, 23, false)?;
        let days = if fields[2] == "*" {
            BTreeSet::new()
        } else {
            parse_field(fields[2], "day", 1, 31, false)?
        };
        let months = if fields[3] == "*" {
            BTreeSet::new()
        } else {
            parse_field(fields[3], "month", 1, 12, false)?
        };
        let weekdays = if fields[4] == "*" {
            BTreeSet::new()
        } else {
            parse_field(fields[4], "weekday", 0, 7, true)?
        };
        Ok(Self {
            minutes,
            hours,
            days,
            months,
            weekdays,
        })
    }

    fn matches_day(&self, day: Date) -> bool {
        if !self.months.is_empty() && !self.months.contains(&i64::from(day.month())) {
            return false;
        }
        let dom = i64::from(day.day());
        let dow = i64::from(day.weekday().to_sunday_zero_offset());
        match (self.days.is_empty(), self.weekdays.is_empty()) {
            (true, true) => true,
            (false, true) => self.days.contains(&dom),
            (true, false) => self.weekdays.contains(&dow),
            (false, false) => self.days.contains(&dom) || self.weekdays.contains(&dow),
        }
    }

    /// Computes the first matching instant strictly after `after_ms` in `zone`.
    pub fn next_after(&self, after_ms: i64, zone: &Zone) -> Option<i64> {
        let start_wall = zone.wall_of(after_ms);
        let mut day = start_wall.date();
        for _ in 0..SEARCH_DAYS {
            if self.matches_day(day) {
                for &hour in &self.hours {
                    for &minute in &self.minutes {
                        let wall = utc_ms(day.year(), day.month(), day.day(), hour as i8, minute as i8);
                        let instant = zone.instant_of(wall);
                        if instant > after_ms {
                            return Some(instant);
                        }
                    }
                }
            }
            day = day.tomorrow().ok()?;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_five_field_cron_and_finds_next_instant() {
        let expr = CronExpr::parse("*/15 9 * * 1-5").unwrap();
        let zone = Zone::parse("+08:00").unwrap();
        // 2026-01-05 is Monday; 09:00+08:00 = 01:00 UTC.
        let mon_08_50 = utc_ms(2026, 1, 5, 0, 50);
        let next = expr.next_after(mon_08_50, &zone).unwrap();
        assert_eq!(next, utc_ms(2026, 1, 5, 1, 0));

        let next2 = expr.next_after(next, &zone).unwrap();
        assert_eq!(next2, utc_ms(2026, 1, 5, 1, 15));
    }

    #[test]
    fn rejects_invalid_cron_expressions_and_zones() {
        assert_eq!(CronExpr::parse("* * *"), Err(CronError::WrongFieldCount));
        assert!(CronExpr::parse("60 * * * *").is_err());
        assert!(Zone::parse("+25:00").is_err());
    }
}
