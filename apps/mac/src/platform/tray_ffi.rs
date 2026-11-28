//! Safe wrapper around macOS `NSStatusItem` / `NSMenu` Objective-C target-action bindings.

use std::path::PathBuf;

use objc2::{AnyThread, DefinedClass as _, MainThreadOnly, rc::Retained, runtime::AnyObject, sel};
use objc2_app_kit::{NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem};
use objc2_foundation::{MainThreadMarker, NSObject, NSSize, NSString};

pub enum TrayEvent {
    Open,
    Quit,
}

struct TrayTargetIvars {
    tx: tokio::sync::mpsc::UnboundedSender<TrayEvent>,
}

// SAFETY: `TrayTarget` subclasses `NSObject`, is restricted to the main thread via
// `MainThreadOnly`, and exposes two standard AppKit target-action selectors (`openApp:`, `quitApp:`).
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
    fn new(mtm: MainThreadMarker, tx: tokio::sync::mpsc::UnboundedSender<TrayEvent>) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(TrayTargetIvars { tx });
        // SAFETY: `super(this)` is a freshly allocated `NSObject` subclass initialized via `-[NSObject init]`.
        unsafe { objc2::msg_send![super(this), init] }
    }
}

pub struct NativeTray {
    item: Retained<NSStatusItem>,
    target: Retained<TrayTarget>,
}

impl NativeTray {
    pub fn install(icon_candidates: Vec<PathBuf>, fallback_title: &str, tx: tokio::sync::mpsc::UnboundedSender<TrayEvent>) -> Option<Self> {
        let mtm = MainThreadMarker::new()?;
        let item = NSStatusBar::systemStatusBar().statusItemWithLength(-1.0);
        if let Some(button) = item.button(mtm) {
            let image = icon_candidates
                .into_iter()
                .filter(|path| path.is_file())
                .find_map(|path| NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(&path.to_string_lossy())));
            if let Some(image) = image {
                image.setSize(NSSize::new(18.0, 18.0));
                button.setImage(Some(&image));
            } else {
                button.setTitle(&NSString::from_str(fallback_title));
            }
        }
        let target = TrayTarget::new(mtm, tx);
        Some(Self { item, target })
    }

    pub fn update_menu(&self, app_name: &str, tooltip: &str, header: Option<&str>, lines: &[String], open_label: &str, quit_label: &str) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        if let Some(button) = self.item.button(mtm) {
            button.setToolTip(Some(&NSString::from_str(tooltip)));
        }
        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(app_name));
        menu.setAutoenablesItems(false);
        if let Some(title) = header {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(title));
            row.setEnabled(false);
            menu.addItem(&row);
        }
        for line in lines.iter().take(12) {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(line));
            row.setEnabled(false);
            menu.addItem(&row);
        }
        if header.is_some() || !lines.is_empty() {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        for (label, action) in [(open_label, sel!(openApp:)), (quit_label, sel!(quitApp:))] {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(label));
            // SAFETY: `self.target` is retained by `NativeTray` for the entire lifetime of the status item,
            // and `action` is an `@selector` implemented by `TrayTarget` on the main thread.
            unsafe {
                row.setTarget(Some(&self.target));
                row.setAction(Some(action));
            }
            menu.addItem(&row);
        }
        self.item.setMenu(Some(&menu));
    }
}
