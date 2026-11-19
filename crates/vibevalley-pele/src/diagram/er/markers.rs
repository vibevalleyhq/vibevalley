use crate::svg::builder::num;

use super::types::Cardinality;

/// How far a marker reaches back along its line from the box it touches.
pub const MARKER_LENGTH: f64 = 18.0;

const BAR: f64 = 5.0;
const FOOT: f64 = 6.0;
const FOOT_LENGTH: f64 = 10.0;
const RING: f64 = 3.5;

/// Draws a crow's foot cardinality marker over the end of a line that meets a box at `(x, y)`
/// while travelling along the unit vector `(dx, dy)`.
pub fn er_marker(kind: Cardinality, x: f64, y: f64, dx: f64, dy: f64, hollow_fill: &str) -> String {
    let at = |back: f64, side: f64| -> String { format!("{},{}", num(x - dx * back - dy * side), num(y - dy * back + dx * side)) };
    let bar = |back: f64| -> String { format!("M{}L{}", at(back, -BAR), at(back, BAR)) };
    let foot = || -> String { format!("M{}L{}L{}", at(0.0, -FOOT), at(FOOT_LENGTH, 0.0), at(0.0, FOOT)) };
    let ring = |back: f64| -> String {
        format!(
            r#"<circle class="pele-marker" cx="{}" cy="{}" r="{}" fill="{hollow_fill}"/>"#,
            num(x - dx * back),
            num(y - dy * back),
            num(RING),
        )
    };
    let path = |d: String| -> String { format!(r#"<path class="pele-marker" d="{d}"/>"#) };

    match kind {
        Cardinality::OnlyOne => path(format!("{}{}", bar(6.0), bar(10.0))),
        Cardinality::ZeroOrOne => format!("{}{}", path(bar(6.0)), ring(13.5)),
        Cardinality::OneOrMore => path(format!("{}{}", foot(), bar(FOOT_LENGTH + 3.5))),
        Cardinality::ZeroOrMore => format!("{}{}", path(foot()), ring(FOOT_LENGTH + RING + 0.5)),
        Cardinality::MdParent => format!(
            r#"<path class="pele-marker" d="M{}L{}L{}L{}Z" fill="{hollow_fill}"/>"#,
            at(0.0, 0.0),
            at(6.0, 4.0),
            at(12.0, 0.0),
            at(6.0, -4.0),
        ),
    }
}
