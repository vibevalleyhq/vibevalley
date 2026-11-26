use std::collections::VecDeque;
use std::sync::{Arc, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::bundle::workbench_bundle_mode;
use super::hub::ClientsProvider;

pub const MAX_DEBUG_FRAMES: usize = 128;
pub const SLOW_FRAME_US: u64 = 16_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugFrameRecord {
    pub seq: u64,
    pub time: i64,
    pub duration_us: u64,
    pub slow: bool,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCacheEntry {
    pub name: String,
    pub entries: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

struct ShellDebugInner {
    routes: Value,
    caches: Vec<DebugCacheEntry>,
    bundle_mode: Option<&'static str>,
    loopback_url: Option<String>,
    boot_ms: Option<u64>,
    last_frame_ms: Option<f64>,
    next_frame_seq: u64,
    frames: VecDeque<DebugFrameRecord>,
    clients: Option<Weak<ClientsProvider>>,
}

/// Lightweight GPUI shell state snapshot exposed to `Server::host_debug()`.
#[derive(Clone)]
pub struct ShellDebugHandle {
    inner: Arc<parking_lot::RwLock<ShellDebugInner>>,
}

impl gpui::Global for ShellDebugHandle {}

impl Default for ShellDebugHandle {
    fn default() -> Self {
        Self::new()
    }
}

fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn parse_loopback_port(url: &str) -> Option<u16> {
    let rest = url.rsplit_once(':')?.1;
    rest.split('/').next()?.parse::<u16>().ok()
}

impl ShellDebugHandle {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(parking_lot::RwLock::new(ShellDebugInner {
                routes: json!({
                    "current": "/issues",
                    "nativeWorkspace": false,
                    "panel": "files",
                    "inspectorOpen": false,
                    "projects": [],
                }),
                caches: Vec::new(),
                bundle_mode: None,
                loopback_url: None,
                boot_ms: None,
                last_frame_ms: None,
                next_frame_seq: 0,
                frames: VecDeque::with_capacity(MAX_DEBUG_FRAMES),
                clients: None,
            })),
        }
    }

    pub fn update_shell(&self, routes: Value, caches: Vec<DebugCacheEntry>) {
        let mut guard = self.inner.write();
        guard.routes = routes;
        guard.caches = caches;
    }

    pub fn set_boot_info(&self, loopback_url: String, boot_ms: u64) {
        let mut guard = self.inner.write();
        guard.loopback_url = Some(loopback_url);
        guard.boot_ms = Some(boot_ms);
    }

    #[cfg(test)]
    pub fn set_bundle_mode(&self, mode: &'static str) {
        self.inner.write().bundle_mode = Some(mode);
    }

    pub fn attach_clients(&self, provider: &Arc<ClientsProvider>) {
        self.inner.write().clients = Some(Arc::downgrade(provider));
    }

    pub fn loopback_port(&self) -> Option<u16> {
        self.inner.read().loopback_url.as_deref().and_then(parse_loopback_port)
    }

    pub fn record_frame(&self, duration_us: u64, summary: &str) -> DebugFrameRecord {
        let mut guard = self.inner.write();
        guard.next_frame_seq += 1;
        let record = DebugFrameRecord {
            seq: guard.next_frame_seq,
            time: now_millis(),
            duration_us,
            slow: duration_us >= SLOW_FRAME_US,
            summary: summary.to_string(),
        };
        guard.last_frame_ms = Some(duration_us as f64 / 1000.0);
        if guard.frames.len() >= MAX_DEBUG_FRAMES {
            guard.frames.pop_front();
        }
        guard.frames.push_back(record.clone());
        record
    }
}

impl vibevalley_server::HostDebugBridge for ShellDebugHandle {
    fn snapshot_json(&self) -> String {
        let (routes, caches, bundle_mode, loopback_url, boot_ms, last_frame_ms, frames, provider) = {
            let guard = self.inner.read();
            (
                guard.routes.clone(),
                guard.caches.clone(),
                guard.bundle_mode.unwrap_or_else(workbench_bundle_mode),
                guard.loopback_url.clone(),
                guard.boot_ms,
                guard.last_frame_ms,
                guard.frames.iter().cloned().collect::<Vec<_>>(),
                guard.clients.as_ref().and_then(Weak::upgrade),
            )
        };
        let clients: Vec<Value> = provider
            .map(|p| {
                p().into_iter()
                    .map(|c| {
                        json!({
                            "id": c.identity.id,
                            "kind": c.identity.kind.as_str(),
                            "label": c.identity.label,
                            "watches": c.watches,
                            "subscriptions": c.subscriptions,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        json!({
            "routes": routes,
            "clients": clients,
            "bundleMode": bundle_mode,
            "loopbackUrl": loopback_url,
            "bootMs": boot_ms,
            "lastFrameMs": last_frame_ms,
            "frames": frames,
            "caches": caches,
        })
        .to_string()
    }
}
