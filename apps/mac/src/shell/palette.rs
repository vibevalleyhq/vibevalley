use std::path::PathBuf;

use gpui::{App, AppContext as _, Context, Focusable, Window};
use serde_json::Map;
use vibevalley_files::SearchOptions;
use vibevalley_protocol::{BoardSlice, Issue, IssueStageKind, IssueStatus, SliceKind};
use vibevalley_workspace::Axis;

use crate::hosted::frames::{self, PaletteMode};
use crate::hosted::{Action, BridgeHub, HostedEvent, HostedView, Panel};
use crate::theme::{ThemeChoice, Ui};

use super::menus::shell_palette_commands;
use super::{Palette, Shell};

impl Shell {
    pub fn open_palette(&mut self, mode: PaletteMode, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlays.palette.is_none() {
            let dark = Ui::get(cx).colors.dark;
            let view = cx.new(|cx| HostedView::new("palette", Map::new(), dark, window, cx));
            let sub = cx.subscribe_in(&view, window, |this, _, event: &HostedEvent, window, cx| match event {
                HostedEvent::Action(a) => this.on_action(a.clone(), window, cx),
                HostedEvent::HostCall { op, reply } => this.host_call(op.clone(), reply.clone(), window, cx),
                HostedEvent::Ready => this.refresh_palette(cx),
            });
            self.overlays.palette = Some(Palette {
                view,
                open: true,
                mode,
                query: String::new(),
                seq: 0,
                _sub: sub,
            });
        }
        let p = self.overlays.palette.as_mut().expect("palette");
        if p.mode != mode {
            p.query.clear();
        }
        p.mode = mode;
        p.open = true;
        let handle = p.view.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        self.refresh_palette(cx);
        cx.notify();
    }

    pub fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Reclaim the command palette's QuickJS VM immediately when hidden.
        self.overlays.palette = None;
        if self.chrome.native_workspace {
            self.focus_active_pane(window, cx);
        } else if self.chrome.native_diorama.is_some() {
            window.focus(&self.focus, cx);
        } else {
            let handle = self.chrome.workbench.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
        cx.notify();
    }

    pub(super) fn refresh_palette(&mut self, cx: &mut Context<Self>) {
        let index = self
            .workspace
            .ws
            .active_id()
            .and_then(|id| self.workspace.projects.get(&id))
            .and_then(|pv| pv.index.clone());
        let Some(p) = &mut self.overlays.palette else { return };
        if !p.open || !p.view.read(cx).is_ready() {
            return;
        }
        p.seq += 1;
        let mode = p.mode;
        let query = p.query.clone();
        match mode {
            PaletteMode::Commands => {
                let frame = frames::palette(mode, &query, shell_palette_commands(), false, None);
                p.view.update(cx, |v, cx| v.push("palette", frame, cx));
            }
            PaletteMode::Files => {
                let Some(index) = index else {
                    let frame = frames::palette(mode, &query, Vec::new(), true, Some("Indexing files…"));
                    p.view.update(cx, |v, cx| v.push("palette", frame, cx));
                    return;
                };
                let seq = p.seq;
                Self::bg(
                    cx,
                    move || index.query(&query, 200),
                    move |s, matches, cx| {
                        let Some(p) = &s.overlays.palette else { return };
                        if p.seq != seq {
                            return;
                        }
                        let frame = frames::palette(PaletteMode::Files, &p.query, frames::file_matches(&matches), false, None);
                        p.view.update(cx, |v, cx| v.push("palette", frame, cx));
                    },
                );
            }
            PaletteMode::Search => self.run_search(false, false, cx),
        }
    }

    pub(super) fn run_search(&mut self, regex: bool, case_sensitive: bool, cx: &mut Context<Self>) {
        let root = self.workspace.ws.active().map(|p| p.root().to_path_buf());
        let (Some(p), Some(root)) = (&mut self.overlays.palette, root) else { return };
        if !p.open || !p.view.read(cx).is_ready() {
            return;
        }
        p.seq += 1;
        let seq = p.seq;
        let query = p.query.clone();
        if query.trim().is_empty() {
            let frame = frames::palette(PaletteMode::Search, &query, Vec::new(), false, Some("Type to search file contents."));
            p.view.update(cx, |v, cx| v.push("palette", frame, cx));
            return;
        }
        let loading = frames::palette(PaletteMode::Search, &query, Vec::new(), true, None);
        p.view.update(cx, |v, cx| v.push("palette", loading, cx));
        Self::bg(
            cx,
            move || {
                let opts = SearchOptions {
                    regex,
                    case_sensitive,
                    whole_word: false,
                    max_results: 500,
                };
                let mut hits = Vec::new();
                let result = vibevalley_files::search(&root, &query, &opts, &mut |hit| {
                    hits.push(hit);
                    hits.len() < 500
                });
                (root, hits, result.err().map(|e| e.to_string()))
            },
            move |s, (root, hits, error), cx| {
                let Some(p) = &s.overlays.palette else { return };
                if p.seq != seq {
                    return;
                }
                let note = error.or_else(|| hits.is_empty().then(|| "No matches.".to_string()));
                let frame = frames::palette(PaletteMode::Search, &p.query, frames::search_hits(&root, &hits), false, note.as_deref());
                p.view.update(cx, |v, cx| v.push("palette", frame, cx));
            },
        );
    }

    pub(super) fn palette_select(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if id == "palette.files" {
            self.open_palette(PaletteMode::Files, window, cx);
            return;
        }
        if id == "palette.search" {
            self.open_palette(PaletteMode::Search, window, cx);
            return;
        }
        if let Some(rel) = id.strip_prefix("file:") {
            if let Some(root) = self.workspace.ws.active().map(|p| p.root().to_path_buf()) {
                self.open_file(root.join(rel), None, window, cx);
            }
            self.close_palette(window, cx);
            return;
        }
        if let Some(rest) = id.strip_prefix("hit:")
            && let Some((path, line)) = rest.rsplit_once(':')
        {
            self.open_file(PathBuf::from(path), line.parse().ok(), window, cx);
            self.close_palette(window, cx);
            return;
        }
        if let Some(route) = id.strip_prefix("route:") {
            self.navigate_workbench(route, cx);
            self.close_palette(window, cx);
            return;
        }
        match id {
            "nav.issues" => self.navigate_workbench("/issues", cx),
            "nav.dashboard" => self.navigate_workbench("/dashboard", cx),
            "nav.dashboard.runs" | "nav.runs" => self.navigate_workbench("/dashboard/runs", cx),
            "nav.dashboard.retro" | "nav.retro" => self.navigate_workbench("/dashboard/retro", cx),
            "nav.chat" => self.navigate_workbench("/chat", cx),
            "nav.content" | "nav.library" => self.navigate_workbench("/library", cx),
            "nav.team" | "nav.agents" => self.navigate_workbench("/agents", cx),
            "nav.runtimes" => self.navigate_workbench("/runtimes", cx),
            "nav.repos" => self.navigate_workbench("/repos", cx),
            "nav.farm" => self.navigate_workbench("/farm", cx),
            "nav.workspace" => {
                self.show_workspace(cx);
                self.with_workspace_project(window, cx, |_, _, _, _| {});
            }
            "nav.settings" => self.navigate_workbench("/settings", cx),
            "issue.new" => self.navigate_workbench("/issues/new", cx),
            "issue.next_reviewable" => {
                let route = self.next_reviewable_issue_route(cx);
                self.navigate_workbench(&route, cx);
            }
            "terminal.new" => self.new_terminal(None, window, cx),
            "pane.split_right" => self.split(Axis::Horizontal, window, cx),
            "pane.split_down" => self.split(Axis::Vertical, window, cx),
            "pane.close" => self.close_active_tab(window, cx),
            "panel.files" | "panel.git" => {
                self.show_workspace(cx);
                self.with_workspace_project(window, cx, |_, _, _, _| {});
                self.chrome.panel = if id == "panel.git" { Panel::Git } else { Panel::Files };
                self.chrome.inspector_open = true;
                self.sync_inspector(window, cx);
                self.push_sidebar(cx);
                cx.notify();
            }
            "git.diff" => self.on_action(Action::OpenDiff { path: None, staged: false }, window, cx),
            "git.diff_staged" => self.on_action(Action::OpenDiff { path: None, staged: true }, window, cx),
            "project.add" => self.add_project(window, cx),
            "project.close" => {
                if let Some(id) = self.workspace.ws.active_id() {
                    self.close_project(id, cx);
                }
            }
            "sidebar.toggle" => self.toggle_sidebar(cx),
            "inspector.toggle" => self.toggle_inspector(cx),
            "font.increase" => self.adjust_font_size(1.0, cx),
            "font.decrease" => self.adjust_font_size(-1.0, cx),
            "font.reset" => self.reset_font_size(cx),
            "theme.dark" => self.set_theme(ThemeChoice::Dark, cx),
            "theme.light" => self.set_theme(ThemeChoice::Light, cx),
            "theme.system" => self.set_theme(ThemeChoice::System, cx),
            "theme.toggle" => self.toggle_theme(cx),
            other => eprintln!("unknown command {other}"),
        }
        self.close_palette(window, cx);
    }

    fn next_reviewable_issue_route(&self, cx: &App) -> String {
        let issues = cx
            .try_global::<BridgeHub>()
            .and_then(|hub| serde_json::from_value::<BoardSlice>(hub.0.server().slice_snapshot(SliceKind::Board)).ok())
            .map(|board| board.issues)
            .unwrap_or_default();
        match next_reviewable_issue_id(&issues, self.chrome.last_route.as_deref()) {
            Some(id) => format!("/issues/{id}"),
            None => "/issues".to_string(),
        }
    }
}

fn reviewable_tier(issue: &Issue) -> Option<u8> {
    match issue.status {
        IssueStatus::Done | IssueStatus::Canceled => return None,
        IssueStatus::Backlog | IssueStatus::Todo | IssueStatus::InProgress | IssueStatus::InReview => {}
    }
    match issue.stage.state {
        IssueStageKind::Reviewing => Some(if issue.parent.is_none() { 0 } else { 1 }),
        IssueStageKind::Asking => Some(2),
        IssueStageKind::Stuck => Some(3),
        IssueStageKind::Draft | IssueStageKind::Queued | IssueStageKind::Working => {
            (issue.status == IssueStatus::InReview).then_some(if issue.parent.is_none() { 0 } else { 1 })
        }
        IssueStageKind::Done | IssueStageKind::Canceled => None,
    }
}

pub(super) fn next_reviewable_issue_id(issues: &[Issue], current_route: Option<&str>) -> Option<String> {
    let mut candidates: Vec<(u8, i64, i64, &Issue)> = issues
        .iter()
        .filter_map(|issue| {
            let tier = reviewable_tier(issue)?;
            let since = issue.stage.since.unwrap_or(issue.created_at);
            Some((tier, since, issue.number, issue))
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by_key(|(tier, since, number, _)| (*tier, *since, *number));

    let current_slug = current_route
        .and_then(|route| route.strip_prefix("/issues/"))
        .map(|rest| rest.split(['?', '#']).next().unwrap_or_default())
        .filter(|slug| !slug.is_empty() && *slug != "new");

    if let Some(slug) = current_slug
        && let Some(idx) = candidates
            .iter()
            .position(|(_, _, _, issue)| issue.id == slug || issue.number.to_string() == slug)
    {
        let next = (idx + 1) % candidates.len();
        return Some(candidates[next].3.id.clone());
    }
    Some(candidates[0].3.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_protocol::HostPaletteItem;

    #[test]
    fn shell_palette_commands_include_dashboard_and_issue_actions() {
        let ids: Vec<String> = shell_palette_commands()
            .into_iter()
            .filter_map(|item| match item {
                HostPaletteItem::Command(cmd) => Some(cmd.id),
                _ => None,
            })
            .collect();
        for expected in [
            "nav.dashboard",
            "nav.dashboard.runs",
            "nav.dashboard.retro",
            "issue.new",
            "issue.next_reviewable",
        ] {
            assert!(ids.iter().any(|id| id == expected), "missing palette command {expected}");
        }
    }

    #[test]
    fn next_reviewable_issue_id_prioritizes_reviewing_then_waiting_and_cycles_from_current() {
        let mut working = Issue::new("i-work", 1, "Working", 100);
        working.status = IssueStatus::InProgress;
        working.stage.state = IssueStageKind::Working;

        let mut stuck = Issue::new("i-stuck", 2, "Stuck", 100);
        stuck.status = IssueStatus::InProgress;
        stuck.stage.state = IssueStageKind::Stuck;
        stuck.stage.since = Some(150);

        let mut asking = Issue::new("i-ask", 3, "Asking", 100);
        asking.status = IssueStatus::InProgress;
        asking.stage.state = IssueStageKind::Asking;
        asking.stage.since = Some(120);

        let mut review_old = Issue::new("i-rev-1", 4, "Review old", 100);
        review_old.status = IssueStatus::InReview;
        review_old.stage.state = IssueStageKind::Reviewing;
        review_old.stage.since = Some(200);

        let mut review_new = Issue::new("i-rev-2", 5, "Review new", 100);
        review_new.status = IssueStatus::InReview;
        review_new.stage.state = IssueStageKind::Reviewing;
        review_new.stage.since = Some(300);

        let mut done = Issue::new("i-done", 6, "Done", 100);
        done.status = IssueStatus::Done;
        done.stage.state = IssueStageKind::Reviewing;

        let issues = vec![working, stuck, asking, review_new, review_old, done];
        assert_eq!(next_reviewable_issue_id(&issues, Some("/dashboard")).as_deref(), Some("i-rev-1"));
        assert_eq!(next_reviewable_issue_id(&issues, Some("/issues/i-rev-1")).as_deref(), Some("i-rev-2"));
        assert_eq!(next_reviewable_issue_id(&issues, Some("/issues/5?scope=active")).as_deref(), Some("i-ask"));
        assert_eq!(next_reviewable_issue_id(&issues, Some("/issues/i-ask")).as_deref(), Some("i-stuck"));
        assert_eq!(next_reviewable_issue_id(&issues, Some("/issues/i-stuck")).as_deref(), Some("i-rev-1"));
        assert_eq!(next_reviewable_issue_id(&issues[..1], None), None);
    }
}
