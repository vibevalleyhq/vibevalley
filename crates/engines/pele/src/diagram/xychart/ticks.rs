/// Step of 1, 2, or 5 times a power of ten dividing `span` into roughly `count` parts.
/// Steps below 1 are returned as the negative of their integer inverse so tick values
/// are computed by division without floating-point accumulation noise.
pub fn tick_step(span: f64, count: f64) -> f64 {
    let raw = span / count.max(1.0);
    let power = raw.log10().floor();
    let pow10 = 10.0f64.powf(power);
    let unit = raw / pow10;
    let factor = if unit >= 7.07 {
        10.0
    } else if unit >= 3.16 {
        5.0
    } else if unit >= 1.41 {
        2.0
    } else {
        1.0
    };
    if power < 0.0 { -(10.0f64.powf(-power)) / factor } else { factor * pow10 }
}

pub fn tick_index(step: f64, value: f64) -> f64 {
    if step > 0.0 { value / step } else { value * -step }
}

pub fn tick_value(step: f64, index: f64) -> f64 {
    let v = if step > 0.0 { index * step } else { index / -step };
    if v == 0.0 { 0.0 } else { v }
}

pub fn ticks_between(lo: f64, hi: f64, step: f64) -> Vec<f64> {
    let mut first = tick_index(step, lo).round();
    if tick_value(step, first) < lo {
        first += 1.0;
    }
    let mut last = tick_index(step, hi).round();
    if tick_value(step, last) > hi {
        last -= 1.0;
    }
    let mut out = Vec::new();
    let mut idx = first;
    while idx <= last && out.len() < 100 {
        out.push(tick_value(step, idx));
        idx += 1.0;
    }
    out
}
