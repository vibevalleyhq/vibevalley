use crate::svg::builder::num;

pub const RIGHT: u8 = 1;
pub const LEFT: u8 = 2;
pub const UP: u8 = 4;
pub const DOWN: u8 = 8;

/// How far a head reaches past each side of its shaft.
pub const OVERHANG: f64 = 7.0;
const MAX_DEPTH: f64 = 20.0;
const NUB: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrowAxis {
    X,
    Y,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArrowSize {
    pub w: f64,
    pub h: f64,
    pub dx: f64,
    pub dy: f64,
}

pub fn arrow_mask(directions: &[String]) -> u8 {
    let mut mask = 0u8;
    for direction in directions {
        match direction.trim() {
            "right" => mask |= RIGHT,
            "left" => mask |= LEFT,
            "up" => mask |= UP,
            "down" => mask |= DOWN,
            "x" => mask |= RIGHT | LEFT,
            "y" => mask |= UP | DOWN,
            _ => {}
        }
    }
    mask
}

#[inline]
fn bit(mask: u8, flag: u8) -> f64 {
    if (mask & flag) != 0 { 1.0 } else { 0.0 }
}

pub fn arrow_axis(mask: u8) -> ArrowAxis {
    if mask != 0 && (mask & (UP | DOWN)) == 0 {
        ArrowAxis::X
    } else if mask != 0 && (mask & (RIGHT | LEFT)) == 0 {
        ArrowAxis::Y
    } else {
        ArrowAxis::Both
    }
}

pub fn arrow_size(mask: u8, tw: f64, th: f64) -> ArrowSize {
    let axis = arrow_axis(mask);
    let across = bit(mask, LEFT) - bit(mask, RIGHT);
    let along = bit(mask, UP) - bit(mask, DOWN);
    match axis {
        ArrowAxis::X => {
            let h = (th + 8.0).max(14.0) + 2.0 * OVERHANG;
            let depth = (h / 2.0).min(MAX_DEPTH);
            let heads = if mask == (RIGHT | LEFT) { 2.0 } else { 1.0 };
            ArrowSize {
                w: (tw + 12.0).max(16.0) + depth * heads,
                h,
                dx: (across * depth) / 2.0,
                dy: 0.0,
            }
        }
        ArrowAxis::Y => {
            let w = (tw + 16.0).max(14.0) + 2.0 * OVERHANG;
            let depth = (w / 2.0).min(MAX_DEPTH);
            let heads = if mask == (UP | DOWN) { 2.0 } else { 1.0 };
            ArrowSize {
                w,
                h: (th + 8.0).max(16.0) + depth * heads,
                dx: 0.0,
                dy: (along * depth) / 2.0,
            }
        }
        ArrowAxis::Both => ArrowSize {
            w: (tw + 16.0).max(24.0) + NUB * (bit(mask, LEFT) + bit(mask, RIGHT)),
            h: (th + 8.0).max(24.0) + NUB * (bit(mask, UP) + bit(mask, DOWN)),
            dx: (across * NUB) / 2.0,
            dy: (along * NUB) / 2.0,
        },
    }
}

pub fn draw_arrow(mask: u8, w: f64, h: f64, attrs: &str) -> String {
    let axis = arrow_axis(mask);
    let x = w / 2.0;
    let y = h / 2.0;
    let mut p: Vec<f64> = Vec::with_capacity(32);
    match axis {
        ArrowAxis::X => {
            let depth = y.min(MAX_DEPTH);
            let s = y - OVERHANG;
            let x0 = if (mask & LEFT) != 0 { -x + depth } else { -x };
            let x1 = if (mask & RIGHT) != 0 { x - depth } else { x };
            p.extend_from_slice(&[x0, -s, x1, -s]);
            if (mask & RIGHT) != 0 {
                p.extend_from_slice(&[x1, -y, x, 0.0, x1, y]);
            }
            p.extend_from_slice(&[x1, s, x0, s]);
            if (mask & LEFT) != 0 {
                p.extend_from_slice(&[x0, y, -x, 0.0, x0, -y]);
            }
        }
        ArrowAxis::Y => {
            let depth = x.min(MAX_DEPTH);
            let s = x - OVERHANG;
            let y0 = if (mask & UP) != 0 { -y + depth } else { -y };
            let y1 = if (mask & DOWN) != 0 { y - depth } else { y };
            p.extend_from_slice(&[s, y0, s, y1]);
            if (mask & DOWN) != 0 {
                p.extend_from_slice(&[x, y1, 0.0, y, -x, y1]);
            }
            p.extend_from_slice(&[-s, y1, -s, y0]);
            if (mask & UP) != 0 {
                p.extend_from_slice(&[-x, y0, 0.0, -y, x, y0]);
            }
        }
        ArrowAxis::Both => {
            let x0 = if (mask & LEFT) != 0 { -x + NUB } else { -x };
            let x1 = if (mask & RIGHT) != 0 { x - NUB } else { x };
            let y0 = if (mask & UP) != 0 { -y + NUB } else { -y };
            let y1 = if (mask & DOWN) != 0 { y - NUB } else { y };
            let cx = (x0 + x1) / 2.0;
            let cy = (y0 + y1) / 2.0;
            let kx = 10.0f64.min((x1 - x0) / 2.0);
            let ky = 10.0f64.min((y1 - y0) / 2.0);
            p.extend_from_slice(&[x0, y0]);
            if (mask & UP) != 0 {
                p.extend_from_slice(&[cx - kx, y0, cx, -y, cx + kx, y0]);
            }
            p.extend_from_slice(&[x1, y0]);
            if (mask & RIGHT) != 0 {
                p.extend_from_slice(&[x1, cy - ky, x, cy, x1, cy + ky]);
            }
            p.extend_from_slice(&[x1, y1]);
            if (mask & DOWN) != 0 {
                p.extend_from_slice(&[cx + kx, y1, cx, y, cx - kx, y1]);
            }
            p.extend_from_slice(&[x0, y1]);
            if (mask & LEFT) != 0 {
                p.extend_from_slice(&[x0, cy + ky, -x, cy, x0, cy - ky]);
            }
        }
    }
    let mut points = String::new();
    let mut i = 0;
    while i + 1 < p.len() {
        if i > 0 {
            points.push(' ');
        }
        points.push_str(&num(p[i]));
        points.push(',');
        points.push_str(&num(p[i + 1]));
        i += 2;
    }
    format!(r#"<polygon points="{points}" stroke-linejoin="round"{attrs}/>"#)
}
