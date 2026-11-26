//! Live 3D Papertrails diorama view and launch splash screen.

pub mod frame;
pub mod opening;
pub mod phone;
pub mod scene;
pub mod view;

pub use opening::OpeningView;
pub use view::{DioramaEvent, DioramaView};
