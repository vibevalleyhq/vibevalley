use crate::layout::compound::CNode;

use super::kind::ShapeKind;

pub const PAD_X: f64 = 18.0;
pub const PAD_Y: f64 = 12.0;
const CORNER: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShapeSize {
    pub w: f64,
    pub h: f64,
    pub dy: f64,
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
