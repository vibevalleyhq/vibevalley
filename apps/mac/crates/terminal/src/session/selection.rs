//! Selection state bridging [`SelectionMode`] to `alacritty_terminal::selection`.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{Term, TermMode, viewport_to_point};

use crate::{Point, SelectionMode};

#[derive(Default)]
pub(crate) struct SelectionState {
    anchor: Option<GridPoint>,
    mode: Option<SelectionMode>,
    anchor_alt: bool,
}

impl SelectionState {
    fn clamp_viewport<T>(term: &Term<T>, at: Point) -> GridPoint {
        let cols = term.columns().saturating_sub(1);
        let rows = term.screen_lines().saturating_sub(1);
        let vp = GridPoint::new(usize::from(at.row).min(rows), Column(usize::from(at.col).min(cols)));
        viewport_to_point(term.grid().display_offset(), vp)
    }

    pub(crate) fn start<T>(&mut self, term: &mut Term<T>, at: Point, mode: SelectionMode) {
        let grid_pt = Self::clamp_viewport(term, at);
        self.anchor = Some(grid_pt);
        self.mode = Some(mode);
        self.anchor_alt = term.mode().contains(TermMode::ALT_SCREEN);

        match mode {
            SelectionMode::Cell => {
                // Cell selection starts visually only once extended.
                term.selection = None;
            }
            SelectionMode::Word => {
                term.selection = Some(Selection::new(SelectionType::Semantic, grid_pt, Side::Left));
            }
            SelectionMode::Line => {
                term.selection = Some(Selection::new(SelectionType::Lines, grid_pt, Side::Left));
            }
        }
    }

    pub(crate) fn extend<T>(&mut self, term: &mut Term<T>, at: Point) {
        let is_alt = term.mode().contains(TermMode::ALT_SCREEN);
        if is_alt != self.anchor_alt {
            self.clear(term);
            return;
        }
        let target = Self::clamp_viewport(term, at);
        match self.mode {
            None => {}
            Some(SelectionMode::Cell) => {
                let Some(anchor) = self.anchor else { return };
                let mut sel = Selection::new(SelectionType::Simple, anchor, Side::Left);
                sel.update(target, Side::Right);
                sel.include_all();
                term.selection = Some(sel);
            }
            Some(SelectionMode::Word) => {
                if let Some(sel) = term.selection.as_mut() {
                    sel.update(target, Side::Right);
                } else if let Some(anchor) = self.anchor {
                    let mut sel = Selection::new(SelectionType::Semantic, anchor, Side::Left);
                    sel.update(target, Side::Right);
                    term.selection = Some(sel);
                }
            }
            Some(SelectionMode::Line) => {
                if let Some(sel) = term.selection.as_mut() {
                    sel.update(target, Side::Right);
                } else if let Some(anchor) = self.anchor {
                    let mut sel = Selection::new(SelectionType::Lines, anchor, Side::Left);
                    sel.update(target, Side::Right);
                    term.selection = Some(sel);
                }
            }
        }
    }

    pub(crate) fn clear<T>(&mut self, term: &mut Term<T>) {
        self.anchor = None;
        self.mode = None;
        term.selection = None;
    }

    pub(crate) fn text<T>(&self, term: &Term<T>) -> Option<String> {
        let range = term.selection.as_ref()?.to_range(term)?;
        let text = term.bounds_to_string(range.start, range.end);
        (!text.is_empty()).then_some(text)
    }
}
