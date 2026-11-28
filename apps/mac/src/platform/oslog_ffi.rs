//! Safe wrapper around macOS Unified Logging (`os_log`) C symbols.

use std::ffi::{CStr, c_char, c_void};

pub const OS_LOG_TYPE_DEFAULT: u8 = 0x00;
pub const OS_LOG_TYPE_INFO: u8 = 0x01;
pub const OS_LOG_TYPE_DEBUG: u8 = 0x02;
pub const OS_LOG_TYPE_ERROR: u8 = 0x10;

// SAFETY: `os_log_create`, `os_log_type_enabled`, `_os_log_internal`, and `__dso_handle`
// are standard macOS libSystem symbols.
unsafe extern "C" {
    static __dso_handle: u8;
    fn os_log_create(subsystem: *const c_char, category: *const c_char) -> *mut c_void;
    fn os_log_type_enabled(log: *mut c_void, log_type: u8) -> bool;
    fn _os_log_internal(dso: *const c_void, log: *mut c_void, log_type: u8, format: *const c_char, ...);
}

#[derive(Clone, Copy)]
pub struct OsLogHandle(*mut c_void);

// SAFETY: `os_log_t` objects returned by `os_log_create` are global, immutable, immortal,
// and documented by Apple to be safe for concurrent use across threads.
unsafe impl Send for OsLogHandle {}
// SAFETY: Same as `Send` — Apple's `os_log_t` handles are thread-safe for concurrent logging.
unsafe impl Sync for OsLogHandle {}

impl OsLogHandle {
    pub fn create(subsystem: &'static CStr, category: &'static CStr) -> Self {
        // SAFETY: Both `subsystem` and `category` are `'static` NUL-terminated C strings.
        Self(unsafe { os_log_create(subsystem.as_ptr(), category.as_ptr()) })
    }

    pub fn is_enabled(self, log_type: u8) -> bool {
        if self.0.is_null() {
            return false;
        }
        // SAFETY: `self.0` is a non-null immortal `os_log_t` returned by `os_log_create`.
        unsafe { os_log_type_enabled(self.0, log_type) }
    }

    pub fn emit_public(self, log_type: u8, message: &CStr) {
        if self.0.is_null() {
            return;
        }
        // SAFETY: `__dso_handle`, `self.0`, static format string `%{public}s`, and NUL-terminated
        // `message` are all valid pointers for the duration of `_os_log_internal`.
        unsafe {
            _os_log_internal(
                (&raw const __dso_handle).cast::<c_void>(),
                self.0,
                log_type,
                c"%{public}s".as_ptr(),
                message.as_ptr(),
            );
        }
    }
}
