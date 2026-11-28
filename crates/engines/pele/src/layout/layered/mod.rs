// Layered (Sugiyama-style) layout of one flat graph. Ranks run down the y axis; callers
// rotate the result for other directions.

mod crossing;
mod pipeline;
mod ports;
mod position;
mod ranking;
mod routing;
mod types;

pub use pipeline::layered;
pub use ranking::{orient, rank};
pub use routing::ease;
pub use types::{Groups, Kind, LEdge, LNode, LayeredOptions, LayeredResult, ledge, lnode};
