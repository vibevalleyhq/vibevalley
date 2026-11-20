use crate::spec::{AxisScale, AxisSpec, NumberFormat};

/// Computed numeric scale with Nice-Number tick positions and formatted labels.
#[derive(Debug, Clone, PartialEq)]
pub struct NumericScale {
    pub domain_min: f64,
    pub domain_max: f64,
    pub scale: AxisScale,
    pub ticks: Vec<f64>,
    pub tick_labels: Vec<String>,
}

impl NumericScale {
    /// Builds a linear or logarithmic scale from observed data range and axis options.
    pub fn build(data_min: f64, data_max: f64, axis: &AxisSpec, include_zero: bool, default_format: NumberFormat) -> Self {
        let format = if axis.format == NumberFormat::Number { default_format } else { axis.format };
        let target_ticks = axis.tick_count.unwrap_or(5).clamp(2, 50);

        match axis.scale {
            AxisScale::Linear => build_linear(data_min, data_max, axis, include_zero, format, target_ticks),
            AxisScale::Log => build_log(data_min, data_max, axis, format),
        }
    }

    /// Maps a domain value to `[0.0, 1.0]` along the scale (not clamped).
    pub fn normalize(&self, value: f64) -> f64 {
        match self.scale {
            AxisScale::Linear => {
                let span = self.domain_max - self.domain_min;
                if span.abs() < f64::EPSILON { 0.5 } else { (value - self.domain_min) / span }
            }
            AxisScale::Log => {
                let lo = self.domain_min.max(1e-12).log10();
                let hi = self.domain_max.max(1e-12).log10();
                let span = hi - lo;
                if span.abs() < f64::EPSILON {
                    0.5
                } else {
                    (value.max(1e-12).log10() - lo) / span
                }
            }
        }
    }

    /// Maps a domain value onto `[range_start, range_end]` in SVG coordinates.
    pub fn map(&self, value: f64, range_start: f64, range_end: f64) -> f64 {
        let t = self.normalize(value);
        range_start + (range_end - range_start) * t
    }
}

/// Paul Heckbert's "Nice Numbers for Graph Labels" helper.
pub fn nice_number(range: f64, round: bool) -> f64 {
    if !range.is_finite() || range <= 0.0 {
        return 1.0;
    }
    let exponent = range.log10().floor();
    let fraction = range / 10_f64.powf(exponent);
    let nice_fraction = if round {
        if fraction < 1.5 {
            1.0
        } else if fraction < 3.0 {
            2.0
        } else if fraction < 7.0 {
            5.0
        } else {
            10.0
        }
    } else if fraction <= 1.0 {
        1.0
    } else if fraction <= 2.0 {
        2.0
    } else if fraction <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice_fraction * 10_f64.powf(exponent)
}

fn build_linear(data_min: f64, data_max: f64, axis: &AxisSpec, include_zero: bool, format: NumberFormat, target_ticks: usize) -> NumericScale {
    let mut raw_min = axis.min.unwrap_or(data_min);
    let mut raw_max = axis.max.unwrap_or(data_max);

    if include_zero {
        if axis.min.is_none() && raw_min > 0.0 {
            raw_min = 0.0;
        }
        if axis.max.is_none() && raw_max < 0.0 {
            raw_max = 0.0;
        }
    }

    if (raw_max - raw_min).abs() < 1e-12 {
        if raw_min.abs() < 1e-12 {
            raw_min = 0.0;
            raw_max = 1.0;
        } else {
            let pad = (raw_min.abs() * 0.2).max(1.0);
            if axis.min.is_none() {
                raw_min -= pad;
            }
            if axis.max.is_none() {
                raw_max += pad;
            }
        }
    }

    let range = nice_number(raw_max - raw_min, false);
    let step = nice_number(range / (target_ticks.saturating_sub(1).max(1) as f64), true);

    let domain_min = match axis.min {
        Some(explicit) => explicit,
        None => clean_float((raw_min / step).floor() * step, step),
    };
    let domain_max = match axis.max {
        Some(explicit) => explicit,
        None => clean_float((raw_max / step).ceil() * step, step),
    };

    let first_tick = if axis.min.is_some() { (domain_min / step).ceil() * step } else { domain_min };

    let mut ticks = Vec::new();
    let eps = step * 1e-6;
    let mut cur = first_tick;
    let mut guard = 0usize;
    while cur <= domain_max + eps && guard < 128 {
        let cleaned = clean_float(cur, step);
        if cleaned >= domain_min - eps && cleaned <= domain_max + eps {
            ticks.push(cleaned);
        }
        cur += step;
        guard += 1;
    }

    if ticks.is_empty() {
        ticks.push(clean_float(domain_min, step));
        ticks.push(clean_float(domain_max, step));
    }

    let tick_labels = ticks
        .iter()
        .map(|&t| format_value(t, format, axis.currency_symbol.as_deref(), axis.decimals))
        .collect();

    NumericScale {
        domain_min,
        domain_max,
        scale: AxisScale::Linear,
        ticks,
        tick_labels,
    }
}

fn build_log(data_min: f64, data_max: f64, axis: &AxisSpec, format: NumberFormat) -> NumericScale {
    let raw_min = axis.min.unwrap_or(data_min).max(1e-9);
    let raw_max = axis.max.unwrap_or(data_max).max(raw_min * 1.1);

    let min_exp = raw_min.log10().floor() as i32;
    let max_exp = raw_max.log10().ceil() as i32;

    let domain_min = axis.min.unwrap_or_else(|| 10_f64.powi(min_exp));
    let domain_max = axis.max.unwrap_or_else(|| {
        let exp = if max_exp <= min_exp { min_exp + 1 } else { max_exp };
        10_f64.powi(exp)
    });

    let decade_span = (max_exp - min_exp).max(1);
    let mut ticks = Vec::new();

    if decade_span <= 2 {
        for exp in min_exp..=max_exp {
            let base = 10_f64.powi(exp);
            for mult in [1.0, 2.0, 5.0] {
                let v = clean_float(base * mult, base * 0.1);
                if v >= domain_min * (1.0 - 1e-9) && v <= domain_max * (1.0 + 1e-9) {
                    ticks.push(v);
                }
            }
        }
    } else {
        let exp_step = if decade_span > 10 { ((decade_span as f64) / 6.0).ceil() as i32 } else { 1 };
        let mut exp = min_exp;
        while exp <= max_exp {
            let v = 10_f64.powi(exp);
            if v >= domain_min * (1.0 - 1e-9) && v <= domain_max * (1.0 + 1e-9) {
                ticks.push(v);
            }
            exp += exp_step;
        }
    }

    if ticks.is_empty() {
        ticks.push(domain_min);
        ticks.push(domain_max);
    }

    let tick_labels = ticks
        .iter()
        .map(|&t| format_value(t, format, axis.currency_symbol.as_deref(), axis.decimals))
        .collect();

    NumericScale {
        domain_min,
        domain_max,
        scale: AxisScale::Log,
        ticks,
        tick_labels,
    }
}

/// Cleans IEEE-754 rounding artifacts (e.g. `0.30000000000000004`, `-0.0`).
pub(crate) fn clean_float(value: f64, step: f64) -> f64 {
    let decimals = if step > 0.0 && step.is_finite() {
        (-step.log10().floor()).clamp(0.0, 8.0) as i32 + 2
    } else {
        6
    };
    let factor = 10_f64.powi(decimals);
    let rounded = (value * factor).round() / factor;
    if rounded.abs() < 1e-12 { 0.0 } else { rounded }
}

/// Formats a numeric value according to `NumberFormat`.
pub fn format_value(value: f64, format: NumberFormat, currency_symbol: Option<&str>, decimals: Option<u8>) -> String {
    let v = if value.abs() < 1e-12 { 0.0 } else { value };
    match format {
        NumberFormat::Number => format_plain_number(v, decimals),
        NumberFormat::Compact => format_compact(v, decimals),
        NumberFormat::Percent => format_percent(v, decimals),
        NumberFormat::Currency => {
            let sym = currency_symbol.unwrap_or("$");
            let sign = if v < 0.0 { "-" } else { "" };
            let abs = v.abs();
            let body = if abs >= 1_000.0 && decimals.is_none() {
                format_compact(abs, None)
            } else {
                format_plain_number(abs, decimals)
            };
            format!("{sign}{sym}{body}")
        }
        NumberFormat::Duration => format_duration(v),
    }
}

fn format_plain_number(value: f64, decimals: Option<u8>) -> String {
    if let Some(d) = decimals {
        return with_thousands_sep(&format!("{value:.prec$}", prec = usize::from(d)));
    }
    let abs = value.abs();
    if abs >= 1e9 || (abs > 0.0 && abs < 1e-4) {
        return format!("{value:.2e}");
    }
    if (value - value.round()).abs() < 1e-9 {
        return with_thousands_sep(&format!("{}", value.round() as i64));
    }
    let raw = if abs >= 100.0 {
        format!("{value:.1}")
    } else if abs >= 1.0 {
        format!("{value:.2}")
    } else {
        format!("{value:.4}")
    };
    with_thousands_sep(&trim_trailing_zeros(&raw))
}

fn format_compact(value: f64, decimals: Option<u8>) -> String {
    let sign = if value < 0.0 { "-" } else { "" };
    let abs = value.abs();
    let (scaled, suffix) = if abs >= 1e12 {
        (abs / 1e12, "T")
    } else if abs >= 1e9 {
        (abs / 1e9, "B")
    } else if abs >= 1e6 {
        (abs / 1e6, "M")
    } else if abs >= 1e3 {
        (abs / 1e3, "K")
    } else {
        return format_plain_number(value, decimals);
    };

    let body = if let Some(d) = decimals {
        format!("{scaled:.prec$}", prec = usize::from(d))
    } else if scaled >= 100.0 || (scaled - scaled.round()).abs() < 1e-9 {
        format!("{:.0}", scaled)
    } else {
        trim_trailing_zeros(&format!("{scaled:.1}"))
    };
    format!("{sign}{body}{suffix}")
}

fn format_percent(value: f64, decimals: Option<u8>) -> String {
    let pct = value * 100.0;
    let body = if let Some(d) = decimals {
        format!("{pct:.prec$}", prec = usize::from(d))
    } else if (pct - pct.round()).abs() < 1e-6 {
        format!("{:.0}", pct.round())
    } else {
        trim_trailing_zeros(&format!("{pct:.1}"))
    };
    format!("{body}%")
}

fn format_duration(seconds: f64) -> String {
    let sign = if seconds < 0.0 { "-" } else { "" };
    let abs = seconds.abs();
    if abs < 1e-9 {
        return "0s".to_string();
    }
    if abs < 0.001 {
        let us = abs * 1_000_000.0;
        return format!("{sign}{}us", trim_trailing_zeros(&format!("{us:.1}")));
    }
    if abs < 1.0 {
        let ms = abs * 1_000.0;
        return format!("{sign}{}ms", trim_trailing_zeros(&format!("{ms:.1}")));
    }
    if abs < 60.0 {
        return format!("{sign}{}s", trim_trailing_zeros(&format!("{abs:.1}")));
    }
    if abs < 3600.0 {
        let mins = (abs / 60.0).floor() as u64;
        let rem = (abs - (mins as f64) * 60.0).round() as u64;
        if rem == 0 {
            return format!("{sign}{mins}m");
        }
        return format!("{sign}{mins}m {rem}s");
    }
    if abs < 86_400.0 {
        let hours = abs / 3600.0;
        if (hours - hours.round()).abs() < 1e-6 {
            return format!("{sign}{}h", hours.round() as u64);
        }
        let whole_h = hours.floor() as u64;
        let rem_m = ((abs - (whole_h as f64) * 3600.0) / 60.0).round() as u64;
        if rem_m == 0 {
            return format!("{sign}{whole_h}h");
        }
        return format!("{sign}{whole_h}h {rem_m}m");
    }
    let days = abs / 86_400.0;
    format!("{sign}{}d", trim_trailing_zeros(&format!("{days:.1}")))
}

fn trim_trailing_zeros(s: &str) -> String {
    if !s.contains('.') {
        return s.to_string();
    }
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed == "-0" || trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn with_thousands_sep(num: &str) -> String {
    let (sign, rest) = match num.strip_prefix('-') {
        Some(r) => ("-", r),
        None => ("", num),
    };
    let (int_part, frac_part) = match rest.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (rest, None),
    };
    if int_part.len() <= 3 {
        return num.to_string();
    }
    let mut out = String::with_capacity(num.len() + int_part.len() / 3);
    out.push_str(sign);
    for (idx, ch) in int_part.chars().enumerate() {
        if idx > 0 && (int_part.len() - idx).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if let Some(f) = frac_part {
        out.push('.');
        out.push_str(f);
    }
    out
}
