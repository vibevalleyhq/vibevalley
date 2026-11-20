//! The diff view, painted by GPUI: unified or side by side, word emphasis
//! from `DiffLine::emphasis`, and per-hunk stage / unstage / discard.

use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;

use gpui::{
    AnyElement, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, HighlightStyle, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, StatefulInteractiveElement as _, Styled as _, StyledText, Window, div, px, uniform_list,
};
use vibevalley_git::{Change, FileDiff, LineKind, Repo};
use vibevalley_workspace::DiffSpec;

use crate::theme::{Palette, Ui};

/// Emitted after a hunk was staged, unstaged or discarded.
pub struct DiffChanged;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Unified,
    Split,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Side {
    pub no: Option<u32>,
    pub kind: LineKind,
    pub text: String,
    pub emphasis: Vec<Range<usize>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    File {
        file: usize,
        name: String,
        added: u32,
        removed: u32,
        change: Change,
        binary: bool,
    },
    Hunk {
        file: usize,
        hunk: usize,
        header: String,
    },
    Line {
        old_no: Option<u32>,
        new_no: Option<u32>,
        side: Side,
    },
    Pair {
        left: Option<Side>,
        right: Option<Side>,
    },
}

fn side(line: &vibevalley_git::DiffLine, no: Option<u32>) -> Side {
    Side {
        no,
        kind: line.kind,
        text: line.text.clone(),
        emphasis: line.emphasis.clone(),
    }
}

/// Flattens files into display rows. Side by side, each run of removed
/// lines is paired line by line with the run of added lines after it.
pub fn rows(files: &[FileDiff], mode: Mode) -> Vec<Row> {
    let mut out = Vec::new();
    for (fi, f) in files.iter().enumerate() {
        let name = f
            .new_path
            .as_ref()
            .or(f.old_path.as_ref())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push(Row::File {
            file: fi,
            name,
            added: f.added,
            removed: f.removed,
            change: f.change,
            binary: f.binary,
        });
        for (hi, h) in f.hunks.iter().enumerate() {
            out.push(Row::Hunk {
                file: fi,
                hunk: hi,
                header: h.header.clone(),
            });
            match mode {
                Mode::Unified => {
                    for l in &h.lines {
                        out.push(Row::Line {
                            old_no: l.old_no,
                            new_no: l.new_no,
                            side: side(l, l.new_no.or(l.old_no)),
                        });
                    }
                }
                Mode::Split => {
                    let mut i = 0;
                    while i < h.lines.len() {
                        let l = &h.lines[i];
                        match l.kind {
                            LineKind::Removed | LineKind::Added => {
                                let mut removed = Vec::new();
                                while i < h.lines.len() && h.lines[i].kind == LineKind::Removed {
                                    removed.push(side(&h.lines[i], h.lines[i].old_no));
                                    i += 1;
                                }
                                let mut added = Vec::new();
                                while i < h.lines.len() && h.lines[i].kind == LineKind::Added {
                                    added.push(side(&h.lines[i], h.lines[i].new_no));
                                    i += 1;
                                }
                                let n = removed.len().max(added.len());
                                let mut removed = removed.into_iter();
                                let mut added = added.into_iter();
                                for _ in 0..n {
                                    out.push(Row::Pair {
                                        left: removed.next(),
                                        right: added.next(),
                                    });
                                }
                            }
                            LineKind::NoNewline => {
                                out.push(Row::Pair {
                                    left: None,
                                    right: Some(side(l, None)),
                                });
                                i += 1;
                            }
                            _ => {
                                out.push(Row::Pair {
                                    left: Some(side(l, l.old_no)),
                                    right: Some(side(l, l.new_no)),
                                });
                                i += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// Which hunk actions a diff target allows: (stage, unstage, discard).
pub fn hunk_actions(spec: &DiffSpec) -> (bool, bool, bool) {
    match spec {
        DiffSpec::Unstaged => (true, false, true),
        DiffSpec::Staged => (false, true, false),
        _ => (false, false, false),
    }
}

#[derive(Clone, Copy)]
enum HunkOp {
    Stage,
    Unstage,
    Discard,
}

pub struct DiffView {
    repo_root: PathBuf,
    spec: DiffSpec,
    path: Option<PathBuf>,
    files: Option<Result<Arc<Vec<FileDiff>>, String>>,
    rows: Arc<Vec<Row>>,
    mode: Mode,
    focus: FocusHandle,
    busy: bool,
    error: Option<String>,
}

impl DiffView {
    pub fn new(repo_root: PathBuf, spec: DiffSpec, path: Option<PathBuf>, cx: &mut Context<Self>) -> Self {
        let mut view = DiffView {
            repo_root,
            spec,
            path,
            files: None,
            rows: Arc::new(Vec::new()),
            mode: Mode::Unified,
            focus: cx.focus_handle(),
            busy: false,
            error: None,
        };
        view.reload(cx);
        view
    }

    pub fn summary(&self) -> String {
        match &self.files {
            None => "loading".into(),
            Some(Err(e)) => format!("error {e}"),
            Some(Ok(files)) => format!(
                "{} files, {} hunks, {} rows, mode {:?}",
                files.len(),
                files.iter().map(|f| f.hunks.len()).sum::<usize>(),
                self.rows.len(),
                self.mode
            ),
        }
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (root, target, path) = (self.repo_root.clone(), self.spec.to_target(), self.path.clone());
        let task = cx.background_spawn(async move {
            let repo = Repo::discover(&root).map_err(|e| e.to_string())?.ok_or("not a git repository")?;
            repo.diff(&target, path.as_deref()).map_err(|e| e.to_string())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |v, cx| {
                v.files = Some(result.map(Arc::new));
                v.rebuild();
                cx.notify();
            });
        })
        .detach();
    }

    fn rebuild(&mut self) {
        self.rows = Arc::new(match &self.files {
            Some(Ok(files)) => rows(files, self.mode),
            _ => Vec::new(),
        });
    }

    fn set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.rebuild();
        cx.notify();
    }

    fn hunk_op(&mut self, file: usize, hunk: usize, op: HunkOp, cx: &mut Context<Self>) {
        let Some(Ok(files)) = &self.files else { return };
        let (Some(f), root) = (files.get(file).cloned(), self.repo_root.clone()) else {
            return;
        };
        let Some(h) = f.hunks.get(hunk).cloned() else { return };
        self.busy = true;
        let task = cx.background_spawn(async move {
            let repo = Repo::discover(&root).map_err(|e| e.to_string())?.ok_or("not a git repository")?;
            match op {
                HunkOp::Stage => repo.stage_hunk(&f, &h),
                HunkOp::Unstage => repo.unstage_hunk(&f, &h),
                HunkOp::Discard => repo.discard_hunk(&f, &h),
            }
            .map_err(|e| e.to_string())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |v, cx| {
                v.busy = false;
                v.error = result.err();
                v.reload(cx);
                cx.emit(DiffChanged);
            });
        })
        .detach();
    }
}

impl EventEmitter<DiffChanged> for DiffView {}

impl Focusable for DiffView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

fn line_colors(kind: LineKind, c: &Palette) -> (Option<Hsla>, Hsla, &'static str) {
    match kind {
        LineKind::Added => (Some(c.added_bg), c.added_emphasis, "+"),
        LineKind::Removed => (Some(c.removed_bg), c.removed_emphasis, "-"),
        LineKind::NoNewline => (None, c.hover, "\\"),
        LineKind::Context => (None, c.hover, " "),
    }
}

fn styled(text: &str, emphasis: &[Range<usize>], color: Hsla) -> StyledText {
    let text = text.trim_end_matches('\n').to_string();
    let highlights: Vec<_> = emphasis
        .iter()
        .filter(|r| r.start < r.end && r.end <= text.len() && text.is_char_boundary(r.start) && text.is_char_boundary(r.end))
        .map(|r| {
            (
                r.clone(),
                HighlightStyle {
                    background_color: Some(color),
                    ..Default::default()
                },
            )
        })
        .collect();
    StyledText::new(text).with_highlights(highlights)
}

fn number(no: Option<u32>, width: f32, c: &Palette) -> impl IntoElement {
    div()
        .w(px(width))
        .flex_none()
        .pr(px(6.0))
        .flex()
        .justify_end()
        .text_color(c.faint)
        .child(no.map(|n| n.to_string()).unwrap_or_default())
}

fn side_cell(s: Option<&Side>, width: f32, c: &Palette) -> impl IntoElement {
    let (bg, emph, sign) = s.map_or((None, c.hover, " "), |s| line_colors(s.kind, c));
    let mut cell = div().flex_1().min_w_0().h_full().flex().flex_row().overflow_hidden();
    if let Some(bg) = bg {
        cell = cell.bg(bg);
    }
    if s.is_none() {
        cell = cell.bg(c.surface);
    }
    cell.child(number(s.and_then(|s| s.no), width, c))
        .child(div().w(px(14.0)).flex_none().text_color(c.muted).child(sign))
        .child(
            div()
                .whitespace_nowrap()
                .child(s.map_or_else(|| StyledText::new(""), |s| styled(&s.text, &s.emphasis, emph))),
        )
}

impl Render for DiffView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui = Ui::get(cx);
        let colors = ui.colors.clone();
        let mono = ui.mono();
        let font_size = ui.settings.terminal_font_size;
        let line_height = (font_size * 1.55).round();
        let mode = self.mode;
        let toggle = |id: &'static str, label: &'static str, on: bool| {
            div()
                .id(id)
                .h(px(22.0))
                .px(px(8.0))
                .flex()
                .items_center()
                .rounded(px(6.0))
                .text_size(px(12.0))
                .border_1()
                .border_color(colors.border)
                .when_on(on, colors.selected)
                .hover(|s| s.bg(colors.hover))
                .child(label)
        };
        let toolbar = div()
            .h(px(30.0))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .px(px(10.0))
            .bg(colors.surface)
            .border_b_1()
            .border_color(colors.border)
            .child(div().flex_1().text_size(px(12.0)).text_color(colors.muted).child(self.summary_line()))
            .children(self.error.clone().map(|e| div().text_size(px(12.0)).text_color(colors.danger).child(e)))
            .child(toggle("unified", "Unified", mode == Mode::Unified).on_click(cx.listener(|v, _, _, cx| v.set_mode(Mode::Unified, cx))))
            .child(toggle("split", "Side by side", mode == Mode::Split).on_click(cx.listener(|v, _, _, cx| v.set_mode(Mode::Split, cx))))
            .child(toggle("refresh", "Refresh", false).on_click(cx.listener(|v, _, _, cx| v.reload(cx))));
        let body: AnyElement = match &self.files {
            None => div().p(px(16.0)).text_color(colors.muted).child("Loading diff…").into_any_element(),
            Some(Err(e)) => div()
                .p(px(16.0))
                .text_color(colors.danger)
                .child(format!("Could not read the diff: {e}"))
                .into_any_element(),
            Some(Ok(files)) if files.is_empty() => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(colors.muted)
                .text_size(px(13.0))
                .child("No changes here.")
                .into_any_element(),
            Some(Ok(_)) => {
                let rows = self.rows.clone();
                let (can_stage, can_unstage, can_discard) = hunk_actions(&self.spec);
                let entity = cx.entity();
                let busy = self.busy;
                let num_w = font_size * 0.62 * 5.0 + 8.0;
                uniform_list("diff-rows", rows.len(), move |range, _, cx| {
                    let c = Ui::get(cx).colors.clone();
                    range
                        .map(|i| {
                            let base = div().h(px(line_height)).w_full().flex().flex_row().items_center();
                            match &rows[i] {
                                Row::File {
                                    name, added, removed, binary, ..
                                } => base
                                    .px(px(10.0))
                                    .gap(px(10.0))
                                    .bg(c.surface)
                                    .border_t_1()
                                    .border_color(c.border)
                                    .child(div().flex_1().text_color(c.text).child(name.clone()))
                                    .children(binary.then(|| div().text_color(c.muted).child("binary")))
                                    .child(div().text_color(c.success).child(format!("+{added}")))
                                    .child(div().text_color(c.danger).child(format!("-{removed}")))
                                    .into_any_element(),
                                Row::Hunk { file, hunk, header } => {
                                    let (file, hunk) = (*file, *hunk);
                                    let action = |id: &'static str, label: &'static str, op: HunkOp| {
                                        let entity = entity.clone();
                                        div()
                                            .id((id, i))
                                            .px(px(6.0))
                                            .rounded(px(4.0))
                                            .text_color(c.accent)
                                            .hover(|s| s.bg(c.hover))
                                            .child(label)
                                            .on_click(move |_, _, cx| {
                                                if !busy {
                                                    entity.update(cx, |v, cx| v.hunk_op(file, hunk, op, cx));
                                                }
                                            })
                                    };
                                    base.px(px(10.0))
                                        .gap(px(4.0))
                                        .bg(c.hover)
                                        .child(div().flex_1().text_color(c.muted).overflow_hidden().whitespace_nowrap().child(header.clone()))
                                        .children(can_stage.then(|| action("stage", "Stage hunk", HunkOp::Stage)))
                                        .children(can_unstage.then(|| action("unstage", "Unstage hunk", HunkOp::Unstage)))
                                        .children(can_discard.then(|| action("discard", "Discard hunk", HunkOp::Discard)))
                                        .into_any_element()
                                }
                                Row::Line { old_no, new_no, side } => {
                                    let (bg, emph, sign) = line_colors(side.kind, &c);
                                    let mut row = base
                                        .child(number(*old_no, num_w, &c))
                                        .child(number(*new_no, num_w, &c))
                                        .child(div().w(px(14.0)).flex_none().text_color(c.muted).child(sign))
                                        .child(div().whitespace_nowrap().child(styled(&side.text, &side.emphasis, emph)));
                                    if let Some(bg) = bg {
                                        row = row.bg(bg);
                                    }
                                    row.into_any_element()
                                }
                                Row::Pair { left, right } => base
                                    .child(side_cell(left.as_ref(), num_w, &c))
                                    .child(div().w(px(1.0)).h_full().bg(c.border))
                                    .child(side_cell(right.as_ref(), num_w, &c))
                                    .into_any_element(),
                            }
                        })
                        .collect()
                })
                .size_full()
                .font_family(mono)
                .text_size(px(font_size))
                .into_any_element()
            }
        };
        div()
            .id("diff")
            .track_focus(&self.focus)
            .key_context("DiffView")
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.bg)
            .text_color(colors.text)
            .child(toolbar)
            .child(div().flex_1().min_h_0().child(body))
    }
}

impl DiffView {
    fn summary_line(&self) -> String {
        let what = match &self.spec {
            DiffSpec::Unstaged => "Unstaged changes".to_string(),
            DiffSpec::Staged => "Staged changes".to_string(),
            DiffSpec::Uncommitted => "Uncommitted changes".to_string(),
            DiffSpec::Commit { id } => format!("Commit {}", &id[..id.len().min(10)]),
            DiffSpec::Range { from, to } => format!("{from}..{to}"),
        };
        match &self.path {
            Some(p) => format!("{what} · {}", p.display()),
            None => what,
        }
    }
}

trait WhenOn {
    fn when_on(self, on: bool, bg: Hsla) -> Self;
}

impl WhenOn for gpui::Stateful<gpui::Div> {
    fn when_on(self, on: bool, bg: Hsla) -> Self {
        if on { self.bg(bg) } else { self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_git::{DiffLine, Hunk};

    fn line(kind: LineKind, old: Option<u32>, new: Option<u32>, text: &str) -> DiffLine {
        DiffLine {
            kind,
            old_no: old,
            new_no: new,
            text: text.into(),
            emphasis: vec![],
        }
    }

    fn file() -> FileDiff {
        FileDiff {
            old_path: Some("a.rs".into()),
            new_path: Some("a.rs".into()),
            change: Change::Modified,
            binary: false,
            added: 3,
            removed: 1,
            hunks: vec![Hunk {
                header: "@@ -1,3 +1,5 @@".into(),
                old_start: 1,
                old_lines: 3,
                new_start: 1,
                new_lines: 5,
                lines: vec![
                    line(LineKind::Context, Some(1), Some(1), "a"),
                    line(LineKind::Removed, Some(2), None, "b"),
                    line(LineKind::Added, None, Some(2), "B"),
                    line(LineKind::Added, None, Some(3), "B2"),
                    line(LineKind::Added, None, Some(4), "B3"),
                    line(LineKind::Context, Some(3), Some(5), "c"),
                ],
            }],
        }
    }

    #[test]
    fn unified_has_one_row_per_line() {
        let r = rows(&[file()], Mode::Unified);
        assert_eq!(r.len(), 2 + 6);
        assert!(matches!(r[0], Row::File { added: 3, removed: 1, .. }));
        assert!(matches!(r[1], Row::Hunk { file: 0, hunk: 0, .. }));
    }

    #[test]
    fn split_pairs_removed_with_added() {
        let r = rows(&[file()], Mode::Split);
        // context, (b|B), (_|B2), (_|B3), context
        assert_eq!(r.len(), 2 + 5);
        let Row::Pair { left, right } = &r[3] else { panic!() };
        assert_eq!(left.as_ref().unwrap().text, "b");
        assert_eq!(left.as_ref().unwrap().no, Some(2));
        assert_eq!(right.as_ref().unwrap().text, "B");
        let Row::Pair { left, right } = &r[5] else { panic!() };
        assert!(left.is_none());
        assert_eq!(right.as_ref().unwrap().text, "B3");
        let Row::Pair { left, right } = &r[6] else { panic!() };
        assert_eq!((left.as_ref().unwrap().no, right.as_ref().unwrap().no), (Some(3), Some(5)));
    }

    #[test]
    fn actions_follow_the_target() {
        assert_eq!(hunk_actions(&DiffSpec::Unstaged), (true, false, true));
        assert_eq!(hunk_actions(&DiffSpec::Staged), (false, true, false));
        assert_eq!(hunk_actions(&DiffSpec::Commit { id: "x".into() }), (false, false, false));
    }
}
