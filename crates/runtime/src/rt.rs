//! Process-wide shared Tokio runtime for asynchronous I/O in VibeValley.

use std::future::Future;
use std::pin::pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll, Wake, Waker};
use std::thread::Thread;

use tokio::runtime::{Handle, Runtime, RuntimeFlavor};

fn resolve_io_workers(env_val: Option<&str>, available: Option<usize>) -> usize {
    if let Some(parsed) = env_val.and_then(|raw| raw.trim().parse::<usize>().ok()) {
        return parsed.clamp(1, 16);
    }
    available.map(|n| n.clamp(2, 4)).unwrap_or(4)
}

fn io_workers() -> usize {
    let env_val = std::env::var("VIBEVALLEY_IO_WORKERS").ok();
    let available = std::thread::available_parallelism().ok().map(std::num::NonZeroUsize::get);
    resolve_io_workers(env_val.as_deref(), available)
}

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let next = AtomicUsize::new(0);
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(io_workers())
            .enable_all()
            .thread_name_fn(move || {
                let n = next.fetch_add(1, Ordering::Relaxed);
                format!("vibevalley-io-{n}")
            })
            .build()
            .expect("shared vibevalley-io tokio runtime")
    })
}

pub fn handle() -> &'static Handle {
    runtime().handle()
}

pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(future)
}

struct ThreadWaker {
    thread: Thread,
    notified: AtomicBool,
}

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.notified.store(true, Ordering::Release);
        self.thread.unpark();
    }
}

fn block_on_park<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let signal = Arc::new(ThreadWaker {
        thread: std::thread::current(),
        notified: AtomicBool::new(false),
    });
    let waker = Waker::from(signal.clone());
    let mut cx = Context::from_waker(&waker);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(output) => return output,
            Poll::Pending => {
                while !signal.notified.swap(false, Ordering::Acquire) {
                    std::thread::park();
                }
            }
        }
    }
}

pub fn block_on<F: Future>(future: F) -> F::Output {
    match Handle::try_current() {
        Err(_) => handle().block_on(future),
        Ok(current) if current.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(|| handle().block_on(future)),
        // Current-thread runtimes panic on `block_in_place`; entering the shared runtime lets its workers drive Tokio I/O and timers.
        Ok(_) => {
            let _guard = handle().enter();
            block_on_park(future)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn spawn_runs_on_named_io_worker_and_block_on_handles_outer_and_nested_contexts() {
        let thread_name = block_on(async { spawn(async { std::thread::current().name().unwrap_or_default().to_string() }).await.unwrap() });
        assert!(thread_name.starts_with("vibevalley-io-"), "unexpected worker name: {thread_name}");

        let nested = block_on(async {
            spawn(async {
                block_on(async {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    42usize
                })
            })
            .await
            .unwrap()
        });
        assert_eq!(nested, 42);

        let current_thread_rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let from_current_thread = current_thread_rt.block_on(async {
            block_on(async {
                tokio::time::sleep(Duration::from_millis(1)).await;
                99usize
            })
        });
        assert_eq!(from_current_thread, 99);
    }

    #[test]
    fn io_worker_quota_respects_env_override_and_clamps_defaults() {
        assert_eq!(resolve_io_workers(None, None), 4);
        assert_eq!(resolve_io_workers(None, Some(1)), 2);
        assert_eq!(resolve_io_workers(None, Some(3)), 3);
        assert_eq!(resolve_io_workers(None, Some(16)), 4);
        assert_eq!(resolve_io_workers(Some("0"), Some(16)), 1);
        assert_eq!(resolve_io_workers(Some("8"), Some(16)), 8);
        assert_eq!(resolve_io_workers(Some("64"), Some(16)), 16);
        assert_eq!(resolve_io_workers(Some("invalid"), Some(12)), 4);
    }
}
