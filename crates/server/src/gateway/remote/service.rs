use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, Caller, Millis, RemoteDeviceRevokeRequest, RemoteDeviceSummary, RemoteEnableRequest, RemotePairCode, RemotePairExchangeRequest,
    RemotePairExchangeResult, RemotePlatform, RemoteStatus, RemoteWhoami, SCOPE_REMOTE_CLIENT, SCOPE_REMOTE_MACHINE,
};

use super::tailscale::{self, TailscaleInfo};
use crate::context::Context;
use crate::gateway::api::{BoxFuture, CallerPrincipal, RemoteAuth, RemoteDeviceIdentity, Server};
use crate::gateway::http::{Listener, is_allowed_remote_ip, is_remote_allow_all, serve_remote};

pub(super) const TOKEN_PREFIX: &str = "vv_dev_";
pub(super) const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub(super) const PAIR_CODE_LEN: usize = 6;
pub(super) const PAIR_CODE_TTL_MS: Millis = 5 * 60 * 1000;
const EXPIRED_CODE_RETENTION_MS: Millis = 30 * 60 * 1000;
pub(super) const MAX_ACTIVE_PAIR_CODES: usize = 8;
const MAX_RETAINED_EXPIRED_CODES: usize = 16;
pub(super) const RATE_LIMIT_WINDOW_MS: Millis = 60 * 1000;
const MAX_FAILED_ATTEMPTS: usize = 10;
pub(super) const LAST_SEEN_THROTTLE_MS: Millis = 60 * 1000;
const MAX_DEVICE_NAME_CHARS: usize = 128;

pub fn default_remote_port() -> u16 {
    vibevalley_protocol::home::default_port().saturating_add(100)
}

fn is_valid_scope(scope: &str) -> bool {
    matches!(scope, SCOPE_REMOTE_CLIENT | SCOPE_REMOTE_MACHINE)
}

pub(super) fn default_scope_for_platform(platform: RemotePlatform) -> &'static str {
    match platform {
        RemotePlatform::Machine | RemotePlatform::Sandbox => SCOPE_REMOTE_MACHINE,
        RemotePlatform::Ios | RemotePlatform::Android | RemotePlatform::Cli | RemotePlatform::Other => SCOPE_REMOTE_CLIENT,
    }
}

fn env_bind_addr() -> Option<String> {
    std::env::var("VIBEVALLEY_REMOTE_BIND")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone)]
struct PairCodeEntry {
    code: String,
    scope: Option<String>,
    expires_at: Millis,
}

#[derive(Default)]
struct PairingState {
    codes: Vec<PairCodeEntry>,
    failed_attempts: VecDeque<Millis>,
}

/// Manages the optional remote HTTP listener, one-time pairing codes, and paired device tokens.
pub struct Remote {
    ctx: Arc<Context>,
    version: String,
    enabled: AtomicBool,
    lifecycle: AsyncMutex<()>,
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
    vibevalley_protocol::home::computer_name()
}

fn bind_failed(addr: &str, why: impl std::fmt::Display) -> ApiError {
    ApiError::new(
        BizCode::Refused,
        t("server.remote.bindFailed", &[("addr", addr.into()), ("why", why.to_string().into())]),
    )
}

fn build_pair_url(url: &str, code: &str, scope: Option<&str>) -> String {
    let mut deep = url::Url::parse("vibevalley://pair").expect("valid pair url scheme");
    {
        let mut pairs = deep.query_pairs_mut();
        pairs.append_pair("url", url).append_pair("code", code);
        if let Some(scope) = scope
            && !scope.is_empty()
        {
            pairs.append_pair("scope", scope);
        }
    }
    deep.to_string()
}

/// Gracefully stops a running remote listener asynchronously without blocking Tokio workers.
async fn stop_listener_async(listener: Option<Listener>) {
    if let Some(live) = listener {
        live.shutdown().await;
    }
}

impl Remote {
    pub async fn open(ctx: Arc<Context>, version: String) -> Result<Arc<Self>, ApiError> {
        let persisted_enabled = ctx.service.remote.get_config().await?.is_some_and(|cfg| cfg.enabled);
        Ok(Arc::new(Self {
            ctx,
            version,
            enabled: AtomicBool::new(persisted_enabled),
            lifecycle: AsyncMutex::new(()),
            listener: Mutex::new(None),
            pairing: Mutex::new(PairingState::default()),
            last_seen_cache: Mutex::new(HashMap::new()),
        }))
    }

    #[cfg(test)]
    pub(super) fn pair_code_count(&self) -> usize {
        self.pairing.lock().codes.len()
    }

    /// Starts the remote listener on boot only when persisted config has `enabled == true`.
    /// Failures (e.g. an offline Tailscale interface) log a warning without failing server boot.
    pub async fn restore_if_enabled_async(&self, server: Arc<dyn Server>) {
        let _guard = self.lifecycle.lock().await;
        let cfg = match self.ctx.service.remote.get_config().await {
            Ok(Some(cfg)) if cfg.enabled => cfg,
            Ok(_) => return,
            Err(err) => {
                tracing::warn!(error = %err, "failed to read remote access config on boot");
                return;
            }
        };
        let requested_bind = cfg
            .bind_addr
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(env_bind_addr);
        let ip = match requested_bind {
            Some(raw) => match raw.parse::<IpAddr>() {
                Ok(ip) => ip,
                Err(err) => {
                    tracing::warn!(bind_addr = raw, error = %err, "ignoring invalid persisted remote bind address");
                    return;
                }
            },
            None => {
                let ts = tailscale::probe_async().await;
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
        match serve_remote(server, addr) {
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
    pub async fn close_async(&self) {
        let _guard = self.lifecycle.lock().await;
        let live = self.listener.lock().take();
        stop_listener_async(live).await;
    }

    pub async fn status_async(&self) -> Result<RemoteStatus, ApiError> {
        self.status_with_tailscale_async(tailscale::probe_async().await).await
    }

    async fn status_with_tailscale_async(&self, ts: TailscaleInfo) -> Result<RemoteStatus, ApiError> {
        let cfg = self.ctx.service.remote.get_config().await?;
        let devices = self.ctx.service.remote.list_devices().await?;
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

    pub async fn enable_async(&self, req: RemoteEnableRequest, server: Arc<dyn Server>) -> Result<RemoteStatus, ApiError> {
        let _guard = self.lifecycle.lock().await;
        let ts = tailscale::probe_async().await;
        let stored = self.ctx.service.remote.get_config().await?;
        let requested_bind = req
            .bind_addr
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(env_bind_addr);
        let ip = match requested_bind {
            Some(raw) => raw.parse::<IpAddr>().map_err(|e| bind_failed(&raw, e))?,
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
        if !is_allowed_remote_ip(target.ip()) && !is_remote_allow_all() {
            return Err(bind_failed(&target.to_string(), "address must be loopback, Tailscale, or private LAN"));
        }

        let current_addr = self.listener.lock().as_ref().map(|l| l.addr);
        if port != 0 && current_addr == Some(target) {
            self.ctx
                .service
                .remote
                .save_config(true, Some(&target.ip().to_string()), target.port(), self.ctx.now())
                .await?;
            self.enabled.store(true, Ordering::Release);
            return self.status_with_tailscale_async(ts).await;
        }

        // Release an existing listener first if it holds the same port so re-binding does not collide.
        let need_drop_first = current_addr.is_some_and(|addr| addr.port() == port);
        if need_drop_first {
            let old = self.listener.lock().take();
            stop_listener_async(old).await;
        }

        let next = match serve_remote(server, target) {
            Ok(listener) => listener,
            Err(err) => {
                if need_drop_first {
                    self.enabled.store(false, Ordering::Release);
                    let _ = self
                        .ctx
                        .service
                        .remote
                        .save_config(
                            false,
                            stored.as_ref().and_then(|c| c.bind_addr.as_deref()),
                            stored.as_ref().map(|c| c.port).unwrap_or_else(default_remote_port),
                            self.ctx.now(),
                        )
                        .await;
                }
                return Err(bind_failed(&target.to_string(), err));
            }
        };

        let actual = next.addr;
        self.ctx
            .service
            .remote
            .save_config(true, Some(&actual.ip().to_string()), actual.port(), self.ctx.now())
            .await?;
        let old = self.listener.lock().replace(next);
        stop_listener_async(old).await;
        self.enabled.store(true, Ordering::Release);
        self.status_with_tailscale_async(ts).await
    }

    pub async fn disable_async(&self) -> Result<RemoteStatus, ApiError> {
        let _guard = self.lifecycle.lock().await;
        let old = self.listener.lock().take();
        stop_listener_async(old).await;
        self.enabled.store(false, Ordering::Release);
        self.pairing.lock().codes.clear();
        let stored = self.ctx.service.remote.get_config().await?;
        let bind_addr = stored.as_ref().and_then(|c| c.bind_addr.as_deref());
        let port = stored.as_ref().map(|c| c.port).filter(|&p| p != 0).unwrap_or_else(default_remote_port);
        self.ctx.service.remote.save_config(false, bind_addr, port, self.ctx.now()).await?;
        self.status_async().await
    }

    pub fn pair_create(&self) -> Result<RemotePairCode, ApiError> {
        self.pair_create_with_scope(None)
    }

    pub fn pair_create_with_scope(&self, scope: Option<&str>) -> Result<RemotePairCode, ApiError> {
        if !self.enabled.load(Ordering::Acquire) {
            return Err(ApiError::new(BizCode::Refused, t("server.remote.disabled", &[])));
        }
        let Some(url) = self.listener.lock().as_ref().map(Listener::url) else {
            return Err(ApiError::new(BizCode::Refused, t("server.remote.disabled", &[])));
        };
        let normalized_scope = match scope.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) if is_valid_scope(s) => Some(s.to_string()),
            Some(other) => {
                return Err(ApiError::new(BizCode::InvalidInput, format!("unsupported remote scope {other:?}")));
            }
            None => None,
        };

        let now = self.ctx.now();
        let expires_at = now + PAIR_CODE_TTL_MS;
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
                scope: normalized_scope.clone(),
                expires_at,
            });
            candidate
        };

        let pair_url = build_pair_url(&url, &code, normalized_scope.as_deref());
        Ok(RemotePairCode {
            code,
            pair_url,
            url,
            expires_at,
            scope: normalized_scope.or_else(|| Some(SCOPE_REMOTE_CLIENT.into())),
        })
    }

    pub async fn pair_exchange_async(&self, req: RemotePairExchangeRequest) -> Result<RemotePairExchangeResult, ApiError> {
        if !self.enabled.load(Ordering::Acquire) {
            return Err(ApiError::new(BizCode::Refused, t("server.remote.disabled", &[])));
        }

        let requested_scope = match req.scope.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) if is_valid_scope(s) => Some(s.to_string()),
            Some(other) => {
                return Err(ApiError::new(BizCode::InvalidInput, format!("unsupported remote scope {other:?}")));
            }
            None => None,
        };

        let now = self.ctx.now();
        let submitted = req.code.trim().to_ascii_uppercase();
        let entry_scope = {
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
            entry.scope
        };

        let effective_scope = match (entry_scope, requested_scope) {
            (Some(bound), Some(requested)) if bound != requested => {
                return Err(ApiError::new(
                    BizCode::Forbidden,
                    format!("requested scope {requested:?} is not allowed for this pairing code"),
                ));
            }
            (Some(bound), _) => bound,
            (None, Some(requested)) => requested,
            (None, None) => default_scope_for_platform(req.platform).into(),
        };

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
            scope: effective_scope,
            created_at: now,
            last_seen_at: None,
            revoked_at: None,
        };
        self.ctx.service.remote.insert_device(&device, &token_hash).await.map_err(|err| {
            if err.is_unique_violation() {
                ApiError::new(BizCode::Refused, err.to_string())
            } else {
                err.into_api_error()
            }
        })?;

        Ok(RemotePairExchangeResult {
            device,
            token,
            server_name: server_name(),
            version: self.version.clone(),
        })
    }

    pub async fn revoke_device_async(&self, req: RemoteDeviceRevokeRequest) -> Result<(), ApiError> {
        let id = req.id.trim();
        if id.is_empty() || !self.ctx.service.remote.revoke_device(id, self.ctx.now()).await? {
            return Err(ApiError::new(BizCode::NotFound, t("server.remote.deviceNotFound", &[])));
        }
        self.last_seen_cache.lock().remove(id);
        Ok(())
    }

    pub async fn whoami_async(&self, principal: &CallerPrincipal, caller: Caller) -> Result<RemoteWhoami, ApiError> {
        let device = match principal {
            CallerPrincipal::RemoteDevice { device_id, .. } if !device_id.is_empty() => self.ctx.service.remote.find_device_by_id(device_id).await?,
            CallerPrincipal::LocalOwner | CallerPrincipal::RemoteDevice { .. } | CallerPrincipal::Connector { .. } => None,
        };
        Ok(RemoteWhoami {
            device,
            caller: caller.as_str().to_string(),
            server_name: server_name(),
            version: self.version.clone(),
            channel: vibevalley_protocol::home::current_channel().as_str().to_string(),
        })
    }

    async fn verify_bearer_inner_async(&self, token: &str) -> Result<RemoteDeviceIdentity, ApiError> {
        if !self.enabled.load(Ordering::Acquire) {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.disabled", &[])));
        }
        if !token.starts_with(TOKEN_PREFIX) || token.len() <= TOKEN_PREFIX.len() {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.unauthorized", &[])));
        }
        let hash = sha256_hex(token);
        let Some(device) = self.ctx.service.remote.find_device_by_token_hash(&hash).await? else {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.unauthorized", &[])));
        };
        if device.revoked_at.is_some() {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.revoked", &[])));
        }
        if !is_valid_scope(&device.scope) {
            return Err(ApiError::new(BizCode::Unauthorized, t("server.remote.unauthorized", &[])));
        }

        let now = self.ctx.now();
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
            let _ = self.ctx.service.remote.touch_device_last_seen(&device.id, now).await;
        }

        Ok(RemoteDeviceIdentity {
            device_id: device.id,
            name: device.name,
            scope: device.scope,
        })
    }
}

impl RemoteAuth for Remote {
    fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    fn verify_bearer_async(self: Arc<Self>, token: String) -> BoxFuture<'static, Result<RemoteDeviceIdentity, ApiError>> {
        Box::pin(async move { self.verify_bearer_inner_async(&token).await })
    }
}
