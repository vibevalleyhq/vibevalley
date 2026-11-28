use std::f64::consts::{FRAC_1_SQRT_2, PI};

use crate::svg::builder::num;
use crate::svg::theme::SvgTheme;

use super::kind::ShapeKind;

fn path_el(d: &str, a: &str) -> String {
    format!(r#"<path d="{d}"{a}/>"#)
}

fn poly_el(points: &[f64], a: &str) -> String {
    let mut d = String::new();
    let mut i = 0;
    while i + 1 < points.len() {
        if i > 0 {
            d.push(' ');
        }
        d.push_str(&num(points[i]));
        d.push(',');
        d.push_str(&num(points[i + 1]));
        i += 2;
    }
    format!(r#"<polygon points="{d}"{a}/>"#)
}

fn rect_el(w: f64, h: f64, a: &str, rx: &str) -> String {
    format!(
        r#"<rect x="{}" y="{}" width="{}" height="{}"{rx}{a}/>"#,
        num(-w / 2.0),
        num(-h / 2.0),
        num(w),
        num(h)
    )
}

fn brace(x: f64, h: f64, dir: f64, line: &str) -> String {
    let y = h / 2.0;
    let k = 6.0 * dir;
    format!(
        r#"<path d="M{},{}q{},0 {},6V-6q0,6 {},6q{},0 {},6V{}q0,6 {},6" fill="none"{line}/>"#,
        num(x),
        num(-y),
        num(k),
        num(k),
        num(k),
        num(-k),
        num(-k),
        num(y - 6.0),
        num(-k)
    )
}

fn wave(w: f64, h: f64, a: &str) -> String {
    let x = w / 2.0;
    let top = -h / 2.0;
    let base = h / 2.0 - 10.0;
    let q = w / 4.0;
    format!(
        r#"<path d="M{},{}H{}V{}q{},-12 {},0t{},0Z"{a}/>"#,
        num(-x),
        num(top),
        num(x),
        num(base),
        num(-q),
        num(-2.0 * q),
        num(-2.0 * q)
    )
}

pub fn draw_shape(shape: ShapeKind, w: f64, h: f64, a: &str, line: &str, theme: &SvgTheme) -> String {
    match shape {
        ShapeKind::Rect => rect_el(w, h, &theme.rounded(a), ""),
        ShapeKind::Rounded => rect_el(w, h, a, &format!(r#" rx="{}""#, num(12.0f64.min(h / 2.0)))),
        ShapeKind::Stadium => rect_el(w, h, a, &format!(r#" rx="{}""#, num(h / 2.0))),
        ShapeKind::FrRect => {
            let x = w / 2.0 - 8.0;
            format!(
                r#"{}<path d="M{},{}V{}M{},{}V{}" fill="none"{line}/>"#,
                rect_el(w, h, &theme.rounded(a), ""),
                num(-x),
                num(-h / 2.0),
                num(h / 2.0),
                num(x),
                num(-h / 2.0),
                num(h / 2.0)
            )
        }
        ShapeKind::Cyl => {
            let rx = w / 2.0;
            let ry = (w / 14.0).clamp(6.0, 12.0);
            let top = -h / 2.0 + ry;
            let bottom = h / 2.0 - ry;
            format!(
                r#"<path d="M{},{}A{},{} 0 0 1 {},{}V{}A{},{} 0 0 1 {},{}Z"{a}/><path d="M{},{}A{},{} 0 0 0 {},{}" fill="none"{line}/>"#,
                num(-rx),
                num(top),
                num(rx),
                num(ry),
                num(rx),
                num(top),
                num(bottom),
                num(rx),
                num(ry),
                num(-rx),
                num(bottom),
                num(-rx),
                num(top),
                num(rx),
                num(ry),
                num(rx),
                num(top)
            )
        }
        ShapeKind::Circle | ShapeKind::SmCirc => format!(r#"<circle r="{}"{a}/>"#, num(w / 2.0)),
        ShapeKind::DblCirc => format!(r#"<circle r="{}"{a}/><circle r="{}" fill="none"{line}/>"#, num(w / 2.0), num(w / 2.0 - 5.0)),
        ShapeKind::Ellipse => {
            format!(r#"<ellipse rx="{}" ry="{}"{a}/>"#, num(w / 2.0), num(h / 2.0))
        }
        ShapeKind::Diam => poly_el(&[0.0, -h / 2.0, w / 2.0, 0.0, 0.0, h / 2.0, -w / 2.0, 0.0], a),
        ShapeKind::Hex => {
            let m = h / 4.0;
            poly_el(
                &[
                    -w / 2.0 + m,
                    -h / 2.0,
                    w / 2.0 - m,
                    -h / 2.0,
                    w / 2.0,
                    0.0,
                    w / 2.0 - m,
                    h / 2.0,
                    -w / 2.0 + m,
                    h / 2.0,
                    -w / 2.0,
                    0.0,
                ],
                a,
            )
        }
        ShapeKind::Odd => {
            let notch = h / 4.0;
            poly_el(
                &[
                    -w / 2.0,
                    -h / 2.0,
                    w / 2.0,
                    -h / 2.0,
                    w / 2.0,
                    h / 2.0,
                    -w / 2.0,
                    h / 2.0,
                    -w / 2.0 + notch,
                    0.0,
                ],
                a,
            )
        }
        ShapeKind::LeanR => {
            let s = h / 4.0;
            poly_el(&[-w / 2.0 + s, -h / 2.0, w / 2.0, -h / 2.0, w / 2.0 - s, h / 2.0, -w / 2.0, h / 2.0], a)
        }
        ShapeKind::LeanL => {
            let s = h / 4.0;
            poly_el(&[-w / 2.0, -h / 2.0, w / 2.0 - s, -h / 2.0, w / 2.0, h / 2.0, -w / 2.0 + s, h / 2.0], a)
        }
        ShapeKind::TrapB => {
            let s = h / 4.0;
            poly_el(&[-w / 2.0 + s, -h / 2.0, w / 2.0 - s, -h / 2.0, w / 2.0, h / 2.0, -w / 2.0, h / 2.0], a)
        }
        ShapeKind::TrapT => {
            let s = h / 4.0;
            poly_el(&[-w / 2.0, -h / 2.0, w / 2.0, -h / 2.0, w / 2.0 - s, h / 2.0, -w / 2.0 + s, h / 2.0], a)
        }
        ShapeKind::Text => rect_el(w, h, r#" fill="none" stroke="none""#, ""),
        ShapeKind::FCirc => format!(r#"<circle r="{}" fill="{}"{line}/>"#, num(w / 2.0), theme.line()),
        ShapeKind::FrCirc => format!(
            r#"<circle r="{}"{a}/><circle r="{}" fill="{}"{line}/>"#,
            num(w / 2.0),
            num(w / 2.0 - 4.0),
            theme.line()
        ),
        ShapeKind::Fork => rect_el(w, h, &format!(r#" fill="{}"{line}"#, theme.line()), r#" rx="2""#),
        ShapeKind::NotchRect => {
            let c = 10.0;
            poly_el(
                &[
                    -w / 2.0 + c,
                    -h / 2.0,
                    w / 2.0,
                    -h / 2.0,
                    w / 2.0,
                    h / 2.0,
                    -w / 2.0,
                    h / 2.0,
                    -w / 2.0,
                    -h / 2.0 + c,
                ],
                a,
            )
        }
        ShapeKind::LinRect => format!(
            r#"{}<path d="M{},{}V{}" fill="none"{line}/>"#,
            rect_el(w, h, &theme.rounded(a), ""),
            num(-w / 2.0 + 8.0),
            num(-h / 2.0),
            num(h / 2.0)
        ),
        ShapeKind::DivRect => format!(
            r#"{}<path d="M{},{}H{}" fill="none"{line}/>"#,
            rect_el(w, h, &theme.rounded(a), ""),
            num(-w / 2.0),
            num(-h / 2.0 + 8.0),
            num(w / 2.0)
        ),
        ShapeKind::WinPane => format!(
            r#"{}<path d="M{},{}V{}M{},{}H{}" fill="none"{line}/>"#,
            rect_el(w, h, &theme.rounded(a), ""),
            num(-w / 2.0 + 8.0),
            num(-h / 2.0),
            num(h / 2.0),
            num(-w / 2.0),
            num(-h / 2.0 + 8.0),
            num(w / 2.0)
        ),
        ShapeKind::Tri => poly_el(&[0.0, -h / 2.0, w / 2.0, h / 2.0, -w / 2.0, h / 2.0], a),
        ShapeKind::FlipTri => poly_el(&[-w / 2.0, -h / 2.0, w / 2.0, -h / 2.0, 0.0, h / 2.0], a),
        ShapeKind::SlRect => poly_el(&[-w / 2.0, -h / 2.0 + 10.0, w / 2.0, -h / 2.0, w / 2.0, h / 2.0, -w / 2.0, h / 2.0], a),
        ShapeKind::NotchPent => {
            let c = 10.0;
            poly_el(
                &[
                    -w / 2.0 + c,
                    -h / 2.0,
                    w / 2.0 - c,
                    -h / 2.0,
                    w / 2.0,
                    -h / 2.0 + c,
                    w / 2.0,
                    h / 2.0,
                    -w / 2.0,
                    h / 2.0,
                    -w / 2.0,
                    -h / 2.0 + c,
                ],
                a,
            )
        }
        ShapeKind::Hourglass => poly_el(&[-w / 2.0, -h / 2.0, w / 2.0, -h / 2.0, -w / 2.0, h / 2.0, w / 2.0, h / 2.0], a),
        ShapeKind::Delay => {
            let r = h / 2.0;
            path_el(
                &format!(
                    "M{},{}H{}A{},{} 0 0 1 {},{}H{}Z",
                    num(-w / 2.0),
                    num(-r),
                    num(w / 2.0 - r),
                    num(r),
                    num(r),
                    num(w / 2.0 - r),
                    num(r),
                    num(-w / 2.0)
                ),
                a,
            )
        }
        ShapeKind::HCyl => {
            let ry = h / 2.0;
            let rx = (h / 4.0).min(12.0);
            let l = -w / 2.0 + rx;
            let r = w / 2.0 - rx;
            format!(
                r#"<path d="M{},{}H{}A{},{} 0 0 1 {},{}H{}A{},{} 0 0 1 {},{}Z"{a}/><path d="M{},{}A{},{} 0 0 0 {},{}" fill="none"{line}/>"#,
                num(l),
                num(-ry),
                num(r),
                num(rx),
                num(ry),
                num(r),
                num(ry),
                num(l),
                num(rx),
                num(ry),
                num(l),
                num(-ry),
                num(r),
                num(-ry),
                num(rx),
                num(ry),
                num(r),
                num(ry)
            )
        }
        ShapeKind::CrossCirc => {
            let r = w / 2.0;
            let k = r * FRAC_1_SQRT_2;
            format!(
                r#"<circle r="{}"{a}/><path d="M{},{}L{},{}M{},{}L{},{}" fill="none"{line}/>"#,
                num(r),
                num(-k),
                num(-k),
                num(k),
                num(k),
                num(k),
                num(-k),
                num(-k),
                num(k)
            )
        }
        ShapeKind::StRect => {
            let bw = w - 8.0;
            let bh = h - 8.0;
            let rounded = theme.rounded(a);
            let mut out = String::new();
            for i in 0..3 {
                let x = -w / 2.0 + (2 - i) as f64 * 4.0;
                let y = -h / 2.0 + i as f64 * 4.0;
                out.push_str(&format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}"{rounded}/>"#,
                    num(x),
                    num(y),
                    num(bw),
                    num(bh)
                ));
            }
            out
        }
        ShapeKind::Doc => wave(w, h, a),
        ShapeKind::Flag => {
            let x = w / 2.0;
            let y = h / 2.0 - 8.0;
            let q = w / 4.0;
            path_el(
                &format!(
                    "M{},{}q{},-10 {},0t{},0V{}q{},10 {},0t{},0Z",
                    num(-x),
                    num(-y),
                    num(q),
                    num(2.0 * q),
                    num(2.0 * q),
                    num(y),
                    num(-q),
                    num(-2.0 * q),
                    num(-2.0 * q)
                ),
                a,
            )
        }
        ShapeKind::Datastore => {
            let border_attr = format!(r#"stroke="{}""#, theme.border());
            let no_stroke = a.replace(&border_attr, r#"stroke="none""#);
            format!(
                r#"{}<path d="M{},{}H{}M{},{}H{}" fill="none"{line}/>"#,
                rect_el(w, h, &no_stroke, ""),
                num(-w / 2.0),
                num(-h / 2.0),
                num(w / 2.0),
                num(-w / 2.0),
                num(h / 2.0),
                num(w / 2.0)
            )
        }
        ShapeKind::Folder => {
            let x = w / 2.0;
            let y = h / 2.0;
            let tab = (w * 0.4).min(48.0);
            path_el(
                &format!(
                    "M{},{}H{}L{},{}H{}V{}H{}Z",
                    num(-x),
                    num(-y),
                    num(-x + tab),
                    num(-x + tab + 8.0),
                    num(-y + 8.0),
                    num(x),
                    num(y),
                    num(-x)
                ),
                a,
            )
        }
        ShapeKind::Bucket => {
            let x = w / 2.0;
            let y = h / 2.0;
            let ry = 5.0;
            let taper = h / 6.0;
            format!(
                r#"{}<path d="M{},{}A{},{} 0 0 0 {},{}" fill="none"{line}/>"#,
                path_el(
                    &format!(
                        "M{},{}A{},{} 0 0 1 {},{}L{},{}A{},{} 0 0 1 {},{}Z",
                        num(-x),
                        num(-y + ry),
                        num(x),
                        num(ry),
                        num(x),
                        num(-y + ry),
                        num(x - taper),
                        num(y - ry),
                        num(x - taper),
                        num(ry),
                        num(-x + taper),
                        num(y - ry)
                    ),
                    a
                ),
                num(-x),
                num(-y + ry),
                num(x),
                num(ry),
                num(x),
                num(-y + ry)
            )
        }
        ShapeKind::Console => format!(
            r#"{}<path d="M{},{}H{}M{},{}l3,2.5l-3,2.5M{},{}h4" fill="none"{line}/>"#,
            rect_el(w, h, &theme.rounded(a), ""),
            num(-w / 2.0),
            num(-h / 2.0 + 12.0),
            num(w / 2.0),
            num(-w / 2.0 + 7.0),
            num(-h / 2.0 + 4.0),
            num(-w / 2.0 + 13.0),
            num(-h / 2.0 + 9.0)
        ),
        ShapeKind::Browser => {
            let mut dots = String::new();
            for i in 0..3 {
                dots.push_str(&format!(
                    r#"<circle cx="{}" cy="{}" r="1.5" fill="none"{line}/>"#,
                    num(-w / 2.0 + 8.0 + i as f64 * 7.0),
                    num(-h / 2.0 + 6.0)
                ));
            }
            format!(
                r#"{}<path d="M{},{}H{}" fill="none"{line}/>{dots}"#,
                rect_el(w, h, &theme.rounded(a), ""),
                num(-w / 2.0),
                num(-h / 2.0 + 12.0),
                num(w / 2.0)
            )
        }
        ShapeKind::Person => {
            let top = -h / 2.0;
            format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}" rx="12"{a}/><circle cy="{}" r="13"{a}/>"#,
                num(-w / 2.0),
                num(top + 26.0),
                num(w),
                num(h - 26.0),
                num(top + 14.0)
            )
        }
        ShapeKind::Bang => {
            let spikes = 14usize;
            let mut pts = Vec::with_capacity(spikes * 4);
            for i in 0..(spikes * 2) {
                let angle = (PI * i as f64) / spikes as f64 - PI / 2.0;
                let k = if i % 2 == 0 { 1.0 } else { 0.82 };
                pts.push(angle.cos() * (w / 2.0) * k);
                pts.push(angle.sin() * (h / 2.0) * k);
            }
            poly_el(&pts, a)
        }
        ShapeKind::Cloud => {
            let x = w / 2.0;
            let y = h / 2.0;
            let r = y * 0.55;
            path_el(
                &format!(
                    "M{},{}A{},{} 0 0 1 {},{}A{},{} 0 0 1 {},{}A{},{} 0 0 1 {},{}A{},{} 0 0 1 {},{}Z",
                    num(-x + r),
                    num(y),
                    num(r),
                    num(r),
                    num(-x + r * 0.6),
                    num(-y * 0.1),
                    num(x * 0.42),
                    num(y * 0.7),
                    num(-x * 0.1),
                    num(-y * 0.72),
                    num(x * 0.4),
                    num(y * 0.62),
                    num(x * 0.62),
                    num(-y * 0.42),
                    num(r * 1.05),
                    num(r * 1.05),
                    num(x - r),
                    num(y)
                ),
                a,
            )
        }
        ShapeKind::Brace => format!(
            "{}{}",
            rect_el(w, h, r#" fill="none" stroke="none""#, ""),
            brace(-w / 2.0 + 12.0, h, -1.0, line)
        ),
        ShapeKind::BraceR => format!("{}{}", rect_el(w, h, r#" fill="none" stroke="none""#, ""), brace(w / 2.0 - 12.0, h, 1.0, line)),
        ShapeKind::Braces => format!(
            "{}{}{}",
            rect_el(w, h, r#" fill="none" stroke="none""#, ""),
            brace(-w / 2.0 + 12.0, h, -1.0, line),
            brace(w / 2.0 - 12.0, h, 1.0, line)
        ),
        ShapeKind::Bolt => poly_el(
            &[
                w * 0.15,
                -h / 2.0,
                -w / 2.0,
                h * 0.08,
                -w * 0.05,
                h * 0.08,
                -w * 0.15,
                h / 2.0,
                w / 2.0,
                -h * 0.08,
                w * 0.05,
                -h * 0.08,
            ],
            a,
        ),
        ShapeKind::LinCyl => {
            let rx = w / 2.0;
            let ry = (w / 14.0).clamp(6.0, 12.0);
            let top = -h / 2.0 + ry;
            let bottom = h / 2.0 - ry;
            let arc = |y: f64| format!("M{},{}A{},{} 0 0 0 {},{}", num(-rx), num(y), num(rx), num(ry), num(rx), num(y));
            format!(
                r#"{}<path d="{}{}" fill="none"{line}/>"#,
                path_el(
                    &format!(
                        "M{},{}A{},{} 0 0 1 {},{}V{}A{},{} 0 0 1 {},{}Z",
                        num(-rx),
                        num(top),
                        num(rx),
                        num(ry),
                        num(rx),
                        num(top),
                        num(bottom),
                        num(rx),
                        num(ry),
                        num(-rx),
                        num(bottom)
                    ),
                    a
                ),
                arc(top),
                arc(top + 8.0)
            )
        }
        ShapeKind::CurvTrap => {
            let x = w / 2.0;
            let y = h / 2.0;
            let k = h * 0.3;
            path_el(
                &format!(
                    "M{},{}H{}A{},{} 0 0 1 {},{}H{}L{},0Z",
                    num(-x + k),
                    num(-y),
                    num(x - k),
                    num(k),
                    num(y),
                    num(x - k),
                    num(y),
                    num(-x + k),
                    num(-x)
                ),
                a,
            )
        }
        ShapeKind::Docs => {
            let mut out = String::new();
            for i in 0..3 {
                out.push_str(&format!(
                    r#"<g transform="translate({},{})">{}</g>"#,
                    (1 - i) * 4,
                    (i - 1) * 4,
                    wave(w - 8.0, h - 8.0, a)
                ));
            }
            out
        }
        ShapeKind::BowRect => {
            let x = w / 2.0;
            let y = h / 2.0;
            let k = h * 0.2;
            path_el(
                &format!(
                    "M{},{}H{}A{},{} 0 0 0 {},{}H{}A{},{} 0 0 1 {},{}Z",
                    num(-x + k),
                    num(-y),
                    num(x),
                    num(k),
                    num(y),
                    num(x),
                    num(y),
                    num(-x + k),
                    num(k),
                    num(y),
                    num(-x + k),
                    num(-y)
                ),
                a,
            )
        }
        ShapeKind::TagRect => format!(
            r#"{}<path d="M{},{}L{},{}" fill="none"{line}/>"#,
            rect_el(w, h, &theme.rounded(a), ""),
            num(w / 2.0 - 12.0),
            num(h / 2.0),
            num(w / 2.0),
            num(h / 2.0 - 12.0)
        ),
        ShapeKind::TagDoc => format!(
            r#"{}<path d="M{},{}L{},{}" fill="none"{line}/>"#,
            wave(w, h, a),
            num(w / 2.0 - 12.0),
            num(h / 2.0 - 14.0),
            num(w / 2.0),
            num(h / 2.0 - 26.0)
        ),
        ShapeKind::LinDoc => format!(
            r#"{}<path d="M{},{}V{}" fill="none"{line}/>"#,
            wave(w, h, a),
            num(-w / 2.0 + 8.0),
            num(-h / 2.0),
            num(h / 2.0 - 6.0)
        ),
        ShapeKind::CollapsedGroup => {
            let rounded = theme.rounded(a);
            format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}"{rounded}/><rect x="{}" y="{}" width="{}" height="{}"{rounded}/>"#,
                num(-w / 2.0 + 6.0),
                num(-h / 2.0 + 8.0),
                num(w - 12.0),
                num(h - 8.0),
                num(-w / 2.0),
                num(-h / 2.0),
                num(w),
                num(h - 4.0)
            )
        }
    }
}
