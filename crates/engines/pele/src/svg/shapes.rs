use std::f64::consts::{FRAC_1_SQRT_2, PI};

use crate::layout::compound::CNode;
use crate::svg::builder::num;
use crate::svg::theme::SvgTheme;

pub const PAD_X: f64 = 18.0;
pub const PAD_Y: f64 = 12.0;
const CORNER: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShapeSize {
    pub w: f64,
    pub h: f64,
    pub dy: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShapeKind {
    Rect,
    Rounded,
    Stadium,
    FrRect,
    Cyl,
    Circle,
    DblCirc,
    Ellipse,
    Diam,
    Hex,
    Odd,
    LeanR,
    LeanL,
    TrapB,
    TrapT,
    Text,
    SmCirc,
    FCirc,
    FrCirc,
    Fork,
    NotchRect,
    LinRect,
    DivRect,
    WinPane,
    Tri,
    FlipTri,
    SlRect,
    NotchPent,
    Hourglass,
    Delay,
    HCyl,
    CrossCirc,
    StRect,
    Doc,
    Flag,
    Datastore,
    Folder,
    Bucket,
    Console,
    Browser,
    Person,
    Bang,
    Cloud,
    Brace,
    BraceR,
    Braces,
    Bolt,
    LinCyl,
    CurvTrap,
    Docs,
    BowRect,
    TagRect,
    TagDoc,
    LinDoc,
    CollapsedGroup,
}

impl ShapeKind {
    pub fn from_canonical(name: &str) -> Self {
        match name {
            "rect" => Self::Rect,
            "rounded" => Self::Rounded,
            "stadium" => Self::Stadium,
            "fr-rect" => Self::FrRect,
            "cyl" => Self::Cyl,
            "circle" => Self::Circle,
            "dbl-circ" => Self::DblCirc,
            "ellipse" => Self::Ellipse,
            "diam" => Self::Diam,
            "hex" => Self::Hex,
            "odd" => Self::Odd,
            "lean-r" => Self::LeanR,
            "lean-l" => Self::LeanL,
            "trap-b" => Self::TrapB,
            "trap-t" => Self::TrapT,
            "text" => Self::Text,
            "sm-circ" => Self::SmCirc,
            "f-circ" => Self::FCirc,
            "fr-circ" => Self::FrCirc,
            "fork" => Self::Fork,
            "notch-rect" => Self::NotchRect,
            "lin-rect" => Self::LinRect,
            "div-rect" => Self::DivRect,
            "win-pane" => Self::WinPane,
            "tri" => Self::Tri,
            "flip-tri" => Self::FlipTri,
            "sl-rect" => Self::SlRect,
            "notch-pent" => Self::NotchPent,
            "hourglass" => Self::Hourglass,
            "delay" => Self::Delay,
            "h-cyl" => Self::HCyl,
            "cross-circ" => Self::CrossCirc,
            "st-rect" => Self::StRect,
            "doc" => Self::Doc,
            "flag" => Self::Flag,
            "datastore" => Self::Datastore,
            "folder" => Self::Folder,
            "bucket" => Self::Bucket,
            "console" => Self::Console,
            "browser" => Self::Browser,
            "person" => Self::Person,
            "bang" => Self::Bang,
            "cloud" => Self::Cloud,
            "brace" => Self::Brace,
            "brace-r" => Self::BraceR,
            "braces" => Self::Braces,
            "bolt" => Self::Bolt,
            "lin-cyl" => Self::LinCyl,
            "curv-trap" => Self::CurvTrap,
            "docs" => Self::Docs,
            "bow-rect" => Self::BowRect,
            "tag-rect" => Self::TagRect,
            "tag-doc" => Self::TagDoc,
            "lin-doc" => Self::LinDoc,
            "collapsedGroup" => Self::CollapsedGroup,
            _ => Self::Rect,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rect => "rect",
            Self::Rounded => "rounded",
            Self::Stadium => "stadium",
            Self::FrRect => "fr-rect",
            Self::Cyl => "cyl",
            Self::Circle => "circle",
            Self::DblCirc => "dbl-circ",
            Self::Ellipse => "ellipse",
            Self::Diam => "diam",
            Self::Hex => "hex",
            Self::Odd => "odd",
            Self::LeanR => "lean-r",
            Self::LeanL => "lean-l",
            Self::TrapB => "trap-b",
            Self::TrapT => "trap-t",
            Self::Text => "text",
            Self::SmCirc => "sm-circ",
            Self::FCirc => "f-circ",
            Self::FrCirc => "fr-circ",
            Self::Fork => "fork",
            Self::NotchRect => "notch-rect",
            Self::LinRect => "lin-rect",
            Self::DivRect => "div-rect",
            Self::WinPane => "win-pane",
            Self::Tri => "tri",
            Self::FlipTri => "flip-tri",
            Self::SlRect => "sl-rect",
            Self::NotchPent => "notch-pent",
            Self::Hourglass => "hourglass",
            Self::Delay => "delay",
            Self::HCyl => "h-cyl",
            Self::CrossCirc => "cross-circ",
            Self::StRect => "st-rect",
            Self::Doc => "doc",
            Self::Flag => "flag",
            Self::Datastore => "datastore",
            Self::Folder => "folder",
            Self::Bucket => "bucket",
            Self::Console => "console",
            Self::Browser => "browser",
            Self::Person => "person",
            Self::Bang => "bang",
            Self::Cloud => "cloud",
            Self::Brace => "brace",
            Self::BraceR => "brace-r",
            Self::Braces => "braces",
            Self::Bolt => "bolt",
            Self::LinCyl => "lin-cyl",
            Self::CurvTrap => "curv-trap",
            Self::Docs => "docs",
            Self::BowRect => "bow-rect",
            Self::TagRect => "tag-rect",
            Self::TagDoc => "tag-doc",
            Self::LinDoc => "lin-doc",
            Self::CollapsedGroup => "collapsedGroup",
        }
    }
}

fn bulge(t: f64, half: f64, depth: f64) -> f64 {
    let k = (t.abs() / half).min(1.0);
    depth * (1.0 - (1.0 - k * k).sqrt())
}

fn round_inset(w: f64, h: f64, side: i32, t: f64) -> f64 {
    if (side & 1) != 0 {
        bulge(t, h / 2.0, w / 2.0)
    } else {
        bulge(t, w / 2.0, h / 2.0)
    }
}

fn cap_inset(w: f64, side: i32, t: f64) -> f64 {
    if (side & 1) != 0 {
        0.0
    } else {
        bulge(t, w / 2.0, (w / 14.0).clamp(6.0, 12.0))
    }
}

fn tri_size(tw: f64, th: f64, flip: bool) -> ShapeSize {
    let w = (1.6 * tw + 40.0).max(80.0);
    let h = (th + 10.0) / (1.0 - (tw + 8.0) / w);
    let dy = h / 2.0 - 10.0 - th / 2.0;
    ShapeSize {
        w,
        h,
        dy: if flip { -dy } else { dy },
    }
}

fn box_size(tw: f64, th: f64) -> ShapeSize {
    ShapeSize {
        w: (tw + 2.0 * PAD_X).max(2.0 * PAD_X + 12.0),
        h: th + 2.0 * PAD_Y,
        dy: 0.0,
    }
}

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

pub fn shape_size(shape: ShapeKind, tw: f64, th: f64) -> ShapeSize {
    match shape {
        ShapeKind::Rect | ShapeKind::Rounded | ShapeKind::NotchRect | ShapeKind::Datastore | ShapeKind::TagRect => box_size(tw, th),
        ShapeKind::Stadium => {
            let h = th + 2.0 * PAD_Y;
            ShapeSize {
                w: tw + h * 0.5 + 2.0 * PAD_X - 8.0,
                h,
                dy: 0.0,
            }
        }
        ShapeKind::FrRect => ShapeSize {
            w: tw + 2.0 * PAD_X + 16.0,
            h: th + 2.0 * PAD_Y,
            dy: 0.0,
        },
        ShapeKind::Cyl => {
            let w = (tw + 2.0 * PAD_X).max(56.0);
            let ry = (w / 14.0).clamp(6.0, 12.0);
            ShapeSize {
                w,
                h: th + 2.0 * PAD_Y + 2.0 * ry,
                dy: ry / 2.0,
            }
        }
        ShapeKind::Circle => {
            let d = ((tw * tw + th * th).sqrt() + 16.0).max(44.0);
            ShapeSize { w: d, h: d, dy: 0.0 }
        }
        ShapeKind::DblCirc => {
            let d = ((tw * tw + th * th).sqrt() + 26.0).max(54.0);
            ShapeSize { w: d, h: d, dy: 0.0 }
        }
        ShapeKind::Ellipse => ShapeSize {
            w: tw * 1.3 + 2.0 * PAD_X,
            h: th * 1.2 + 2.0 * PAD_Y,
            dy: 0.0,
        },
        ShapeKind::Diam => {
            let a = tw + 16.0;
            let b = th + 8.0;
            ShapeSize {
                w: a + 1.6 * b,
                h: a / 1.6 + b,
                dy: 0.0,
            }
        }
        ShapeKind::Hex | ShapeKind::LeanR | ShapeKind::LeanL | ShapeKind::TrapB | ShapeKind::TrapT => {
            let h = th + 2.0 * PAD_Y;
            ShapeSize {
                w: tw + 2.0 * PAD_X + h / 2.0,
                h,
                dy: 0.0,
            }
        }
        ShapeKind::Odd | ShapeKind::Delay => {
            let h = th + 2.0 * PAD_Y;
            ShapeSize {
                w: tw + 2.0 * PAD_X + h / 4.0,
                h,
                dy: 0.0,
            }
        }
        ShapeKind::Text => ShapeSize {
            w: tw + 8.0,
            h: th + 8.0,
            dy: 0.0,
        },
        ShapeKind::SmCirc | ShapeKind::FCirc => ShapeSize { w: 14.0, h: 14.0, dy: 0.0 },
        ShapeKind::FrCirc => ShapeSize { w: 18.0, h: 18.0, dy: 0.0 },
        ShapeKind::Fork => ShapeSize { w: 72.0, h: 8.0, dy: 0.0 },
        ShapeKind::LinRect => ShapeSize {
            w: tw + 2.0 * PAD_X + 8.0,
            h: th + 2.0 * PAD_Y,
            dy: 0.0,
        },
        ShapeKind::DivRect => ShapeSize {
            w: tw + 2.0 * PAD_X,
            h: th + 2.0 * PAD_Y + 8.0,
            dy: 4.0,
        },
        ShapeKind::WinPane => ShapeSize {
            w: tw + 2.0 * PAD_X + 8.0,
            h: th + 2.0 * PAD_Y + 8.0,
            dy: 4.0,
        },
        ShapeKind::Tri => tri_size(tw, th, false),
        ShapeKind::FlipTri => tri_size(tw, th, true),
        ShapeKind::SlRect => ShapeSize {
            w: tw + 2.0 * PAD_X,
            h: th + 2.0 * PAD_Y + 10.0,
            dy: 5.0,
        },
        ShapeKind::NotchPent => ShapeSize {
            w: tw + 2.0 * PAD_X,
            h: th + 2.0 * PAD_Y,
            dy: 0.0,
        },
        ShapeKind::Hourglass => ShapeSize { w: 32.0, h: 40.0, dy: 0.0 },
        ShapeKind::HCyl => {
            let h = th + 2.0 * PAD_Y;
            let rx = (h / 4.0).min(12.0);
            ShapeSize {
                w: tw + 2.0 * PAD_X + 2.0 * rx,
                h,
                dy: 0.0,
            }
        }
        ShapeKind::CrossCirc => ShapeSize { w: 44.0, h: 44.0, dy: 0.0 },
        ShapeKind::StRect => ShapeSize {
            w: tw + 2.0 * PAD_X + 8.0,
            h: th + 2.0 * PAD_Y + 8.0,
            dy: 4.0,
        },
        ShapeKind::Doc | ShapeKind::TagDoc => ShapeSize {
            w: tw + 2.0 * PAD_X,
            h: th + 2.0 * PAD_Y + 10.0,
            dy: -5.0,
        },
        ShapeKind::Flag => ShapeSize {
            w: tw + 2.0 * PAD_X,
            h: th + 2.0 * PAD_Y + 16.0,
            dy: 0.0,
        },
        ShapeKind::Folder => ShapeSize {
            w: (tw + 2.0 * PAD_X).max(64.0),
            h: th + 2.0 * PAD_Y + 8.0,
            dy: 4.0,
        },
        ShapeKind::Bucket => ShapeSize {
            w: tw + 2.0 * PAD_X + 20.0,
            h: th + 2.0 * PAD_Y + 10.0,
            dy: 3.0,
        },
        ShapeKind::Console | ShapeKind::Browser => ShapeSize {
            w: (tw + 2.0 * PAD_X).max(72.0),
            h: th + 2.0 * PAD_Y + 12.0,
            dy: 6.0,
        },
        ShapeKind::Person => ShapeSize {
            w: (tw + 2.0 * PAD_X).max(56.0),
            h: th + 2.0 * PAD_Y + 26.0,
            dy: 13.0,
        },
        ShapeKind::Bang => ShapeSize {
            w: tw + 2.0 * PAD_X + 28.0,
            h: th + 2.0 * PAD_Y + 24.0,
            dy: 0.0,
        },
        ShapeKind::Cloud => ShapeSize {
            w: tw + 2.0 * PAD_X + 32.0,
            h: th + 2.0 * PAD_Y + 24.0,
            dy: 0.0,
        },
        ShapeKind::Brace | ShapeKind::BraceR => ShapeSize {
            w: tw + 2.0 * PAD_X + 12.0,
            h: th + 2.0 * PAD_Y,
            dy: 0.0,
        },
        ShapeKind::Braces => ShapeSize {
            w: tw + 2.0 * PAD_X + 24.0,
            h: th + 2.0 * PAD_Y,
            dy: 0.0,
        },
        ShapeKind::Bolt => ShapeSize { w: 36.0, h: 56.0, dy: 0.0 },
        ShapeKind::LinCyl => {
            let w = (tw + 2.0 * PAD_X).max(56.0);
            let ry = (w / 14.0).clamp(6.0, 12.0);
            ShapeSize {
                w,
                h: th + 2.0 * PAD_Y + 2.0 * ry + 8.0,
                dy: ry / 2.0 + 4.0,
            }
        }
        ShapeKind::CurvTrap => {
            let h = th + 2.0 * PAD_Y;
            ShapeSize {
                w: tw + 2.0 * PAD_X + h * 0.6,
                h,
                dy: 0.0,
            }
        }
        ShapeKind::Docs => ShapeSize {
            w: tw + 2.0 * PAD_X + 8.0,
            h: th + 2.0 * PAD_Y + 18.0,
            dy: -1.0,
        },
        ShapeKind::BowRect => {
            let h = th + 2.0 * PAD_Y;
            ShapeSize {
                w: tw + 2.0 * PAD_X + h * 0.4,
                h,
                dy: 0.0,
            }
        }
        ShapeKind::LinDoc => ShapeSize {
            w: tw + 2.0 * PAD_X + 8.0,
            h: th + 2.0 * PAD_Y + 10.0,
            dy: -5.0,
        },
        ShapeKind::CollapsedGroup => ShapeSize {
            w: tw + 2.0 * PAD_X + 8.0,
            h: th + 2.0 * PAD_Y + 8.0,
            dy: -2.0,
        },
    }
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

pub fn shape_inset(shape: ShapeKind, w: f64, h: f64, side: i32, t: f64) -> f64 {
    match shape {
        ShapeKind::Stadium => {
            if (side & 1) != 0 {
                bulge(t, h / 2.0, h / 2.0)
            } else {
                0.0
            }
        }
        ShapeKind::Cyl | ShapeKind::LinCyl => cap_inset(w, side, t),
        ShapeKind::Circle | ShapeKind::DblCirc | ShapeKind::Ellipse | ShapeKind::SmCirc | ShapeKind::FCirc | ShapeKind::FrCirc | ShapeKind::CrossCirc => {
            round_inset(w, h, side, t)
        }
        ShapeKind::Diam => {
            if (side & 1) != 0 {
                (t.abs() * w) / h
            } else {
                (t.abs() * h) / w
            }
        }
        ShapeKind::Hex => {
            if (side & 1) != 0 {
                t.abs() / 2.0
            } else {
                0.0
            }
        }
        ShapeKind::Odd => {
            if side == 3 {
                h / 4.0
            } else {
                0.0
            }
        }
        ShapeKind::LeanR | ShapeKind::LeanL | ShapeKind::TrapB | ShapeKind::TrapT => {
            if (side & 1) != 0 {
                h / 8.0
            } else {
                0.0
            }
        }
        ShapeKind::Tri | ShapeKind::FlipTri | ShapeKind::Bolt => {
            if (side & 1) != 0 {
                w / 4.0
            } else {
                0.0
            }
        }
        ShapeKind::SlRect => {
            if side == 0 {
                5.0
            } else {
                0.0
            }
        }
        ShapeKind::Hourglass => {
            if (side & 1) != 0 {
                w / 2.0
            } else {
                0.0
            }
        }
        ShapeKind::Doc | ShapeKind::Docs | ShapeKind::TagDoc | ShapeKind::LinDoc => {
            if side == 2 {
                10.0
            } else {
                0.0
            }
        }
        ShapeKind::Flag => {
            if (side & 1) != 0 {
                0.0
            } else {
                8.0
            }
        }
        ShapeKind::Bucket => {
            if (side & 1) != 0 {
                h / 12.0
            } else {
                0.0
            }
        }
        ShapeKind::Bang => 3.0,
        ShapeKind::Cloud => {
            if (side & 1) != 0 {
                2.0
            } else {
                1.0
            }
        }
        ShapeKind::BowRect => {
            if side == 1 {
                h * 0.2
            } else {
                0.0
            }
        }
        ShapeKind::Rect
        | ShapeKind::Rounded
        | ShapeKind::FrRect
        | ShapeKind::Text
        | ShapeKind::Fork
        | ShapeKind::NotchRect
        | ShapeKind::LinRect
        | ShapeKind::DivRect
        | ShapeKind::WinPane
        | ShapeKind::NotchPent
        | ShapeKind::Delay
        | ShapeKind::HCyl
        | ShapeKind::StRect
        | ShapeKind::Datastore
        | ShapeKind::Folder
        | ShapeKind::Console
        | ShapeKind::Browser
        | ShapeKind::Person
        | ShapeKind::Brace
        | ShapeKind::BraceR
        | ShapeKind::Braces
        | ShapeKind::CurvTrap
        | ShapeKind::TagRect
        | ShapeKind::CollapsedGroup => 0.0,
    }
}

pub fn shape_span(shape: ShapeKind, w: f64, h: f64, sideways: bool) -> f64 {
    let flat = || (if sideways { h } else { w }) - 2.0 * CORNER;
    let raw = match shape {
        ShapeKind::Rect
        | ShapeKind::Rounded
        | ShapeKind::FrRect
        | ShapeKind::Text
        | ShapeKind::NotchRect
        | ShapeKind::LinRect
        | ShapeKind::DivRect
        | ShapeKind::WinPane
        | ShapeKind::NotchPent
        | ShapeKind::Datastore
        | ShapeKind::Console
        | ShapeKind::Browser
        | ShapeKind::TagRect => flat(),
        ShapeKind::Stadium => {
            if sideways {
                h * 0.6
            } else {
                w - h
            }
        }
        ShapeKind::Cyl => {
            if sideways {
                h - 2.0 * CORNER - 12.0
            } else {
                w * 0.6
            }
        }
        ShapeKind::LinCyl => {
            if sideways {
                h - 2.0 * CORNER - 20.0
            } else {
                w * 0.6
            }
        }
        ShapeKind::Circle
        | ShapeKind::DblCirc
        | ShapeKind::Ellipse
        | ShapeKind::Diam
        | ShapeKind::SmCirc
        | ShapeKind::FCirc
        | ShapeKind::FrCirc
        | ShapeKind::CrossCirc => (if sideways { h } else { w }) * 0.6,
        ShapeKind::Hex => {
            if sideways {
                h * 0.5
            } else {
                w - h / 2.0 - CORNER
            }
        }
        ShapeKind::Odd => {
            if sideways {
                0.0
            } else {
                w - 2.0 * CORNER
            }
        }
        ShapeKind::LeanR | ShapeKind::LeanL | ShapeKind::TrapB | ShapeKind::TrapT => {
            if sideways {
                0.0
            } else {
                w - h / 2.0 - 2.0 * CORNER
            }
        }
        ShapeKind::Fork => (if sideways { h } else { w }) - 8.0,
        ShapeKind::StRect => (if sideways { h } else { w }) - 2.0 * CORNER - 8.0,
        ShapeKind::Tri
        | ShapeKind::FlipTri
        | ShapeKind::SlRect
        | ShapeKind::Hourglass
        | ShapeKind::Delay
        | ShapeKind::HCyl
        | ShapeKind::Doc
        | ShapeKind::Flag
        | ShapeKind::Folder
        | ShapeKind::Bucket
        | ShapeKind::Person
        | ShapeKind::Bang
        | ShapeKind::Cloud
        | ShapeKind::Brace
        | ShapeKind::BraceR
        | ShapeKind::Braces
        | ShapeKind::Bolt
        | ShapeKind::CurvTrap
        | ShapeKind::Docs
        | ShapeKind::BowRect
        | ShapeKind::TagDoc
        | ShapeKind::LinDoc
        | ShapeKind::CollapsedGroup => 0.0,
    };
    raw.max(0.0)
}

pub const fn shape_has_label(shape: ShapeKind) -> bool {
    !matches!(
        shape,
        ShapeKind::SmCirc | ShapeKind::FCirc | ShapeKind::FrCirc | ShapeKind::Fork | ShapeKind::Hourglass | ShapeKind::CrossCirc | ShapeKind::Bolt
    )
}

pub const fn shape_filled(shape: ShapeKind) -> bool {
    !matches!(shape, ShapeKind::Text | ShapeKind::Brace | ShapeKind::BraceR | ShapeKind::Braces)
}

/// Side of a node's layout box that a route end lies on: 0 top, 1 right, 2 bottom, 3 left, -1 none.
pub fn end_side(route: &[f64], at: usize, c: &CNode) -> i32 {
    let dx = route[at] - c.x;
    let dy = route[at + 1] - c.y;
    if (dy.abs() - c.h / 2.0).abs() < 0.5 {
        return if dy < 0.0 { 0 } else { 2 };
    }
    if (dx.abs() - c.w / 2.0).abs() < 0.5 {
        return if dx < 0.0 { 3 } else { 1 };
    }
    -1
}

/// Moves a route end from a node's layout box onto the outline of its drawn shape.
pub fn inset_route(route: &mut [f64], at: usize, shape: ShapeKind, w: f64, h: f64, c: &CNode) {
    if c.is_group {
        return;
    }
    let side = end_side(route, at, c);
    if side == 0 || side == 2 {
        let amount = shape_inset(shape, w, h, side, route[at] - c.x) + (c.h - h) / 2.0;
        route[at + 1] += if side == 0 { amount } else { -amount };
    } else if side >= 0 {
        let amount = shape_inset(shape, w, h, side, route[at + 1] - c.y) + (c.w - w) / 2.0;
        route[at] += if side == 3 { amount } else { -amount };
    }
}
