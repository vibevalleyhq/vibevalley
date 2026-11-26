use std::cell::RefCell;
use std::path::{Path, PathBuf};

use gpui::App;
use objc2::{AnyThread, DefinedClass as _, MainThreadOnly, rc::Retained, runtime::AnyObject, sel};
use objc2_app_kit::{NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem};
use objc2_foundation::{MainThreadMarker, NSObject, NSSize, NSString};
use vibevalley_i18n::t;
pub use vibevalley_protocol::HostTrayPayload as Summary;
use vibevalley_protocol::home::{ReleaseChannel, current_channel};

enum TrayEvent {
    Open,
    Quit,
}

struct TrayTargetIvars {
    tx: flume::Sender<TrayEvent>,
}

objc2::define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TrayTargetIvars]
    struct TrayTarget;

    impl TrayTarget {
        #[unsafe(method(openApp:))]
        fn open_app(&self, _sender: Option<&AnyObject>) {
            let _ = self.ivars().tx.send(TrayEvent::Open);
        }

        #[unsafe(method(quitApp:))]
        fn quit_app(&self, _sender: Option<&AnyObject>) {
            let _ = self.ivars().tx.send(TrayEvent::Quit);
        }
    }
);

impl TrayTarget {
    fn new(mtm: MainThreadMarker, tx: flume::Sender<TrayEvent>) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(TrayTargetIvars { tx });
        unsafe { objc2::msg_send![super(this), init] }
    }
}

struct InstalledTray {
    item: Retained<NSStatusItem>,
    target: Retained<TrayTarget>,
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
    let Some(mtm) = MainThreadMarker::new() else { return };
    let channel = current_channel();
    let (tx, rx) = flume::unbounded();
    cx.spawn(async move |cx| {
        while let Ok(event) = rx.recv_async().await {
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
    let item = NSStatusBar::systemStatusBar().statusItemWithLength(-1.0);
    if let Some(button) = item.button(mtm) {
        let image = tray_icon_candidates(&crate::assets::assets_dir(), channel)
            .into_iter()
            .filter(|path| path.is_file())
            .find_map(|path| NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(&path.to_string_lossy())));
        if let Some(image) = image {
            image.setSize(NSSize::new(18.0, 18.0));
            button.setImage(Some(&image));
        } else {
            button.setTitle(&NSString::from_str(channel_app_name(channel)));
        }
    }
    let target = TrayTarget::new(mtm, tx);
    TRAY.with(|slot| {
        *slot.borrow_mut() = Some(InstalledTray {
            item,
            target,
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
    let Some(mtm) = MainThreadMarker::new() else { return };
    TRAY.with(|slot| {
        let borrow = slot.borrow();
        let Some(tray) = borrow.as_ref() else { return };
        if let Some(button) = tray.item.button(mtm) {
            let tooltip = format_tooltip(tray.channel, &tray.summary.title);
            button.setToolTip(Some(&NSString::from_str(&tooltip)));
        }
        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(channel_app_name(tray.channel)));
        menu.setAutoenablesItems(false);
        let header = channel_menu_header(tray.channel);
        if let Some(title) = header {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(title));
            row.setEnabled(false);
            menu.addItem(&row);
        }
        for line in tray.summary.lines.iter().take(12) {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(line));
            row.setEnabled(false);
            menu.addItem(&row);
        }
        if header.is_some() || !tray.summary.lines.is_empty() {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        for (key, action) in [("desktop.open", sel!(openApp:)), ("desktop.quit", sel!(quitApp:))] {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(&t(key, &[])));
            unsafe {
                row.setTarget(Some(&tray.target));
                row.setAction(Some(action));
            }
            menu.addItem(&row);
        }
        tray.item.setMenu(Some(&menu));
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
