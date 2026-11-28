//! Safe wrappers around macOS AppKit, CoreText, CoreFoundation, UserNotifications,
//! and process-startup environment mutation boundaries.

use std::ffi::{CStr, OsStr, c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// Sets an environment variable during single-threaded process startup before GPUI or
/// background worker threads are spawned.
pub fn set_startup_env(key: &str, value: impl AsRef<OsStr>) {
    // SAFETY: Invoked exclusively from `update::enter_bundle()` at the top of `main()`
    // before GPUI or any background thread exists.
    unsafe { std::env::set_var(key, value) };
}

/// Whether this application is currently active in the macOS foreground.
pub fn is_app_active() -> bool {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    NSApplication::sharedApplication(mtm).isActive()
}

/// True when the running process has a macOS `.app` bundle identifier.
/// `UNUserNotificationCenter::currentNotificationCenter()` throws an ObjC exception
/// if called from an unpackaged binary without a bundle identifier.
pub fn has_bundle_identifier() -> bool {
    use objc2_foundation::NSBundle;
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Delivers a native macOS notification via `UNUserNotificationCenter` without shelling out.
pub fn deliver_notification(title: &str, body: &str) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound, UNUserNotificationCenter,
    };

    if !has_bundle_identifier() {
        tracing::debug!(target: "vibevalley::host", %title, %body, "skipping UNUserNotificationCenter without bundle identifier");
        return Ok(());
    }

    let center = UNUserNotificationCenter::currentNotificationCenter();
    static AUTH_REQUESTED: OnceLock<()> = OnceLock::new();
    AUTH_REQUESTED.get_or_init(|| {
        let auth_block = RcBlock::new(|_granted: Bool, _err: *mut NSError| {});
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &auth_block);
    });

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));

    let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);

    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let completion = RcBlock::new(move |err: *mut NSError| {
        let result = if err.is_null() {
            Ok(())
        } else {
            // SAFETY: UserNotifications passes a valid `NSError` pointer when non-null for the duration of the callback.
            let desc = unsafe { &*err }.localizedDescription().to_string();
            Err(desc)
        };
        let _ = tx.send(result);
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(res) => res,
        Err(_) => Ok(()),
    }
}

#[cfg(target_os = "macos")]
pub fn system_font_family_names() -> Vec<String> {
    type CFArrayRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFIndex = isize;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    // SAFETY: CoreText framework C symbol available on macOS.
    #[link(name = "CoreText", kind = "framework")]
    unsafe extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
    }

    // SAFETY: CoreFoundation framework C symbols available on macOS.
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFArrayGetCount(the_array: CFArrayRef) -> CFIndex;
        fn CFArrayGetValueAtIndex(the_array: CFArrayRef, idx: CFIndex) -> *const c_void;
        fn CFStringGetLength(the_string: CFStringRef) -> CFIndex;
        fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
        fn CFStringGetCString(the_string: CFStringRef, buffer: *mut c_char, buffer_size: CFIndex, encoding: u32) -> u8;
        fn CFRelease(cf: *const c_void);
    }

    // SAFETY: CoreText's `CTFontManagerCopyAvailableFontFamilyNames` is thread-safe and returns a
    // retained `CFArray<CFString>` (or null). Each element is read into a UTF-8 buffer and the
    // array is released before returning.
    unsafe {
        let array = CTFontManagerCopyAvailableFontFamilyNames();
        if array.is_null() {
            return Vec::new();
        }
        let count = CFArrayGetCount(array);
        let mut names = Vec::with_capacity(count.max(0) as usize);
        for idx in 0..count {
            let item = CFArrayGetValueAtIndex(array, idx);
            if item.is_null() {
                continue;
            }
            let len = CFStringGetLength(item);
            let max_bytes = CFStringGetMaximumSizeForEncoding(len, K_CF_STRING_ENCODING_UTF8) + 1;
            if max_bytes <= 1 {
                continue;
            }
            let mut buf = vec![0u8; max_bytes as usize];
            if CFStringGetCString(item, buf.as_mut_ptr().cast::<c_char>(), max_bytes, K_CF_STRING_ENCODING_UTF8) != 0
                && let Ok(text) = CStr::from_ptr(buf.as_ptr().cast::<c_char>()).to_str()
            {
                names.push(text.to_string());
            }
        }
        CFRelease(array);
        names
    }
}

#[cfg(not(target_os = "macos"))]
pub fn system_font_family_names() -> Vec<String> {
    Vec::new()
}

/// Opens `path` in its default macOS app via `NSWorkspace`.
pub fn workspace_open_path(path: &Path) -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    let ns_path = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&ns_path);
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err(format!("NSWorkspace failed to open {}", path.display()))
    }
}

/// Reveals `path` in Finder via `NSWorkspace`.
pub fn workspace_reveal_path(path: &Path) {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSArray, NSString, NSURL};

    let ns_path = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&ns_path);
    let urls = NSArray::from_retained_slice(&[url]);
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
}

/// Looks up an installed macOS `.app` bundle path by bundle identifier via LaunchServices.
pub fn find_app_by_bundle_id(bundle_id: &str) -> Option<PathBuf> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;

    let ns_id = NSString::from_str(bundle_id);
    let url = NSWorkspace::sharedWorkspace().URLForApplicationWithBundleIdentifier(&ns_id)?;
    let path = PathBuf::from(url.path()?.to_string());
    path.exists().then_some(path)
}

/// Sets the macOS Dock / Command-Tab icon (when `icon_path` is provided) and activates the app.
pub fn set_app_icon_and_activate(icon_path: Option<&Path>) {
    use objc2::AnyThread as _;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSImage};
    use objc2_foundation::{MainThreadMarker, NSString};

    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    if let Some(path) = icon_path {
        let file = NSString::from_str(&path.to_string_lossy());
        if let Some(image) = NSImage::initWithContentsOfFile(NSImage::alloc(), &file) {
            // SAFETY: Called on the main thread (proven by `MainThreadMarker`) with a valid retained `NSImage`.
            unsafe {
                app.setApplicationIconImage(Some(&image));
            }
        }
    }
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
}

/// Returns macOS keyboard focus from an embedded native child view (such as a
/// `WKWebView`) back to GPUI's `contentView` when the user clicks a GPUI surface.
pub fn restore_window_first_responder() {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: Called on the main thread (proven by `MainThreadMarker`); each returned AppKit
    // pointer (`keyWindow`, `contentView`, `firstResponder`) is checked for null before sending messages.
    unsafe {
        let win: *mut AnyObject = msg_send![&*app, keyWindow];
        if win.is_null() {
            return;
        }
        let content: *mut AnyObject = msg_send![win, contentView];
        let first: *mut AnyObject = msg_send![win, firstResponder];
        if !content.is_null() && first != content {
            let _: bool = msg_send![win, makeFirstResponder: content];
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CfPrefValue {
    Unset,
    Int(i64),
    Other,
}

/// Reads a preference via the exact `CFPreferencesCopyAppValue` lookup
/// `gpui-fast-apple` uses for `AppleFontSmoothing`.
pub fn cf_app_pref(key: &str) -> CfPrefValue {
    use objc2_foundation::NSString;

    const K_CF_NUMBER_SINT64_TYPE: isize = 4;

    // SAFETY: CoreFoundation preference and number symbols are part of macOS system frameworks.
    unsafe extern "C" {
        static kCFPreferencesCurrentApplication: *const c_void;
        fn CFPreferencesCopyAppValue(key: *const c_void, application_id: *const c_void) -> *const c_void;
        fn CFGetTypeID(cf: *const c_void) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: *const c_void, the_type: isize, value_ptr: *mut c_void) -> bool;
        fn CFRelease(cf: *const c_void);
    }

    let ns_key = NSString::from_str(key);
    // SAFETY: `NSString` is toll-free bridged to `CFStringRef`, and any non-null retained
    // `CFPropertyListRef` returned by `CFPreferencesCopyAppValue` is released before returning.
    unsafe {
        let value = CFPreferencesCopyAppValue((&*ns_key as *const NSString).cast::<c_void>(), kCFPreferencesCurrentApplication);
        if value.is_null() {
            return CfPrefValue::Unset;
        }
        let result = if CFGetTypeID(value) == CFNumberGetTypeID() {
            let mut out = 0i64;
            if CFNumberGetValue(value, K_CF_NUMBER_SINT64_TYPE, (&raw mut out).cast::<c_void>()) {
                CfPrefValue::Int(out)
            } else {
                CfPrefValue::Other
            }
        } else {
            CfPrefValue::Other
        };
        CFRelease(value);
        result
    }
}

/// Registers an in-memory integer default in `NSRegistrationDomain` without touching disk plists.
pub fn register_default_int(key: &str, value: i64) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let ns_key = NSString::from_str(key);
    // SAFETY: `NSUserDefaults`, `NSNumber`, and `NSDictionary` are standard Foundation classes;
    // `registerDefaults:` is thread-safe and copies the transient dictionary.
    unsafe {
        let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let num: *mut AnyObject = msg_send![class!(NSNumber), numberWithLongLong: value];
        let dict: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: num, forKey: &*ns_key];
        let _: () = msg_send![defaults, registerDefaults: dict];
    }
}

#[cfg(test)]
pub fn with_volatile_argument_int(key: &str, value: i64, f: impl FnOnce()) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    // SAFETY: `NSArgumentDomain` is a static Foundation constant.
    unsafe extern "C" {
        static NSArgumentDomain: *const c_void;
    }

    let ns_key = NSString::from_str(key);
    // SAFETY: Test-only temporary mutation of `NSArgumentDomain` that restores the previous domain dictionary.
    unsafe {
        let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let prev: *mut AnyObject = msg_send![defaults, volatileDomainForName: NSArgumentDomain];
        let next: *mut AnyObject = if prev.is_null() {
            msg_send![class!(NSMutableDictionary), dictionary]
        } else {
            msg_send![class!(NSMutableDictionary), dictionaryWithDictionary: prev]
        };
        let num: *mut AnyObject = msg_send![class!(NSNumber), numberWithLongLong: value];
        let _: () = msg_send![next, setObject: num, forKey: &*ns_key];
        let _: () = msg_send![defaults, setVolatileDomain: next, forName: NSArgumentDomain];

        f();

        let restore: *mut AnyObject = if prev.is_null() { msg_send![class!(NSDictionary), dictionary] } else { prev };
        let _: () = msg_send![defaults, setVolatileDomain: restore, forName: NSArgumentDomain];
    }
}
