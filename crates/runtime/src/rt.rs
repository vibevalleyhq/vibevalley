//! Process-wide shared Tokio runtime for asynchronous I/O in VibeValley.

use std::future::Future;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::runtime::{Handle, Runtime, RuntimeFlavor};

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let next = AtomicUsize::new(0);
        tokio::runtime::Builder::new_multi_thread()
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

pub fn block_on<F: Future>(future: F) -> F::Output {
    match Handle::try_current() {
        Err(_) => handle().block_on(future),
        Ok(current) if current.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(|| handle().block_on(future)),
        // Current-thread runtimes panic on `block_in_place`; entering the shared runtime lets its workers drive Tokio I/O and timers.
        Ok(_) => {
            let _guard = handle().enter();
            pollster::block_on(future)
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
}
