//! Safe RAII wrapper around macOS `NSWorkspaceDidWakeNotification` and `Network.framework`
//! `nw_path_monitor` observers.

use std::ffi::{c_char, c_void};
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// System lifecycle events observed natively via `NSWorkspace` and `Network.framework`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemEvent {
    /// macOS woke from sleep (`NSWorkspaceDidWakeNotification`).
    Wake,
    /// Network interface or path status changed (`nw_path_monitor`).
    NetworkChanged { reachable: bool },
}

// SAFETY: Network.framework C symbols are part of macOS system frameworks.
#[link(name = "Network", kind = "framework")]
unsafe extern "C" {
    fn nw_path_monitor_create() -> *mut c_void;
    fn nw_path_monitor_set_update_handler(monitor: *mut c_void, handler: &block2::DynBlock<dyn Fn(*mut c_void)>);
    fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: *mut c_void);
    fn nw_path_monitor_start(monitor: *mut c_void);
    fn nw_path_monitor_cancel(monitor: *mut c_void);
    fn nw_path_get_status(path: *mut c_void) -> i32;
    fn nw_release(obj: *mut c_void);
}

// SAFETY: libdispatch queue lifecycle symbols are part of macOS libSystem.
unsafe extern "C" {
    fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> *mut c_void;
    fn dispatch_release(obj: *mut c_void);
}

const NW_PATH_STATUS_SATISFIED: i32 = 1;

/// RAII handle that keeps native macOS sleep/wake (`NSWorkspaceDidWakeNotification`)
/// and network-change (`nw_path_monitor`) observers registered until dropped.
pub struct SystemObserver {
    wake_token: *mut objc2::runtime::AnyObject,
    monitor: *mut c_void,
    queue: *mut c_void,
    _wake_block: block2::RcBlock<dyn Fn(NonNull<objc2_foundation::NSNotification>)>,
    _net_block: block2::RcBlock<dyn Fn(*mut c_void)>,
}

// SAFETY: `NSNotificationCenter::removeObserver`, `nw_path_monitor_cancel`, `nw_release`,
// and `dispatch_release` are thread-safe Apple APIs, and the observer pointers are never
// dereferenced concurrently outside `Drop`.
unsafe impl Send for SystemObserver {}

impl Drop for SystemObserver {
    fn drop(&mut self) {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWorkspace;

        if !self.wake_token.is_null() {
            // SAFETY: `wake_token` is a retained observer token returned by `addObserverForName`,
            // reclaimed exactly once here.
            unsafe {
                let token = Retained::from_raw(self.wake_token);
                if let Some(token) = token {
                    NSWorkspace::sharedWorkspace().notificationCenter().removeObserver(&token);
                }
            }
            self.wake_token = std::ptr::null_mut();
        }
        if !self.monitor.is_null() {
            // SAFETY: `monitor` was created by `nw_path_monitor_create` and owned exclusively here.
            unsafe {
                nw_path_monitor_cancel(self.monitor);
                nw_release(self.monitor);
            }
            self.monitor = std::ptr::null_mut();
        }
        if !self.queue.is_null() {
            // SAFETY: `queue` was created by `dispatch_queue_create` and owned exclusively here.
            unsafe {
                dispatch_release(self.queue);
            }
            self.queue = std::ptr::null_mut();
        }
    }
}

/// Registers native macOS sleep/wake (`NSWorkspaceDidWakeNotification`) and
/// network-path (`nw_path_monitor`) observers, invoking `on_event` on each event.
pub fn observe_system_events(on_event: impl Fn(SystemEvent) + Send + Sync + 'static) -> SystemObserver {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;

    let callback: Arc<dyn Fn(SystemEvent) + Send + Sync> = Arc::new(on_event);
    let wake_cb = callback.clone();
    let wake_block = RcBlock::new(move |_notif: NonNull<NSNotification>| {
        wake_cb(SystemEvent::Wake);
    });

    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: `wake_block` is a valid sendable Objective-C block and `NSWorkspaceDidWakeNotification`
    // is a static notification name from AppKit.
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceDidWakeNotification), None, None, &wake_block) };
    let wake_token = Retained::into_raw(token).cast::<objc2::runtime::AnyObject>();

    let initial_seen = Arc::new(AtomicBool::new(false));
    let net_cb = callback;
    let net_block = RcBlock::new(move |path: *mut c_void| {
        let status = if path.is_null() {
            0
        } else {
            // SAFETY: `nw_path_monitor` passes a valid `nw_path_t` for the duration of the callback.
            unsafe { nw_path_get_status(path) }
        };
        if !initial_seen.swap(true, Ordering::SeqCst) {
            return;
        }
        net_cb(SystemEvent::NetworkChanged {
            reachable: status == NW_PATH_STATUS_SATISFIED,
        });
    });

    // SAFETY: `nw_path_monitor_create` and `dispatch_queue_create` return retained OS objects
    // released in `SystemObserver::drop`.
    let (monitor, queue) = unsafe {
        let monitor = nw_path_monitor_create();
        let queue = dispatch_queue_create(c"dev.vibevalley.app.net-monitor".as_ptr(), std::ptr::null());
        if !monitor.is_null() && !queue.is_null() {
            nw_path_monitor_set_update_handler(monitor, &net_block);
            nw_path_monitor_set_queue(monitor, queue);
            nw_path_monitor_start(monitor);
        }
        (monitor, queue)
    };

    SystemObserver {
        wake_token,
        monitor,
        queue,
        _wake_block: wake_block,
        _net_block: net_block,
    }
}

#[cfg(test)]
pub fn post_synthetic_wake_notification() {
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};

    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: `NSWorkspaceDidWakeNotification` is a static AppKit notification name posted in unit tests.
    unsafe {
        center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
    }
}
