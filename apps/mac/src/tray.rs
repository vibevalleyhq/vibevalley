use std::cell::RefCell;

use objc2::{AnyThread, MainThreadOnly, rc::Retained, sel};
use objc2_app_kit::{NSApplication, NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem};
use objc2_foundation::{MainThreadMarker, NSSize, NSString};
use serde::Deserialize;
use vibevalley_i18n::t;

#[derive(Deserialize)]
pub struct Summary {
    pub title: String,
    pub lines: Vec<String>,
}

thread_local! { static ITEM: RefCell<Option<Retained<NSStatusItem>>> = const { RefCell::new(None) }; }

pub fn install() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let item = NSStatusBar::systemStatusBar().statusItemWithLength(-1.0);
    if let Some(button) = item.button(mtm) {
        let path = crate::pixel::assets_dir().join("pixel/app-sprout.png");
        if let Some(image) = NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(&path.to_string_lossy())) {
            image.setSize(NSSize::new(18.0, 18.0));
            button.setImage(Some(&image));
        } else {
            button.setTitle(&NSString::from_str("VibeValley"));
        }
    }
    ITEM.with(|slot| *slot.borrow_mut() = Some(item));
    update(&Summary {
        title: String::new(),
        lines: vec![],
    });
}

pub fn update(summary: &Summary) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    ITEM.with(|slot| {
        let item = slot.borrow();
        let Some(item) = item.as_ref() else { return };
        if let Some(button) = item.button(mtm) {
            button.setToolTip(Some(&NSString::from_str(&summary.title)));
        }
        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("VibeValley"));
        menu.setAutoenablesItems(false);
        for line in summary.lines.iter().take(12) {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(line));
            row.setEnabled(false);
            menu.addItem(&row);
        }
        if !summary.lines.is_empty() {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        let app = NSApplication::sharedApplication(mtm);
        for (key, action) in [("desktop.open", sel!(arrangeInFront:)), ("desktop.quit", sel!(terminate:))] {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(&t(key, &[])));
            unsafe {
                row.setTarget(Some(&app));
                row.setAction(Some(action));
            }
            menu.addItem(&row);
        }
        item.setMenu(Some(&menu));
    });
}
