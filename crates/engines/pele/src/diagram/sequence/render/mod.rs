mod assemble;
mod layout;
mod style;
mod timeline;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::tighten;

use super::db::SeqDb;

pub use style::{Numbering, is_line_message, number_messages};

pub fn render_sequence(db: &SeqDb, ctx: &RenderContext<'_>) -> Rendered {
    tighten(ctx.options, |tight| draw(db, ctx, tight, 0.0, true))
}

fn draw(db: &SeqDb, ctx: &RenderContext<'_>, tight: bool, hold: f64, by_need: bool) -> Rendered {
    let metrics = style::Metrics::from_context(db, ctx, tight);
    let numbering = number_messages(&db.messages, ctx.config.sequence.show_sequence_numbers);
    let mut horizontal = layout::layout_horizontal(db, ctx, &metrics, &numbering, hold, by_need);
    let mut inks = style::InkCache::new();
    let painted = timeline::paint_timeline(db, ctx, &metrics, &numbering, &mut horizontal, &mut inks);
    match assemble::finish_sequence(db, ctx, &metrics, horizontal, painted, &mut inks) {
        assemble::DrawOutcome::Done(rendered) => rendered,
        assemble::DrawOutcome::Retry(next_hold) => draw(db, ctx, tight, next_hold, false),
    }
}
