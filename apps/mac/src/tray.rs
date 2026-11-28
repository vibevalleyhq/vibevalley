#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use gpui::App;
use vibevalley_i18n::t;
pub use vibevalley_protocol::HostTrayPayload as Summary;
use vibevalley_protocol::home::{ReleaseChannel, current_channel};

use crate::platform::tray_ffi::{NativeTray, TrayEvent};

struct InstalledTray {
    native: NativeTray,
    channel: ReleaseChannel,
    summary: Summary,
}

thread_local! { static TRAY: RefCell<Option<InstalledTray>> = const { RefCell::new(None) }; }

const FALLBACK_ICON_REL: &str = "brand/tray-release.png";

const fn channel_icon_rel(channel: ReleaseChannel) -> &'static str {
    match channel {
        ReleaseChannel::Release => FALLBACK_ICON_REL,
        ReleaseChannel::Beta => "brand/tray-beta.png",
        ReleaseChannel::Alpha => "brand/tray-alpha.png",
        ReleaseChannel::Dev => "brand/tray-dev.png",
    }
}

fn tray_icon_candidates(assets_dir: &Path, channel: ReleaseChannel) -> Vec<PathBuf> {
    let primary = assets_dir.join(channel_icon_rel(channel));
    let fallback = assets_dir.join(FALLBACK_ICON_REL);
    if primary == fallback { vec![fallback] } else { vec![primary, fallback] }
}

const fn channel_app_name(channel: ReleaseChannel) -> &'static str {
    match channel {
        ReleaseChannel::Release => "VibeValley",
        ReleaseChannel::Beta => "VibeValley Beta",
        ReleaseChannel::Alpha => "VibeValley Alpha",
        ReleaseChannel::Dev => "VibeValley Dev",
    }
}

const fn channel_menu_header(channel: ReleaseChannel) -> Option<&'static str> {
    match channel {
        ReleaseChannel::Release => None,
        ReleaseChannel::Beta | ReleaseChannel::Alpha | ReleaseChannel::Dev => Some(channel_app_name(channel)),
    }
}

fn format_tooltip(channel: ReleaseChannel, summary_title: &str) -> String {
    let trimmed = summary_title.trim();
    match channel {
        ReleaseChannel::Release => trimmed.to_string(),
        ReleaseChannel::Beta | ReleaseChannel::Alpha | ReleaseChannel::Dev => {
            let prefix = channel_app_name(channel);
            if trimmed.is_empty() {
                prefix.to_string()
            } else if trimmed.starts_with(prefix) {
                trimmed.to_string()
            } else {
                format!("{prefix} — {trimmed}")
            }
        }
    }
}

pub fn install(cx: &mut App) {
    let channel = current_channel();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let Some(native) = NativeTray::install(tray_icon_candidates(&crate::assets::assets_dir(), channel), channel_app_name(channel), tx) else {
        return;
    };
    cx.spawn(async move |cx| {
        while let Some(event) = rx.recv().await {
            cx.update(|cx| match event {
                TrayEvent::Open => {
                    crate::ensure_main_window(cx);
                    cx.activate(true);
                }
                TrayEvent::Quit => cx.quit(),
            });
        }
    })
    .detach();
    TRAY.with(|slot| {
        *slot.borrow_mut() = Some(InstalledTray {
            native,
            channel,
            summary: Summary::default(),
        });
    });
    refresh();
}

pub fn update(summary: &Summary) {
    TRAY.with(|slot| {
        if let Some(tray) = slot.borrow_mut().as_mut() {
            tray.summary = summary.clone();
        }
    });
    refresh();
}

pub fn refresh() {
    TRAY.with(|slot| {
        let borrow = slot.borrow();
        let Some(tray) = borrow.as_ref() else { return };
        let tooltip = format_tooltip(tray.channel, &tray.summary.title);
        tray.native.update_menu(
            channel_app_name(tray.channel),
            &tooltip,
            channel_menu_header(tray.channel),
            &tray.summary.lines,
            &t("desktop.open", &[]),
            &t("desktop.quit", &[]),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_icon_candidates_pick_channel_brand_icon_with_release_fallback() {
        let assets = Path::new("/repo/assets");
        assert_eq!(
            tray_icon_candidates(assets, ReleaseChannel::Release),
            vec![PathBuf::from("/repo/assets/brand/tray-release.png")]
        );
        assert_eq!(
            tray_icon_candidates(assets, ReleaseChannel::Beta),
            vec![
                PathBuf::from("/repo/assets/brand/tray-beta.png"),
                PathBuf::from("/repo/assets/brand/tray-release.png"),
            ]
        );
        assert_eq!(
            tray_icon_candidates(assets, ReleaseChannel::Alpha),
            vec![
                PathBuf::from("/repo/assets/brand/tray-alpha.png"),
                PathBuf::from("/repo/assets/brand/tray-release.png"),
            ]
        );
        assert_eq!(
            tray_icon_candidates(assets, ReleaseChannel::Dev),
            vec![
                PathBuf::from("/repo/assets/brand/tray-dev.png"),
                PathBuf::from("/repo/assets/brand/tray-release.png"),
            ]
        );
    }

    #[test]
    fn tooltip_and_menu_header_prefix_non_release_channels() {
        assert_eq!(channel_app_name(ReleaseChannel::Release), "VibeValley");
        assert_eq!(channel_app_name(ReleaseChannel::Beta), "VibeValley Beta");
        assert_eq!(channel_app_name(ReleaseChannel::Alpha), "VibeValley Alpha");
        assert_eq!(channel_app_name(ReleaseChannel::Dev), "VibeValley Dev");

        assert_eq!(channel_menu_header(ReleaseChannel::Release), None);
        assert_eq!(channel_menu_header(ReleaseChannel::Beta), Some("VibeValley Beta"));
        assert_eq!(channel_menu_header(ReleaseChannel::Alpha), Some("VibeValley Alpha"));
        assert_eq!(channel_menu_header(ReleaseChannel::Dev), Some("VibeValley Dev"));

        assert_eq!(format_tooltip(ReleaseChannel::Release, ""), "");
        assert_eq!(format_tooltip(ReleaseChannel::Release, "2 · 1!"), "2 · 1!");
        assert_eq!(format_tooltip(ReleaseChannel::Beta, ""), "VibeValley Beta");
        assert_eq!(format_tooltip(ReleaseChannel::Beta, "2"), "VibeValley Beta — 2");
        assert_eq!(format_tooltip(ReleaseChannel::Alpha, " 1! "), "VibeValley Alpha — 1!");
        assert_eq!(format_tooltip(ReleaseChannel::Dev, ""), "VibeValley Dev");
        assert_eq!(format_tooltip(ReleaseChannel::Dev, "VibeValley Dev — 3"), "VibeValley Dev — 3");
    }
}
