mod crossings;
mod placement;
mod solver;
mod types;

pub use crossings::{RouteStyle, route_crossings, style_of};
pub use solver::compound_layout;
pub use types::{CEdge, CNode, CompoundResult, Dir, cedge, cnode, direction, inherit_crossed_directions, shift_layout};
