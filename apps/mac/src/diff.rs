//! The diff view, painted by GPUI: unified or side by side, word emphasis
//! from `DiffLine::emphasis`, and per-hunk stage / unstage / discard.

use std::collections::HashSet;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;

use gpui_kit::{
    AnyElement, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, FontWeight, HighlightStyle, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, PathBuilder, Render, StatefulInteractiveElement as _, Styled as _, StyledText, Window, canvas, div, point, px, uniform_list,
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
        hunks: usize,
        collapsed: bool,
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

fn file_display_name(f: &FileDiff) -> String {
    match (&f.old_path, &f.new_path) {
        (Some(old), Some(new)) if old != new => format!("{} → {}", old.display(), new.display()),
        (_, Some(new)) => new.to_string_lossy().into_owned(),
        (Some(old), None) => old.to_string_lossy().into_owned(),
        (None, None) => String::new(),
    }
}

/// Flattens files into display rows. Side by side, each run of removed
/// lines is paired line by line with the run of added lines after it.
#[cfg(test)]
pub fn rows(files: &[FileDiff], mode: Mode) -> Vec<Row> {
    rows_with_collapsed(files, mode, &HashSet::new())
}

fn rows_with_collapsed(files: &[FileDiff], mode: Mode, collapsed: &HashSet<usize>) -> Vec<Row> {
    let mut out = Vec::new();
    for (fi, f) in files.iter().enumerate() {
        let is_collapsed = collapsed.contains(&fi);
        out.push(Row::File {
            file: fi,
            name: file_display_name(f),
            added: f.added,
            removed: f.removed,
            change: f.change,
            binary: f.binary,
            hunks: f.hunks.len(),
            collapsed: is_collapsed,
        });
        if is_collapsed {
            continue;
        }
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
                            LineKind::Context => {
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
        DiffSpec::Uncommitted | DiffSpec::Commit { .. } | DiffSpec::Range { .. } => (false, false, false),
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
    collapsed: HashSet<usize>,
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
            collapsed: HashSet::new(),
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
                let len = result.as_ref().map_or(0, Vec::len);
                v.collapsed.retain(|&idx| idx < len);
                v.files = Some(result.map(Arc::new));
                v.rebuild();
                cx.notify();
            });
        })
        .detach();
    }

    fn rebuild(&mut self) {
        self.rows = Arc::new(match &self.files {
            Some(Ok(files)) => rows_with_collapsed(files, self.mode, &self.collapsed),
            _ => Vec::new(),
        });
    }

    fn set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.rebuild();
        cx.notify();
    }

    fn toggle_file(&mut self, file: usize, cx: &mut Context<Self>) {
        if !self.collapsed.remove(&file) {
            self.collapsed.insert(file);
        }
        self.rebuild();
        cx.notify();
    }

    fn all_expandable_collapsed(&self) -> bool {
        let Some(Ok(files)) = &self.files else {
            return false;
        };
        let mut any = false;
        for (i, f) in files.iter().enumerate() {
            if !f.hunks.is_empty() {
                any = true;
                if !self.collapsed.contains(&i) {
                    return false;
                }
            }
        }
        any
    }

    fn toggle_all_files(&mut self, cx: &mut Context<Self>) {
        let Some(Ok(files)) = &self.files else {
            return;
        };
        if self.all_expandable_collapsed() {
            self.collapsed.clear();
        } else {
            self.collapsed.clear();
            for (i, f) in files.iter().enumerate() {
                if !f.hunks.is_empty() {
                    self.collapsed.insert(i);
                }
            }
        }
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
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus.clone()
    }
}

fn transparent() -> Hsla {
    gpui_kit::hsla(0.0, 0.0, 0.0, 0.0)
}

fn chevron_icon(expanded: bool, color: Hsla) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let cx = f32::from(bounds.origin.x) + f32::from(bounds.size.width) * 0.5;
            let cy = f32::from(bounds.origin.y) + f32::from(bounds.size.height) * 0.5;
            let mut pb = PathBuilder::stroke(px(1.5));
            if expanded {
                pb.move_to(point(px(cx - 3.0), px(cy - 1.5)));
                pb.line_to(point(px(cx), px(cy + 2.0)));
                pb.line_to(point(px(cx + 3.0), px(cy - 1.5)));
            } else {
                pb.move_to(point(px(cx - 1.5), px(cy - 3.0)));
                pb.line_to(point(px(cx + 2.0), px(cy)));
                pb.line_to(point(px(cx - 1.5), px(cy + 3.0)));
            }
            if let Ok(path) = pb.build() {
                window.paint_path(path, color);
            }
        },
    )
    .size(px(12.0))
    .flex_none()
    .into_any_element()
}

fn change_badge(change: Change, c: &Palette) -> (&'static str, Hsla, Hsla) {
    let warn_bg = Hsla {
        a: if c.dark { 0.20 } else { 0.12 },
        ..c.warning
    };
    let info_bg = Hsla {
        a: if c.dark { 0.20 } else { 0.12 },
        ..c.info
    };
    match change {
        Change::Added | Change::Untracked => ("A", c.added_bg, c.success),
        Change::Modified | Change::TypeChanged => ("M", warn_bg, c.warning),
        Change::Deleted => ("D", c.removed_bg, c.danger),
        Change::Renamed => ("R", info_bg, c.info),
        Change::Copied => ("C", info_bg, c.info),
        Change::Conflicted => ("!", c.removed_bg, c.danger),
        Change::Unmodified | Change::Ignored => ("·", c.hover, c.muted),
    }
}

fn split_hunk_header(header: &str) -> (&str, &str) {
    if let Some(rest) = header.strip_prefix("@@")
        && let Some(end) = rest.find("@@")
    {
        let split_at = 2 + end + 2;
        return (&header[..split_at], header[split_at..].trim_start());
    }
    (header, "")
}

fn max_line_number(files: &[FileDiff]) -> u32 {
    files
        .iter()
        .flat_map(|f| f.hunks.iter())
        .flat_map(|h| h.lines.iter())
        .filter_map(|l| l.old_no.max(l.new_no))
        .max()
        .unwrap_or(1)
}

fn totals(files: &[FileDiff]) -> (u32, u32) {
    files
        .iter()
        .fold((0u32, 0u32), |(a, r), f| (a.saturating_add(f.added), r.saturating_add(f.removed)))
}

fn line_colors(kind: LineKind, c: &Palette) -> (Option<Hsla>, Hsla, &'static str, Hsla) {
    match kind {
        LineKind::Added => (Some(c.added_bg), c.added_emphasis, "+", c.success),
        LineKind::Removed => (Some(c.removed_bg), c.removed_emphasis, "−", c.danger),
        LineKind::NoNewline => (None, c.hover, "\\", c.faint),
        LineKind::Context => (None, c.hover, " ", c.faint),
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

fn gutter_number(no: Option<u32>, width: f32, tinted: bool, border_right: bool, c: &Palette) -> gpui_kit::Div {
    let mut cell = div()
        .w(px(width))
        .h_full()
        .flex_none()
        .pr(px(8.0))
        .flex()
        .items_center()
        .justify_end()
        .text_color(c.faint)
        .child(no.map(|n| n.to_string()).unwrap_or_default());
    if !tinted {
        cell = cell.bg(c.surface);
    }
    if border_right {
        cell = cell.border_r_1().border_color(c.border);
    }
    cell
}

fn side_cell(s: Option<&Side>, width: f32, c: &Palette) -> impl IntoElement {
    let (bg, emph, sign, sign_color) = s.map_or((None, c.hover, " ", c.faint), |s| line_colors(s.kind, c));
    let mut cell = div().flex_1().min_w_0().h_full().flex().flex_row().items_center().overflow_hidden();
    if let Some(bg) = bg {
        cell = cell.bg(bg);
    } else if s.is_none() {
        cell = cell.bg(c.surface);
    }
    let text_color = if s.is_some_and(|s| s.kind == LineKind::NoNewline) { c.faint } else { c.text };
    cell.child(gutter_number(s.and_then(|s| s.no), width, bg.is_some() || s.is_none(), true, c))
        .child(
            div()
                .w(px(20.0))
                .h_full()
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .font_weight(FontWeight::MEDIUM)
                .text_color(sign_color)
                .child(sign),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .h_full()
                .flex()
                .items_center()
                .pr(px(12.0))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_color(text_color)
                .child(s.map_or_else(|| StyledText::new(""), |s| styled(&s.text, &s.emphasis, emph))),
        )
}

fn state_card(title: &'static str, detail: String, danger: bool, colors: &Palette) -> AnyElement {
    let (bg, border, title_color) = if danger {
        (colors.removed_bg, Hsla { a: 0.35, ..colors.danger }, colors.danger)
    } else {
        (colors.surface, colors.border, colors.text)
    };
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .child(
            div()
                .max_w(px(420.0))
                .px(px(20.0))
                .py(px(16.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(border)
                .bg(bg)
                .flex()
                .flex_col()
                .items_center()
                .gap(px(5.0))
                .child(div().text_size(px(13.0)).font_weight(FontWeight::SEMIBOLD).text_color(title_color).child(title))
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(if danger { colors.text } else { colors.muted })
                        .child(detail),
                ),
        )
        .into_any_element()
}

impl Render for DiffView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui = Ui::get(cx);
        let colors = ui.colors.clone();
        let mono = ui.mono();
        let font_size = ui.settings.terminal_font_size;
        let line_height = (font_size * 1.7).round().max(22.0);
        let mode = self.mode;
        let stats = match &self.files {
            Some(Ok(files)) if !files.is_empty() => Some((files.len(), totals(files))),
            _ => None,
        };
        let multi_expandable = match &self.files {
            Some(Ok(files)) => files.len() > 1 && files.iter().any(|f| !f.hunks.is_empty()),
            _ => false,
        };
        let all_collapsed = self.all_expandable_collapsed();
        let segment = |id: &'static str, label: &'static str, active: bool| {
            let text_color = colors.text;
            let btn = div()
                .id(id)
                .h_full()
                .px(px(8.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.0))
                .cursor_pointer()
                .text_size(px(11.5))
                .font_weight(if active { FontWeight::MEDIUM } else { FontWeight::NORMAL })
                .child(label);
            if active {
                btn.bg(colors.elevated).text_color(colors.text)
            } else {
                btn.bg(transparent()).text_color(colors.muted).hover(move |s| s.text_color(text_color))
            }
        };
        let quiet_btn = |id: &'static str, label: &'static str| {
            let hover = colors.hover;
            let text = colors.text;
            div()
                .id(id)
                .h(px(24.0))
                .px(px(8.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.0))
                .cursor_pointer()
                .text_size(px(11.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(colors.muted)
                .hover(move |s| s.bg(hover).text_color(text))
                .child(label)
        };
        let toolbar = div()
            .h(px(34.0))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .px(px(12.0))
            .bg(colors.surface)
            .border_b_1()
            .border_color(colors.border)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex_none()
                            .h(px(20.0))
                            .px(px(7.0))
                            .flex()
                            .items_center()
                            .rounded(px(4.0))
                            .border_1()
                            .border_color(colors.border)
                            .bg(colors.elevated)
                            .text_size(px(11.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(colors.text)
                            .child(self.spec_label()),
                    )
                    .children(self.path.as_ref().map(|p| {
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .font_family(mono.clone())
                            .text_size(px(12.0))
                            .text_color(colors.muted)
                            .child(p.display().to_string())
                    }))
                    .children(stats.map(|(file_count, (added, removed))| {
                        div()
                            .flex_none()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(div().text_size(px(11.5)).text_color(colors.faint).child(if file_count == 1 {
                                "1 file".to_string()
                            } else {
                                format!("{file_count} files")
                            }))
                            .child(
                                div()
                                    .h(px(19.0))
                                    .px(px(5.0))
                                    .flex()
                                    .items_center()
                                    .rounded(px(4.0))
                                    .bg(if added > 0 { colors.added_bg } else { colors.hover })
                                    .font_family(mono.clone())
                                    .text_size(px(11.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(if added > 0 { colors.success } else { colors.faint })
                                    .child(format!("+{added}")),
                            )
                            .child(
                                div()
                                    .h(px(19.0))
                                    .px(px(5.0))
                                    .flex()
                                    .items_center()
                                    .rounded(px(4.0))
                                    .bg(if removed > 0 { colors.removed_bg } else { colors.hover })
                                    .font_family(mono.clone())
                                    .text_size(px(11.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(if removed > 0 { colors.danger } else { colors.faint })
                                    .child(format!("−{removed}")),
                            )
                    })),
            )
            .children(self.error.clone().map(|e| {
                div()
                    .max_w(px(260.0))
                    .h(px(22.0))
                    .px(px(7.0))
                    .flex()
                    .items_center()
                    .rounded(px(4.0))
                    .bg(colors.removed_bg)
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(11.5))
                    .text_color(colors.danger)
                    .child(e)
            }))
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .h(px(24.0))
                            .p(px(2.0))
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(2.0))
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .bg(colors.hover)
                            .child(segment("unified", "Unified", mode == Mode::Unified).on_click(cx.listener(|v, _, _, cx| v.set_mode(Mode::Unified, cx))))
                            .child(segment("split", "Split", mode == Mode::Split).on_click(cx.listener(|v, _, _, cx| v.set_mode(Mode::Split, cx)))),
                    )
                    .children(multi_expandable.then(|| {
                        quiet_btn("fold-all", if all_collapsed { "Expand all" } else { "Collapse all" })
                            .on_click(cx.listener(|v, _, _, cx| v.toggle_all_files(cx)))
                    }))
                    .child(quiet_btn("refresh", "Refresh").on_click(cx.listener(|v, _, _, cx| v.reload(cx)))),
            );
        let body: AnyElement = match &self.files {
            None => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(colors.muted)
                .text_size(px(12.5))
                .child("Loading diff…")
                .into_any_element(),
            Some(Err(e)) => state_card("Could not read diff", e.clone(), true, &colors),
            Some(Ok(files)) if files.is_empty() => state_card("No changes", "This diff target is clean.".into(), false, &colors),
            Some(Ok(files)) => {
                let rows = self.rows.clone();
                let (can_stage, can_unstage, can_discard) = hunk_actions(&self.spec);
                let entity = cx.entity();
                let busy = self.busy;
                let digits = max_line_number(files).max(1).to_string().len().max(3);
                let num_w = (digits as f32 * font_size * 0.64 + 16.0).ceil().max(40.0);
                let any_expandable = files.iter().any(|f| !f.hunks.is_empty());
                uniform_list("diff-rows", rows.len(), move |range, _, cx| {
                    let c = Ui::get(cx).colors.clone();
                    range
                        .map(|i| {
                            let base = div().h(px(line_height)).w_full().flex().flex_row().items_center();
                            match &rows[i] {
                                Row::File {
                                    file,
                                    name,
                                    added,
                                    removed,
                                    change,
                                    binary,
                                    hunks,
                                    collapsed,
                                } => {
                                    let file_idx = *file;
                                    let has_hunks = *hunks > 0;
                                    let (mark, badge_bg, badge_fg) = change_badge(*change, &c);
                                    let row_hover = c.hover;
                                    let mut row = div()
                                        .id(("diff-file", i))
                                        .h(px(line_height))
                                        .w_full()
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .px(px(10.0))
                                        .gap(px(8.0))
                                        .bg(c.surface)
                                        .border_b_1()
                                        .border_color(c.border);
                                    if i > 0 && !matches!(rows[i - 1], Row::File { .. }) {
                                        row = row.border_t_1();
                                    }
                                    if has_hunks {
                                        let entity = entity.clone();
                                        row = row.cursor_pointer().hover(move |s| s.bg(row_hover)).on_click(move |_, _, cx| {
                                            entity.update(cx, |v, cx| v.toggle_file(file_idx, cx));
                                        });
                                    }
                                    row.children(any_expandable.then(|| {
                                        let slot = div().w(px(14.0)).flex_none().flex().items_center().justify_center();
                                        if has_hunks {
                                            slot.child(chevron_icon(!collapsed, if *collapsed { c.muted } else { c.text }))
                                        } else {
                                            slot
                                        }
                                    }))
                                    .child(
                                        div()
                                            .size(px(16.0))
                                            .flex_none()
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .rounded(px(4.0))
                                            .bg(badge_bg)
                                            .text_size(px(10.5))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(badge_fg)
                                            .child(mark),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .overflow_hidden()
                                            .text_ellipsis()
                                            .whitespace_nowrap()
                                            .text_size(px(12.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(c.text)
                                            .child(name.clone()),
                                    )
                                    .children((*collapsed && has_hunks).then(|| {
                                        div().flex_none().text_size(px(11.0)).text_color(c.faint).child(if *hunks == 1 {
                                            "1 hunk".to_string()
                                        } else {
                                            format!("{hunks} hunks")
                                        })
                                    }))
                                    .children(binary.then(|| {
                                        div()
                                            .flex_none()
                                            .px(px(6.0))
                                            .rounded(px(4.0))
                                            .bg(c.hover)
                                            .text_size(px(10.5))
                                            .text_color(c.muted)
                                            .child("binary")
                                    }))
                                    .children((!binary).then(|| {
                                        div()
                                            .flex_none()
                                            .flex()
                                            .flex_row()
                                            .items_center()
                                            .gap(px(6.0))
                                            .child(
                                                div()
                                                    .min_w(px(36.0))
                                                    .flex()
                                                    .justify_end()
                                                    .text_size(px(11.5))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(if *added > 0 { c.success } else { c.faint })
                                                    .child(format!("+{added}")),
                                            )
                                            .child(
                                                div()
                                                    .min_w(px(36.0))
                                                    .flex()
                                                    .justify_end()
                                                    .text_size(px(11.5))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(if *removed > 0 { c.danger } else { c.faint })
                                                    .child(format!("−{removed}")),
                                            )
                                    }))
                                    .into_any_element()
                                }
                                Row::Hunk { file, hunk, header } => {
                                    let (file, hunk) = (*file, *hunk);
                                    let (range_part, context_part) = split_hunk_header(header);
                                    let hunk_bg = if c.dark { c.elevated } else { c.hover };
                                    let action = |id: &'static str, label: &'static str, op: HunkOp| {
                                        let entity = entity.clone();
                                        let (fg, hover_bg) = match op {
                                            HunkOp::Stage => (c.accent, c.added_bg),
                                            HunkOp::Unstage => (c.muted, c.hover),
                                            HunkOp::Discard => (c.danger, c.removed_bg),
                                        };
                                        div()
                                            .id((id, i))
                                            .h(px(18.0))
                                            .px(px(7.0))
                                            .flex_none()
                                            .flex()
                                            .items_center()
                                            .rounded(px(4.0))
                                            .border_1()
                                            .border_color(c.border)
                                            .bg(c.bg)
                                            .cursor_pointer()
                                            .text_size(px(11.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(if busy { c.faint } else { fg })
                                            .hover(move |s| s.bg(hover_bg))
                                            .child(label)
                                            .on_click(move |_, _, cx| {
                                                if !busy {
                                                    entity.update(cx, |v, cx| v.hunk_op(file, hunk, op, cx));
                                                }
                                            })
                                    };
                                    let mut row = base.px(px(10.0)).gap(px(6.0)).bg(hunk_bg).border_b_1().border_color(c.border);
                                    if hunk > 0 {
                                        row = row.border_t_1();
                                    }
                                    row.child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .flex()
                                            .flex_row()
                                            .items_center()
                                            .gap(px(8.0))
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .child(
                                                div()
                                                    .flex_none()
                                                    .text_size(px(11.5))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(c.info)
                                                    .child(range_part.to_string()),
                                            )
                                            .children((!context_part.is_empty()).then(|| {
                                                div()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .overflow_hidden()
                                                    .text_ellipsis()
                                                    .whitespace_nowrap()
                                                    .text_size(px(11.5))
                                                    .text_color(c.muted)
                                                    .child(context_part.to_string())
                                            })),
                                    )
                                    .children(can_stage.then(|| action("stage", "Stage hunk", HunkOp::Stage)))
                                    .children(can_unstage.then(|| action("unstage", "Unstage hunk", HunkOp::Unstage)))
                                    .children(can_discard.then(|| action("discard", "Discard hunk", HunkOp::Discard)))
                                    .into_any_element()
                                }
                                Row::Line { old_no, new_no, side } => {
                                    let (bg, emph, sign, sign_color) = line_colors(side.kind, &c);
                                    let text_color = if side.kind == LineKind::NoNewline { c.faint } else { c.text };
                                    let mut row = base
                                        .child(gutter_number(*old_no, num_w, bg.is_some(), false, &c))
                                        .child(gutter_number(*new_no, num_w, bg.is_some(), true, &c))
                                        .child(
                                            div()
                                                .w(px(22.0))
                                                .h_full()
                                                .flex_none()
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(sign_color)
                                                .child(sign),
                                        )
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .h_full()
                                                .flex()
                                                .items_center()
                                                .pr(px(14.0))
                                                .overflow_hidden()
                                                .whitespace_nowrap()
                                                .text_color(text_color)
                                                .child(styled(&side.text, &side.emphasis, emph)),
                                        );
                                    if let Some(bg) = bg {
                                        row = row.bg(bg);
                                    }
                                    row.into_any_element()
                                }
                                Row::Pair { left, right } => base
                                    .child(side_cell(left.as_ref(), num_w, &c))
                                    .child(div().w(px(1.0)).h_full().flex_none().bg(c.border))
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
    fn spec_label(&self) -> String {
        match &self.spec {
            DiffSpec::Unstaged => "Unstaged".to_string(),
            DiffSpec::Staged => "Staged".to_string(),
            DiffSpec::Uncommitted => "Uncommitted".to_string(),
            DiffSpec::Commit { id } => format!("Commit {}", &id[..id.len().min(10)]),
            DiffSpec::Range { from, to } => format!("{from}..{to}"),
        }
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
    fn collapsed_file_hides_hunks_and_lines() {
        let collapsed = HashSet::from([0]);
        let r = rows_with_collapsed(&[file()], Mode::Unified, &collapsed);
        assert_eq!(r.len(), 1);
        assert!(matches!(r[0], Row::File { collapsed: true, hunks: 1, .. }));
    }

    #[test]
    fn splits_hunk_header_into_range_and_context() {
        assert_eq!(split_hunk_header("@@ -1,3 +1,5 @@ fn render()"), ("@@ -1,3 +1,5 @@", "fn render()"));
        assert_eq!(split_hunk_header("@@ -1,3 +1,5 @@"), ("@@ -1,3 +1,5 @@", ""));
    }

    #[test]
    fn actions_follow_the_target() {
        assert_eq!(hunk_actions(&DiffSpec::Unstaged), (true, false, true));
        assert_eq!(hunk_actions(&DiffSpec::Staged), (false, true, false));
        assert_eq!(hunk_actions(&DiffSpec::Commit { id: "x".into() }), (false, false, false));
    }
}
