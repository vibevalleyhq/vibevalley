//! `remote.*`: Tailscale-first remote mobile access listener, single-use
//! pairing codes, hashed persistent device Bearer tokens, and revocation.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, Millis, RemoteDeviceRevokeRequest, RemoteDeviceSummary, RemoteEnableRequest, RemotePairCode, RemotePairExchangeRequest,
    RemotePairExchangeResult, RemoteStatus, RemoteWhoami, ops,
};

use crate::transport::api::{CallerPrincipal, RemoteAuth, RemoteDeviceIdentity};
use crate::transport::http::{Listener, is_allowed_remote_ip, serve_remote};
use crate::{Ctx, Hub};

mod db;
pub mod tailscale;

use db::RemoteDb;
use tailscale::TailscaleInfo;

const TOKEN_PREFIX: &str = "vv_dev_";
const DEFAULT_SCOPE: &str = "remote:default";
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_CODE_LEN: usize = 6;
const PAIR_CODE_TTL_MS: Millis = 5 * 60 * 1000;
const EXPIRED_CODE_RETENTION_MS: Millis = 30 * 60 * 1000;
const MAX_ACTIVE_PAIR_CODES: usize = 8;
const MAX_RETAINED_EXPIRED_CODES: usize = 16;
const RATE_LIMIT_WINDOW_MS: Millis = 60 * 1000;
const MAX_FAILED_ATTEMPTS: usize = 10;
const LAST_SEEN_THROTTLE_MS: Millis = 60 * 1000;
const MAX_DEVICE_NAME_CHARS: usize = 128;

pub fn default_remote_port() -> u16 {
    vibevalley_protocol::home::default_port().saturating_add(100)
}

#[derive(Debug, Clone)]
struct PairCodeEntry {
    code: String,
    expires_at: Millis,
}

#[derive(Default)]
struct PairingState {
    codes: Vec<PairCodeEntry>,
    failed_attempts: VecDeque<Millis>,
}

/// Manages the optional remote HTTP listener, one-time pairing codes, and paired device tokens.
pub struct Remote {
    db: RemoteDb,
    hub: Weak<Hub>,
    version: String,
    enabled: AtomicBool,
    lifecycle: Mutex<()>,
    listener: Mutex<Option<Listener>>,
    pairing: Mutex<PairingState>,
    last_seen_cache: Mutex<HashMap<String, Millis>>,
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Derives 32 uniform OS-random bytes from three UUID v4 values (366 bits of CSPRNG input).
fn random_32_bytes() -> [u8; 32] {
    let mut hasher = Sha256::new();
    for _ in 0..3 {
        hasher.update(uuid::Uuid::new_v4().as_bytes());
    }
    hasher.finalize().into()
}

fn generate_pair_code() -> String {
    let bytes = random_32_bytes();
    let mut out = String::with_capacity(PAIR_CODE_LEN);
    // 256 is an exact multiple of 32, so masking 5 bits has zero modulo bias.
    for b in &bytes[..PAIR_CODE_LEN] {
        out.push(CODE_ALPHABET[(b & 0x1f) as usize] as char);
    }
    out
}

fn generate_device_token() -> String {
    let bytes = random_32_bytes();
    let mut out = String::with_capacity(TOKEN_PREFIX.len() + bytes.len() * 2);
    out.push_str(TOKEN_PREFIX);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn server_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        if let Some(name) = std::env::var("VIBEVALLEY_SERVER_NAME")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            return name;
        }
        let read_cmd = |bin: &str, args: &[&str]| -> Option<String> {
            let out = Command::new(bin).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
            if !out.status.success() {
                return None;
            }
            let text = String::from_utf8(out.stdout).ok()?;
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        };
        read_cmd("scutil", &["--get", "ComputerName"])
            .or_else(|| read_cmd("hostname", &["-s"]))
            .unwrap_or_else(|| "VibeValley".into())
    })
    .clone()
}

fn bind_failed(addr: &str, why: impl std::fmt::Display) -> ApiError {
    ApiError::new(
        BizCode::Refused,
        t("server.remote.bindFailed", &[("addr", addr.into()), ("why", why.to_string().into())]),
    )
}

fn build_pair_url(url: &str, code: &str) -> String {
    let mut deep = url::Url::parse("vibevalley://pair").expect("valid pair url scheme");
    deep.query_pairs_mut().append_pair("url", url).append_pair("code", code);
    deep.to_string()
}

impl Remote {
    pub fn open(home: &Path, hub: Weak<Hub>, version: String) -> Result<Arc<Self>, ApiError> {
        let db = RemoteDb::open(home)?;
        let persisted_enabled = db.get_config()?.is_some_and(|cfg| cfg.enabled);
        Ok(Arc::new(Self {
            db,
            hub,
            version,
            enabled: AtomicBool::new(persisted_enabled),
            lifecycle: Mutex::new(()),
            listener: Mutex::new(None),
            pairing: Mutex::new(PairingState::default()),
            last_seen_cache: Mutex::new(HashMap::new()),
        }))
    }

    /// Starts the remote listener on boot only when persisted config has `enabled == true`.
    /// Failures (e.g. an offline Tailscale interface) log a warning without failing server boot.
    pub fn restore_if_enabled(&self) {
        let _guard = self.lifecycle.lock();
        let cfg = match self.db.get_config() {
            Ok(Some(cfg)) if cfg.enabled => cfg,
            Ok(_) => return,
            Err(err) => {
                tracing::warn!(error = %err, "failed to read remote access config on boot");
                return;
            }
        };
        let ip = match cfg.bind_addr.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => match raw.parse::<IpAddr>() {
                Ok(ip) => ip,
                Err(err) => {
                    tracing::warn!(bind_addr = raw, error = %err, "ignoring invalid persisted remote bind address");
                    return;
                }
            },
            None => {
                let ts = tailscale::probe();
                if ts.online
                    && let Some(ip) = ts.ipv4.as_deref().and_then(|s| s.parse::<IpAddr>().ok())
                {
                    ip
                } else {
                    IpAddr::V4(Ipv4Addr::LOCALHOST)
                }
            }
        };
        let port = if cfg.port == 0 { default_remote_port() } else { cfg.port };
        let addr = SocketAddr::new(ip, port);
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        match serve_remote(hub, addr) {
            Ok(listener) => {
                *self.listener.lock() = Some(listener);
                self.enabled.store(true, Ordering::Release);
            }
            Err(err) => {
                tracing::warn!(%addr, error = %err, "remote listener could not bind on boot; staying enabled but not listening");
            }
        }
    }

    /// Stops the live remote listener without mutating persisted config.
    pub fn close(&self) {
        let _guard = self.lifecycle.lock();
        let live = self.listener.lock().take();
        drop(live);
    }

    pub fn status(&self) -> Result<RemoteStatus, ApiError> {
        self.status_with_tailscale(tailscale::probe())
    }

    fn status_with_tailscale(&self, ts: TailscaleInfo) -> Result<RemoteStatus, ApiError> {
        let cfg = self.db.get_config()?;
        let devices = self.db.list_devices()?;
        let live_addr = self.listener.lock().as_ref().map(|l| (l.addr, l.url()));
        let enabled = self.enabled.load(Ordering::Acquire);
        let (listening, bind_addr, port, url) = match live_addr {
            Some((addr, url)) => (true, Some(addr.ip().to_string()), addr.port(), Some(url)),
            None => {
                let bind_addr = cfg.as_ref().and_then(|c| c.bind_addr.clone());
                let port = cfg.as_ref().map(|c| c.port).filter(|&p| p != 0).unwrap_or_else(default_remote_port);
                (false, bind_addr, port, None)
            }
        };
        Ok(RemoteStatus {
            enabled,
            listening,
            bind_addr,
            port,
            tailscale_ip: ts.ipv4,
            tailscale_host: ts.host,
            tailscale_online: ts.online,
            url,
            devices,
        })
    }

    pub fn enable(&self, req: RemoteEnableRequest) -> Result<RemoteStatus, ApiError> {
        let _guard = self.lifecycle.lock();
        let ts = tailscale::probe();
        let stored = self.db.get_config()?;
        let ip = match req.bind_addr.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => raw.parse::<IpAddr>().map_err(|e| bind_failed(raw, e))?,
            None => {
                if ts.online
                    && let Some(ip) = ts.ipv4.as_deref().and_then(|s| s.parse::<IpAddr>().ok())
                {
                    ip
                } else {
                    IpAddr::V4(Ipv4Addr::LOCALHOST)
                }
            }
        };
        let port = req
            .port
            .unwrap_or_else(|| stored.as_ref().map(|c| c.port).filter(|&p| p != 0).unwrap_or_else(default_remote_port));
        let target = SocketAddr::new(ip, port);
        if !is_allowed_remote_ip(target.ip()) {
            return Err(bind_failed(&target.to_string(), "address must be loopback, Tailscale, or private LAN"));
        }

        let current_addr = self.listener.lock().as_ref().map(|l| l.addr);
        if port != 0 && current_addr == Some(target) {
            self.db.save_config(true, Some(&target.ip().to_string()), target.port(), crate::now())?;
            self.enabled.store(true, Ordering::Release);
            return self.status_with_tailscale(ts);
        }

        let Some(hub) = self.hub.upgrade() else {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "server hub is shutting down"));
        };

        // Release an existing listener first if it holds the same port so re-binding does not collide.
        let need_drop_first = current_addr.is_some_and(|addr| addr.port() == port);
        if need_drop_first {
            let old = self.listener.lock().take();
            drop(old);
        }

        let next = match serve_remote(hub, target) {
            Ok(listener) => listener,
            Err(err) => {
                if need_drop_first {
                    self.enabled.store(false, Ordering::Release);
                    let _ = self.db.save_config(
                        false,
                        stored.as_ref().and_then(|c| c.bind_addr.as_deref()),
                        stored.as_ref().map(|c| c.port).unwrap_or_else(default_remote_port),
                        crate::now(),
                    );
                }
                return Err(bind_failed(&target.to_string(), err));
            }
        };

        let actual = next.addr;
        self.db.save_config(true, Some(&actual.ip().to_string()), actual.port(), crate::now())?;
        let old = self.listener.lock().replace(next);
        drop(old);
        self.enabled.store(true, Ordering::Release);
        self.status_with_tailscale(ts)
    }

    pub fn disable(&self) -> Result<RemoteStatus, ApiError> {
        let _guard = self.lifecycle.lock();
        let old = self.listener.lock().take();
        drop(old);
        self.enabled.store(false, Ordering::Release);
        self.pairing.lock().codes.clear();
        let stored = self.db.get_config()?;
        let bind_addr = stored.as_ref().and_then(|c| c.bind_addr.as_deref());
        let port = stored.as_ref().map(|c| c.port).filter(|&p| p != 0).unwrap_or_else(default_remote_port);
        self.db.save_config(false, bind_addr, port, crate::now())?;
        self.status()
    }

    pub fn pair_create(&self) -> Result<RemotePairCode, ApiError> {
        self.pair_create_at(crate::now(), PAIR_CODE_TTL_MS)
    }

    fn pair_create_at(&self, now: Millis, ttl_ms: Millis) -> Result<RemotePairCode, ApiError> {
        if !self.enabled.load(Ordering::Acquire) {
            return Err(ApiError::new(BizCode::Refused, t("server.remote.disabled", &[])));
        }
        let Some(url) = self.listener.lock().as_ref().map(Listener::url) else {
            return Err(ApiError::new(BizCode::Refused, t("server.remote.disabled", &[])));
        };

        let expires_at = now + ttl_ms;
        let code = {
            let mut state = self.pairing.lock();
            state.codes.retain(|entry| entry.expires_at > now - EXPIRED_CODE_RETENTION_MS);

            // Keep expired codes bounded while preserving recently expired ones for `expiredCode`.
            let expired_count = state.codes.iter().filter(|e| e.expires_at <= now).count();
            if expired_count > MAX_RETAINED_EXPIRED_CODES {
                let mut drop_n = expired_count - MAX_RETAINED_EXPIRED_CODES;
                state.codes.retain(|e| {
                    if e.expires_at <= now && drop_n > 0 {
                        drop_n -= 1;
                        false
                    } else {
                        true
                    }
                });
            }

            while state.codes.iter().filter(|e| e.expires_at > now).count() >= MAX_ACTIVE_PAIR_CODES {
                if let Some(pos) = state.codes.iter().position(|e| e.expires_at > now) {
                    state.codes.remove(pos);
                } else {
                    break;
                }
            }

            let mut candidate = generate_pair_code();
            while state.codes.iter().any(|e| e.code == candidate) {
                candidate = generate_pair_code();
            }
            state.codes.push(PairCodeEntry {
                code: candidate.clone(),
                expires_at,
            });
            candidate
        };

        let pair_url = build_pair_url(&url, &code);
        Ok(RemotePairCode {
            code,
            pair_url,
            url,
            expires_at,
        })
    }

    pub fn pair_exchange(&self, req: RemotePairExchangeRequest) -> Result<RemotePairExchangeResult, ApiError> {
        self.pair_exchange_at(req, crate::now())
    }

    fn pair_exchange_at(&self, req: RemotePairExchangeRequest, now: Millis) -> Result<RemotePairExchangeResult, ApiError> {
        if !self.enabled.load(Ordering::Acquire) {
            return Err(ApiError::new(BizCode::Refused, t("server.remote.disabled", &[])));
        }

        let submitted = req.code.trim().to_ascii_uppercase();
        {
            let mut state = self.pairing.lock();
            while state.failed_attempts.front().is_some_and(|&ts| now.saturating_sub(ts) >= RATE_LIMIT_WINDOW_MS) {
                state.failed_attempts.pop_front();
            }
            if state.failed_attempts.len() >= MAX_FAILED_ATTEMPTS {
                return Err(ApiError::new(BizCode::Refused, t("server.remote.rateLimited", &[])));
            }
            let Some(pos) = state.codes.iter().position(|entry| entry.code == submitted) else {
                state.failed_attempts.push_back(now);
                return Err(ApiError::new(BizCode::AuthRefused, t("server.remote.invalidCode", &[])));
            };
            let entry = state.codes.remove(pos);
            if entry.expires_at <= now {
                state.failed_attempts.push_back(now);
                return Err(ApiError::new(BizCode::AuthRefused, t("server.remote.expiredCode", &[])));
            }
        }

        let trimmed_name = req.device_name.trim();
        let name: String = if trimmed_name.is_empty() {
            "Remote Device".into()
        } else {
            trimmed_name.chars().take(MAX_DEVICE_NAME_CHARS).collect()
        };

        let token = generate_device_token();
        let token_hash = sha256_hex(&token);
        let device = RemoteDeviceSummary {
            id: format!("dev_{}", uuid::Uuid::now_v7().simple()),
            name,
            platform: req.platform,
            scope: DEFAULT_SCOPE.into(),
            created_at: now,
            last_seen_at: None,
            revoked_at: None,
        };
        self.db.insert_device(&device, &token_hash)?;

        Ok(RemotePairExchangeResult {
            device,
            token,
            server_name: server_name(),
            version: self.version.clone(),
        })
    }

    pub fn revoke_device(&self, req: RemoteDeviceRevokeRequest) -> Result<(), ApiError> {
        let id = req.id.trim();
        if id.is_empty() || !self.db.revoke_device(id, crate::now())? {
            return Err(ApiError::new(BizCode::NotFound, t("server.remote.deviceNotFound", &[])));
        }
        self.last_seen_cache.lock().remove(id);
        Ok(())
    }

    pub fn whoami(&self, ctx: &Ctx) -> Result<RemoteWhoami, ApiError> {
        let device = match &ctx.principal {
            CallerPrincipal::RemoteDevice { device_id, .. } if !device_id.is_empty() => self.db.find_by_id(device_id)?,
            CallerPrincipal::LocalOwner | CallerPrincipal::RemoteDevice { .. } | CallerPrincipal::Connector { .. } => None,
        };
        Ok(RemoteWhoami {
            device,
            caller: ctx.caller.as_str().to_string(),
            server_name: server_name(),
            version: self.version.clone(),
            channel: vibevalley_protocol::home::current_channel().as_str().to_string(),
        })
    }
}

impl RemoteAuth for Remote {
    fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    fn verify_bearer(&self, token: &str) -> Result<RemoteDeviceIdentity, ApiError> {
        if !self.enabled.load(Ordering::Acquire) {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.disabled", &[])));
        }
        if !token.starts_with(TOKEN_PREFIX) || token.len() <= TOKEN_PREFIX.len() {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.unauthorized", &[])));
        }
        let hash = sha256_hex(token);
        let Some(device) = self.db.find_by_token_hash(&hash)? else {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.unauthorized", &[])));
        };
        if device.revoked_at.is_some() {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.revoked", &[])));
        }

        let now = crate::now();
        let should_touch = {
            let mut cache = self.last_seen_cache.lock();
            match cache.get(&device.id) {
                Some(&prev) if now.saturating_sub(prev) < LAST_SEEN_THROTTLE_MS => false,
                _ => {
                    cache.insert(device.id.clone(), now);
                    true
                }
            }
        };
        if should_touch {
            let _ = self.db.touch_last_seen(&device.id, now);
        }

        Ok(RemoteDeviceIdentity {
            device_id: device.id,
            name: device.name,
            scope: device.scope,
        })
    }
}

pub fn install(hub: &Hub, remote: Arc<Remote>) {
    let r = remote.clone();
    hub.on::<ops::RemoteStatus>(move |_, ()| r.status());
    let r = remote.clone();
    hub.on::<ops::RemoteEnable>(move |_, req| r.enable(req));
    let r = remote.clone();
    hub.on::<ops::RemoteDisable>(move |_, ()| r.disable());
    let r = remote.clone();
    hub.on::<ops::RemotePairCreate>(move |_, ()| r.pair_create());
    let r = remote.clone();
    hub.on::<ops::RemotePairExchange>(move |_, req| r.pair_exchange(req));
    let r = remote.clone();
    hub.on::<ops::RemoteDeviceRevoke>(move |_, req| r.revoke_device(req));
    hub.on::<ops::RemoteWhoami>(move |ctx, ()| remote.whoami(ctx));
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::RemotePlatform;

    use super::*;

    #[test]
    fn pairing_code_format_expiry_cap_and_rate_limit_work() {
        vibevalley_i18n::set_locale("en");
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let remote = Remote::open(dir.path(), Arc::downgrade(&hub), "0.1.0-test".into()).unwrap();

        let status = remote
            .enable(RemoteEnableRequest {
                bind_addr: Some("127.0.0.1".into()),
                port: Some(0),
            })
            .unwrap();
        assert!(status.enabled && status.listening);
        assert!(status.port > 0);

        let base_now = 1_700_000_000_000i64;
        let mut created = Vec::new();
        for i in 0..10 {
            let entry = remote.pair_create_at(base_now + i, PAIR_CODE_TTL_MS).unwrap();
            assert_eq!(entry.code.len(), PAIR_CODE_LEN);
            assert!(entry.code.bytes().all(|b| CODE_ALPHABET.contains(&b)));
            assert!(entry.pair_url.starts_with("vibevalley://pair?url="));
            created.push(entry);
        }
        assert_eq!(remote.pairing.lock().codes.len(), MAX_ACTIVE_PAIR_CODES);

        let expired = remote.pair_create_at(base_now, 1000).unwrap();
        let err = remote
            .pair_exchange_at(
                RemotePairExchangeRequest {
                    code: expired.code,
                    device_name: "iPhone".into(),
                    platform: RemotePlatform::Ios,
                },
                base_now + 2000,
            )
            .unwrap_err();
        assert_eq!(err.biz_code, BizCode::AuthRefused);
        assert_eq!(err.message, t("server.remote.expiredCode", &[]));

        for _ in 0..9 {
            let err = remote
                .pair_exchange_at(
                    RemotePairExchangeRequest {
                        code: "AAAAAA".into(),
                        device_name: "iPhone".into(),
                        platform: RemotePlatform::Ios,
                    },
                    base_now + 2001,
                )
                .unwrap_err();
            assert_eq!(err.message, t("server.remote.invalidCode", &[]));
        }
        let limited = remote
            .pair_exchange_at(
                RemotePairExchangeRequest {
                    code: created.last().unwrap().code.clone(),
                    device_name: "iPhone".into(),
                    platform: RemotePlatform::Ios,
                },
                base_now + 2002,
            )
            .unwrap_err();
        assert_eq!(limited.biz_code, BizCode::Refused);
        assert_eq!(limited.message, t("server.remote.rateLimited", &[]));

        let paired = remote
            .pair_exchange_at(
                RemotePairExchangeRequest {
                    code: created.last().unwrap().code.clone(),
                    device_name: "iPhone 16".into(),
                    platform: RemotePlatform::Ios,
                },
                base_now + RATE_LIMIT_WINDOW_MS + 5000,
            )
            .unwrap();
        assert!(paired.token.starts_with(TOKEN_PREFIX));
        assert_eq!(paired.token.len(), TOKEN_PREFIX.len() + 64);
        assert_eq!(paired.device.name, "iPhone 16");
        assert_eq!(paired.device.platform, RemotePlatform::Ios);

        remote.close();
    }
}
