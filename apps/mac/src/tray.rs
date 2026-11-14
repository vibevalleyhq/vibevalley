use std::cell::RefCell;

use gpui_kit::App;
use objc2::{AnyThread, DefinedClass as _, MainThreadOnly, rc::Retained, runtime::AnyObject, sel};
use objc2_app_kit::{NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem};
use objc2_foundation::{MainThreadMarker, NSObject, NSSize, NSString};
use serde::Deserialize;
use vibevalley_i18n::t;

#[derive(Clone, Default, Deserialize)]
pub struct Summary {
    pub title: String,
    pub lines: Vec<String>,
}

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
    summary: Summary,
}

thread_local! { static TRAY: RefCell<Option<InstalledTray>> = const { RefCell::new(None) }; }

pub fn install(cx: &mut App) {
    let Some(mtm) = MainThreadMarker::new() else { return };
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
        let path = crate::pixel::assets_dir().join("pixel/app-sprout.png");
        if let Some(image) = NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(&path.to_string_lossy())) {
            image.setSize(NSSize::new(18.0, 18.0));
            button.setImage(Some(&image));
        } else {
            button.setTitle(&NSString::from_str("VibeValley"));
        }
    }
    let target = TrayTarget::new(mtm, tx);
    TRAY.with(|slot| {
        *slot.borrow_mut() = Some(InstalledTray {
            item,
            target,
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
            button.setToolTip(Some(&NSString::from_str(&tray.summary.title)));
        }
        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("VibeValley"));
        menu.setAutoenablesItems(false);
        for line in tray.summary.lines.iter().take(12) {
            let row = NSMenuItem::new(mtm);
            row.setTitle(&NSString::from_str(line));
            row.setEnabled(false);
            menu.addItem(&row);
        }
        if !tray.summary.lines.is_empty() {
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
