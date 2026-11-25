//! Native GPUI startup failure overlay, live startup log viewer, and
//! safe SQLite database backup-and-reset recovery flow.

use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui::{
    AnyElement, ClipboardItem, Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, StatefulInteractiveElement as _, Styled as _,
    div, hsla, px,
};
use vibevalley_i18n::t;

use crate::hosted::{StartupFailure, StartupFailureKind};
use crate::theme::Ui;

use super::Shell;

#[derive(Debug, Default)]
pub struct StartupUiState {
    pub failure: Option<StartupFailure>,
    pub slow: bool,
    pub logs_open: bool,
    pub copied: bool,
    pub reset_armed: bool,
    pub reset_busy: bool,
    pub reset_notice: Option<String>,
}

impl StartupUiState {
    pub fn new(failure: Option<StartupFailure>) -> Self {
        Self { failure, ..Self::default() }
    }
}

fn next_backup_path(db_path: &Path, stamp: &str) -> PathBuf {
    let file_name = db_path.file_name().and_then(|n| n.to_str()).unwrap_or("server.db");
    let first = db_path.with_file_name(format!("{file_name}.bak-{stamp}"));
    if !first.exists() {
        return first;
    }
    for n in 2..=999 {
        let candidate = db_path.with_file_name(format!("{file_name}.bak-{stamp}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    db_path.with_file_name(format!("{file_name}.bak-{stamp}-{}", std::process::id()))
}

fn move_sidecar_if_present(db_path: &Path, backup_path: &Path, suffix: &str) -> Result<(), String> {
    let mut src_os = db_path.as_os_str().to_os_string();
    src_os.push(suffix);
    let src = PathBuf::from(src_os);
    if !src.exists() {
        return Ok(());
    }
    let mut dst_os = backup_path.as_os_str().to_os_string();
    dst_os.push(suffix);
    let dst = PathBuf::from(dst_os);
    std::fs::rename(&src, &dst).map_err(|e| format!("rename {}: {e}", src.display()))
}

/// Moves `db_path` (plus `-wal` and `-shm` sidecars) to a timestamped backup
/// next to it and clears a stale `server.json` if no server is alive on `home_dir`.
pub fn backup_sqlite_database(db_path: &Path, home_dir: &Path) -> Result<PathBuf, String> {
    if !db_path.exists() {
        return Err(format!("database file not found: {}", db_path.display()));
    }
    let now = jiff::ZonedDateTime::now();
    let stamp = now.strftime("%Y%m%d-%H%M%S").to_string();
    let backup_path = next_backup_path(db_path, &stamp);

    std::fs::rename(db_path, &backup_path).map_err(|e| format!("rename {}: {e}", db_path.display()))?;
    move_sidecar_if_present(db_path, &backup_path, "-wal")?;
    move_sidecar_if_present(db_path, &backup_path, "-shm")?;

    let server_file = home_dir.join(vibevalley_protocol::home::SERVER_FILE);
    if server_file.exists() && vibevalley_protocol::home::announced(home_dir).is_none() {
        let _ = std::fs::remove_file(server_file);
    }
    Ok(backup_path)
}

fn bundled_app_root_from(exe: Option<&Path>) -> Option<PathBuf> {
    let exe = exe?;
    let text = exe.to_str()?;
    let at = text.rfind(".app/Contents/MacOS/")?;
    Some(PathBuf::from(&text[..at + ".app".len()]))
}

async fn relaunch_bundled_app() -> Result<bool, String> {
    let exe = std::env::current_exe().ok();
    let Some(bundle) = bundled_app_root_from(exe.as_deref()) else {
        return Ok(false);
    };
    let status = tokio::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&bundle)
        .status()
        .await
        .map_err(|e| format!("launch {}: {e}", bundle.display()))?;
    if !status.success() {
        return Err(format!("open {} exited with {status}", bundle.display()));
    }
    Ok(true)
}

fn diagnostic_summary(failure: &StartupFailure) -> String {
    match failure.kind {
        StartupFailureKind::DatabaseSchema => match &failure.db_path {
            Some(path) => {
                let path_str = path.display().to_string();
                t("desktop.startup.schemaSummary", &[("path", path_str.as_str().into())])
            }
            None => t("desktop.startup.schemaSummaryNoPath", &[]),
        },
        _ => t("desktop.startup.genericSummary", &[("summary", failure.summary.as_str().into())]),
    }
}

fn action_button(
    id: &'static str,
    label: String,
    primary: bool,
    danger: bool,
    colors: &crate::theme::Palette,
    on_click: impl Fn(&mut Shell, &mut gpui::Window, &mut Context<Shell>) + 'static,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let (bg, border, text_color, hover_bg) = if danger {
        (colors.danger, colors.danger, colors.on_accent, colors.danger)
    } else if primary {
        (colors.accent, colors.accent, colors.on_accent, colors.accent)
    } else {
        (colors.surface, colors.border, colors.text, colors.hover)
    };

    div()
        .id(id)
        .cursor_pointer()
        .px(px(12.0))
        .py(px(6.0))
        .rounded(px(6.0))
        .bg(bg)
        .border_1()
        .border_color(border)
        .text_sm()
        .text_color(text_color)
        .hover(move |s| s.bg(hover_bg))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |shell, _, window, cx| {
                cx.stop_propagation();
                on_click(shell, window, cx);
            }),
        )
        .child(label)
        .into_any_element()
}

impl Shell {
    pub(super) fn copy_startup_diagnostics(&mut self, cx: &mut Context<Self>) {
        let report = crate::log::build_diagnostic_report(self.overlays.startup.failure.as_ref(), self.overlays.startup.reset_notice.as_deref());
        cx.write_to_clipboard(ClipboardItem::new_string(report));
        self.overlays.startup.copied = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let _ = this.update(cx, |shell, cx| {
                shell.overlays.startup.copied = false;
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn trigger_backup_and_reset(&mut self, cx: &mut Context<Self>) {
        if self.overlays.startup.reset_busy {
            return;
        }
        let Some(failure) = self.overlays.startup.failure.clone() else {
            return;
        };
        let Some(db_path) = failure.db_path.clone() else {
            return;
        };
        if !self.overlays.startup.reset_armed {
            self.overlays.startup.reset_armed = true;
            cx.notify();
            return;
        }

        self.overlays.startup.reset_busy = true;
        self.overlays.startup.reset_notice = None;
        cx.notify();

        let home_dir = failure.home_dir.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let backup_path = backup_sqlite_database(&db_path, &home_dir)?;
                    let relaunched = relaunch_bundled_app().await?;
                    Ok::<(PathBuf, bool), String>((backup_path, relaunched))
                })
                .await;

            let _ = this.update(cx, |shell, cx| {
                shell.overlays.startup.reset_busy = false;
                shell.overlays.startup.reset_armed = false;
                match result {
                    Ok((backup_path, true)) => {
                        tracing::info!(backup = %backup_path.display(), "backed up legacy database and relaunching");
                        cx.quit();
                    }
                    Ok((backup_path, false)) => {
                        let path_str = backup_path.display().to_string();
                        tracing::info!(backup = %path_str, "backed up legacy database; manual relaunch required");
                        shell.overlays.startup.reset_notice = Some(t("desktop.startup.backupDoneManual", &[("path", path_str.as_str().into())]));
                        cx.notify();
                    }
                    Err(err) => {
                        tracing::error!(error = %err, "database backup failed");
                        shell.overlays.startup.reset_notice = Some(t("desktop.startup.backupFailed", &[("error", err.as_str().into())]));
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    pub(super) fn render_slow_startup_pill(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.workspace.server_ready || self.overlays.startup.failure.is_some() || !self.overlays.startup.slow || self.overlays.startup.logs_open {
            return None;
        }
        let colors = Ui::get(cx).colors.clone();
        Some(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom(px(28.0))
                .flex()
                .flex_row()
                .justify_center()
                .child(
                    div()
                        .id("slow-startup-pill")
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .px(px(14.0))
                        .py(px(8.0))
                        .rounded(px(999.0))
                        .bg(colors.elevated)
                        .border_1()
                        .border_color(colors.warning)
                        .shadow_md()
                        .text_sm()
                        .text_color(colors.text)
                        .child(div().w(px(7.0)).h(px(7.0)).rounded(px(999.0)).bg(colors.warning))
                        .child(t("desktop.startup.slowHint", &[]))
                        .child(action_button(
                            "slow-startup-logs-btn",
                            t("desktop.startup.viewLogs", &[]),
                            false,
                            false,
                            &colors,
                            |shell, _, cx| {
                                shell.overlays.startup.logs_open = true;
                                cx.notify();
                            },
                            cx,
                        )),
                )
                .into_any_element(),
        )
    }

    pub(super) fn render_startup_diagnostics(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let failure = self.overlays.startup.failure.clone();
        if failure.is_none() && !self.overlays.startup.logs_open {
            return None;
        }
        let colors = Ui::get(cx).colors.clone();
        let mono = Ui::get(cx).mono();
        let channel = vibevalley_protocol::home::current_channel().as_str();
        let version = crate::update::bundle_version();
        let subtitle = t("desktop.startup.subtitle", &[("channel", channel.into()), ("version", version.as_str().into())]);

        let (title, badge_color, summary_text, detail_text, can_backup_reset, reveal_target) = match &failure {
            Some(fail) => {
                let is_schema = fail.kind == StartupFailureKind::DatabaseSchema;
                let title = if is_schema {
                    t("desktop.startup.titleSchema", &[])
                } else {
                    t("desktop.startup.titleFailed", &[])
                };
                let can_reset = is_schema && fail.db_path.is_some();
                let target = fail.db_path.clone().unwrap_or_else(|| fail.home_dir.clone());
                (title, colors.danger, Some(diagnostic_summary(fail)), fail.detail.clone(), can_reset, target)
            }
            None => (
                t("desktop.startup.titleLogs", &[]),
                colors.warning,
                None,
                None,
                false,
                crate::hosted::server_home(),
            ),
        };

        let log_lines = crate::log::recent_lines();
        let log_path = crate::log::log_file_path().display().to_string();
        let log_path_label = t("desktop.startup.logFileLabel", &[("path", log_path.as_str().into())]);

        let copy_label = if self.overlays.startup.copied {
            t("desktop.startup.copied", &[])
        } else {
            t("desktop.startup.copyReport", &[])
        };

        let mut actions = Vec::new();
        actions.push(action_button(
            "startup-copy-diagnostics",
            copy_label,
            true,
            false,
            &colors,
            |shell, _, cx| shell.copy_startup_diagnostics(cx),
            cx,
        ));
        let reveal_for_btn = reveal_target.clone();
        actions.push(action_button(
            "startup-open-folder",
            t("desktop.startup.openFolder", &[]),
            false,
            false,
            &colors,
            move |_, _, cx| {
                let path = reveal_for_btn.clone();
                Self::bg(cx, move || crate::host::reveal(&path), |_, _, _| {});
            },
            cx,
        ));
        if can_backup_reset {
            let reset_label = if self.overlays.startup.reset_busy {
                t("desktop.startup.backupBusy", &[])
            } else if self.overlays.startup.reset_armed {
                t("desktop.startup.backupConfirm", &[])
            } else {
                t("desktop.startup.backupReset", &[])
            };
            actions.push(action_button(
                "startup-backup-reset",
                reset_label,
                false,
                self.overlays.startup.reset_armed,
                &colors,
                |shell, _, cx| shell.trigger_backup_and_reset(cx),
                cx,
            ));
        }
        if failure.is_none() {
            actions.push(action_button(
                "startup-refresh-logs",
                t("desktop.startup.refreshLogs", &[]),
                false,
                false,
                &colors,
                |_, _, cx| cx.notify(),
                cx,
            ));
            actions.push(action_button(
                "startup-close-logs",
                t("desktop.startup.closeLogs", &[]),
                false,
                false,
                &colors,
                |shell, _, cx| {
                    shell.overlays.startup.logs_open = false;
                    cx.notify();
                },
                cx,
            ));
        }
        actions.push(action_button(
            "startup-quit",
            t("desktop.startup.quit", &[]),
            false,
            false,
            &colors,
            |_, _, cx| cx.quit(),
            cx,
        ));

        let mut body = div()
            .id("startup-log-scroll")
            .flex_1()
            .min_h(px(140.0))
            .max_h(px(340.0))
            .overflow_y_scroll()
            .p(px(12.0))
            .rounded(px(8.0))
            .bg(colors.bg)
            .border_1()
            .border_color(colors.border)
            .flex()
            .flex_col()
            .gap(px(10.0));

        if let Some(detail) = detail_text {
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(div().text_xs().text_color(colors.muted).child(t("desktop.startup.detailHeading", &[])))
                    .child(div().font_family(mono.clone()).text_xs().text_color(colors.text).child(detail)),
            );
        }

        let logs_block = if log_lines.is_empty() {
            div().text_xs().text_color(colors.muted).child(t("desktop.startup.emptyLogs", &[]))
        } else {
            let mut list = div().flex().flex_col().gap(px(2.0));
            for line in log_lines {
                list = list.child(div().font_family(mono.clone()).text_xs().text_color(colors.muted).child(line));
            }
            list
        };

        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(div().text_xs().text_color(colors.muted).child(t("desktop.startup.logsHeading", &[])))
                .child(logs_block),
        );

        let mut card = div()
            .id("startup-diagnostics-card")
            .w(px(720.0))
            .max_w(px(760.0))
            .max_h(px(620.0))
            .p(px(20.0))
            .rounded(px(12.0))
            .bg(colors.elevated)
            .border_1()
            .border_color(colors.border)
            .shadow_lg()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(10.0))
                            .child(div().w(px(10.0)).h(px(10.0)).rounded(px(999.0)).bg(badge_color))
                            .child(div().text_lg().text_color(colors.text).child(title)),
                    )
                    .child(div().font_family(mono.clone()).text_xs().text_color(colors.muted).child(subtitle)),
            );

        if let Some(summary) = summary_text {
            card = card.child(
                div()
                    .p(px(10.0))
                    .rounded(px(8.0))
                    .bg(colors.surface)
                    .border_1()
                    .border_color(badge_color)
                    .text_sm()
                    .text_color(colors.text)
                    .child(summary),
            );
        }

        if let Some(notice) = &self.overlays.startup.reset_notice {
            card = card.child(
                div()
                    .p(px(10.0))
                    .rounded(px(8.0))
                    .bg(colors.surface)
                    .border_1()
                    .border_color(colors.info)
                    .text_sm()
                    .text_color(colors.text)
                    .child(notice.clone()),
            );
        }

        card = card
            .child(body)
            .child(div().font_family(mono).text_xs().text_color(colors.muted).child(log_path_label))
            .child(div().flex().flex_row().flex_wrap().items_center().justify_end().gap(px(8.0)).children(actions));

        Some(
            div()
                .id("startup-diagnostics-scrim")
                .absolute()
                .inset_0()
                .bg(hsla(0.0, 0.0, 0.0, 0.58))
                .flex()
                .items_center()
                .justify_center()
                .p(px(24.0))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(card)
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_sqlite_database_moves_main_wal_shm_and_preserves_config() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let db = home.join("server.db");
        let wal = home.join("server.db-wal");
        let shm = home.join("server.db-shm");
        let cfg = home.join("config.json");
        let server_json = home.join("server.json");

        std::fs::write(&db, b"sqlite-main").unwrap();
        std::fs::write(&wal, b"sqlite-wal").unwrap();
        std::fs::write(&shm, b"sqlite-shm").unwrap();
        std::fs::write(&cfg, br#"{"ok":true}"#).unwrap();
        std::fs::write(&server_json, br#"{"url":"http://127.0.0.1:8789","pid":99999999}"#).unwrap();

        let backup = backup_sqlite_database(&db, home).unwrap();
        assert!(!db.exists());
        assert!(!wal.exists());
        assert!(!shm.exists());
        assert!(!server_json.exists(), "dead server.json should be cleaned up");
        assert!(cfg.exists(), "config.json must stay untouched");

        assert_eq!(std::fs::read(&backup).unwrap(), b"sqlite-main");
        let mut wal_bak = backup.as_os_str().to_os_string();
        wal_bak.push("-wal");
        assert_eq!(std::fs::read(PathBuf::from(wal_bak)).unwrap(), b"sqlite-wal");
        let mut shm_bak = backup.as_os_str().to_os_string();
        shm_bak.push("-shm");
        assert_eq!(std::fs::read(PathBuf::from(shm_bak)).unwrap(), b"sqlite-shm");
    }

    #[test]
    fn bundled_app_root_detects_macos_app_bundle_only() {
        assert_eq!(
            bundled_app_root_from(Some(Path::new("/Applications/VibeValley-Alpha.app/Contents/MacOS/vibevalley-mac"))),
            Some(PathBuf::from("/Applications/VibeValley-Alpha.app"))
        );
        assert_eq!(
            bundled_app_root_from(Some(Path::new("/Users/dev/vibevalley/target/debug/vibevalley-mac"))),
            None
        );
    }
}
