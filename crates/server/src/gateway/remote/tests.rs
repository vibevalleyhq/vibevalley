use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;

use vibevalley_core::{Clock, ManualClock, SharedClock};
use vibevalley_i18n::t;
use vibevalley_protocol::{BizCode, RemoteEnableRequest, RemotePairExchangeRequest, RemotePlatform, SCOPE_REMOTE_CLIENT, SCOPE_REMOTE_MACHINE};

use super::lan;
use super::service::{
    CODE_ALPHABET, LAST_SEEN_THROTTLE_MS, MAX_ACTIVE_PAIR_CODES, NetworkProbe, PAIR_CODE_LEN, PAIR_CODE_TTL_MS, RATE_LIMIT_WINDOW_MS, Remote,
    TOKEN_PREFIX, default_scope_for_platform, resolve_auto_bind_ip,
};
use super::tailscale::TailscaleInfo;
use crate::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use crate::gateway::api::{RemoteAuth, Server};
use crate::gateway::bridge::fake::FakeServer;
use crate::service::Service;

async fn test_context(home: &std::path::Path, clock: SharedClock) -> Arc<Context> {
    let service = Service::open(home).await.unwrap();
    let outbox = Arc::new(Outbox::new(service.clone()));
    Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        clock,
        Arc::new(Http),
        Arc::new(PublicDownload),
    ))
}

#[tokio::test]
async fn pairing_code_format_expiry_cap_and_rate_limit_work() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let ctx = test_context(dir.path(), clock.clone()).await;
    let fake: Arc<dyn Server> = Arc::new(FakeServer::new());
    let remote = Remote::open(ctx.clone(), "0.1.0-test".into()).await.unwrap();

    let status = remote
        .enable_async(
            RemoteEnableRequest {
                bind_addr: Some("127.0.0.1".into()),
                port: Some(0),
            },
            fake,
        )
        .await
        .unwrap();
    assert!(status.enabled && status.listening);
    assert!(status.port > 0);

    for _ in 0..10 {
        let entry = remote.pair_create().unwrap();
        assert_eq!(entry.code.len(), PAIR_CODE_LEN);
        assert!(entry.code.bytes().all(|b| CODE_ALPHABET.contains(&b)));
        assert!(entry.pair_url.starts_with("vibevalley://pair?url="));
        assert_eq!(entry.expires_at, clock.now_ms() + PAIR_CODE_TTL_MS);
        clock.advance(Duration::from_millis(1));
    }
    assert_eq!(remote.pair_code_count(), MAX_ACTIVE_PAIR_CODES);

    // Create one code that expires first and one created later that stays valid past the rate-limit window.
    let expiring = remote.pair_create().unwrap();
    clock.advance(Duration::from_secs(200));
    let fresh = remote.pair_create().unwrap();
    clock.advance(Duration::from_secs(101));

    let err = remote
        .pair_exchange_async(RemotePairExchangeRequest {
            code: expiring.code,
            device_name: "iPhone".into(),
            platform: RemotePlatform::Ios,
            scope: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.biz_code, BizCode::AuthRefused);
    assert_eq!(err.message, t("server.remote.expiredCode", &[]));

    clock.advance(Duration::from_millis(1));
    for _ in 0..9 {
        let err = remote
            .pair_exchange_async(RemotePairExchangeRequest {
                code: "AAAAAA".into(),
                device_name: "iPhone".into(),
                platform: RemotePlatform::Ios,
                scope: None,
            })
            .await
            .unwrap_err();
        assert_eq!(err.message, t("server.remote.invalidCode", &[]));
    }
    clock.advance(Duration::from_millis(1));
    let limited = remote
        .pair_exchange_async(RemotePairExchangeRequest {
            code: fresh.code.clone(),
            device_name: "iPhone".into(),
            platform: RemotePlatform::Ios,
            scope: None,
        })
        .await
        .unwrap_err();
    assert_eq!(limited.biz_code, BizCode::Refused);
    assert_eq!(limited.message, t("server.remote.rateLimited", &[]));

    // Advancing past RATE_LIMIT_WINDOW_MS clears the rate-limit window while `fresh` is still unexpired.
    clock.advance(Duration::from_millis((RATE_LIMIT_WINDOW_MS + 5_000) as u64));
    let paired = remote
        .pair_exchange_async(RemotePairExchangeRequest {
            code: fresh.code,
            device_name: "iPhone 16".into(),
            platform: RemotePlatform::Ios,
            scope: None,
        })
        .await
        .unwrap();
    assert!(paired.token.starts_with(TOKEN_PREFIX));
    assert_eq!(paired.token.len(), TOKEN_PREFIX.len() + 64);
    assert_eq!(paired.device.name, "iPhone 16");
    assert_eq!(paired.device.platform, RemotePlatform::Ios);
    assert_eq!(paired.device.scope, SCOPE_REMOTE_CLIENT);
    assert_eq!(paired.device.created_at, clock.now_ms());

    // Verify LAST_SEEN_THROTTLE_MS uses the injected clock deterministically.
    let first_seen = clock.now_ms();
    RemoteAuth::verify_bearer_async(remote.clone(), paired.token.clone()).await.unwrap();
    let dev = ctx.service.remote.find_device_by_id(&paired.device.id).await.unwrap().unwrap();
    assert_eq!(dev.last_seen_at, Some(first_seen));

    clock.advance(Duration::from_millis((LAST_SEEN_THROTTLE_MS - 1) as u64));
    RemoteAuth::verify_bearer_async(remote.clone(), paired.token.clone()).await.unwrap();
    let dev = ctx.service.remote.find_device_by_id(&paired.device.id).await.unwrap().unwrap();
    assert_eq!(dev.last_seen_at, Some(first_seen));

    clock.advance(Duration::from_millis(1));
    let refreshed_seen = clock.now_ms();
    RemoteAuth::verify_bearer_async(remote.clone(), paired.token.clone()).await.unwrap();
    let dev = ctx.service.remote.find_device_by_id(&paired.device.id).await.unwrap().unwrap();
    assert_eq!(dev.last_seen_at, Some(refreshed_seen));

    // Verify all 6 platforms round-trip and machine/client scopes persist & enforce bounds.
    for platform in RemotePlatform::ALL {
        clock.advance(Duration::from_millis(1));
        let code = remote.pair_create().unwrap();
        clock.advance(Duration::from_millis(1));
        let res = remote
            .pair_exchange_async(RemotePairExchangeRequest {
                code: code.code,
                device_name: format!("dev-{}", platform.as_str()),
                platform,
                scope: None,
            })
            .await
            .unwrap();
        assert_eq!(res.device.platform, platform);
        let verified = RemoteAuth::verify_bearer_async(remote.clone(), res.token).await.unwrap();
        assert_eq!(verified.scope, default_scope_for_platform(platform));
    }

    // Scoped pair code enforces exact scope match.
    clock.advance(Duration::from_millis(1));
    let scoped = remote.pair_create_with_scope(Some(SCOPE_REMOTE_CLIENT)).unwrap();
    assert!(scoped.pair_url.contains("scope=remote%3Adefault"));
    clock.advance(Duration::from_millis(1));
    let denied = remote
        .pair_exchange_async(RemotePairExchangeRequest {
            code: scoped.code,
            device_name: "Runner".into(),
            platform: RemotePlatform::Machine,
            scope: Some(SCOPE_REMOTE_MACHINE.into()),
        })
        .await
        .unwrap_err();
    assert_eq!(denied.biz_code, BizCode::Forbidden);

    remote.close_async().await;
    ctx.service.close().await;
}

#[tokio::test]
async fn verify_bearer_async_reads_wal_read_pool_while_writer_holds_transaction() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), vibevalley_core::system_clock()).await;
    let fake: Arc<dyn Server> = Arc::new(FakeServer::new());
    let remote = Remote::open(ctx.clone(), "0.1.0-test".into()).await.unwrap();

    let status = remote
        .enable_async(
            RemoteEnableRequest {
                bind_addr: Some("127.0.0.1".into()),
                port: Some(0),
            },
            fake,
        )
        .await
        .unwrap();
    assert!(status.enabled && status.listening);

    let pair = remote.pair_create().unwrap();
    let exchanged = remote
        .pair_exchange_async(RemotePairExchangeRequest {
            code: pair.code,
            device_name: "Async iPhone".into(),
            platform: RemotePlatform::Ios,
            scope: None,
        })
        .await
        .unwrap();

    // Prime last_seen_cache so the next verify_bearer_async is pure read_pool.
    let first = RemoteAuth::verify_bearer_async(remote.clone(), exchanged.token.clone()).await.unwrap();
    assert_eq!(first.device_id, exchanged.device.id);

    // Hold an open write transaction while verify_bearer_async runs.
    let tx = ctx.service.begin_tx().await.unwrap();
    let second = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        RemoteAuth::verify_bearer_async(remote.clone(), exchanged.token.clone()),
    )
    .await
    .expect("verify_bearer_async must not block on write_conn")
    .unwrap();
    assert_eq!(second.device_id, exchanged.device.id);
    ctx.service.rollback_tx(tx).await.unwrap();

    remote.disable_async().await.unwrap();
    remote.close_async().await;
    ctx.service.close().await;
}

#[test]
fn auto_bind_resolution_prefers_online_tailscale_then_lan_then_loopback() {
    let ts_online = TailscaleInfo {
        online: true,
        ipv4: Some("100.64.1.23".into()),
        host: Some("studio.tailnet.ts.net".into()),
    };
    let ts_offline = TailscaleInfo {
        online: false,
        ipv4: Some("100.64.1.23".into()),
        host: Some("studio.tailnet.ts.net".into()),
    };
    let ts_absent = TailscaleInfo::default();

    assert_eq!(
        resolve_auto_bind_ip(&ts_online, Some("192.168.1.42")),
        IpAddr::V4(Ipv4Addr::new(100, 64, 1, 23))
    );
    assert_eq!(
        resolve_auto_bind_ip(&ts_offline, Some("192.168.1.42")),
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 42))
    );
    assert_eq!(
        resolve_auto_bind_ip(&ts_absent, Some("192.168.1.42")),
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 42))
    );
    assert_eq!(resolve_auto_bind_ip(&ts_absent, None), IpAddr::V4(Ipv4Addr::LOCALHOST));
}

#[tokio::test]
async fn enable_pair_and_token_auth_work_without_tailscale() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let ctx = test_context(dir.path(), clock).await;
    let fake: Arc<dyn Server> = Arc::new(FakeServer::new());
    let remote = Remote::open(ctx.clone(), "0.1.0-test".into()).await.unwrap();

    let detected_lan = lan::detect_lan_ipv4();
    let expected_bind = detected_lan.clone().unwrap_or_else(|| "127.0.0.1".into());
    let probe = NetworkProbe {
        tailscale: TailscaleInfo::default(),
        lan_ip: detected_lan.clone(),
    };

    let status = remote
        .enable_with_probe_async(RemoteEnableRequest { bind_addr: None, port: Some(0) }, fake, probe)
        .await
        .unwrap();
    assert!(status.enabled);
    assert!(status.listening);
    assert!(!status.tailscale_online);
    assert_eq!(status.tailscale_ip, None);
    assert_eq!(status.lan_ip, detected_lan);
    assert_eq!(status.bind_addr.as_deref(), Some(expected_bind.as_str()));
    let expected_url = format!("http://{expected_bind}:{}", status.port);
    assert_eq!(status.url.as_deref(), Some(expected_url.as_str()));

    let pair = remote.pair_create().unwrap();
    assert_eq!(pair.url, expected_url);
    assert!(pair.pair_url.starts_with("vibevalley://pair?url="));
    assert!(pair.pair_url.contains(&pair.code));

    let exchanged = remote
        .pair_exchange_async(RemotePairExchangeRequest {
            code: pair.code,
            device_name: "Wi-Fi Phone".into(),
            platform: RemotePlatform::Ios,
            scope: None,
        })
        .await
        .unwrap();
    assert!(exchanged.token.starts_with(TOKEN_PREFIX));
    assert_eq!(exchanged.device.scope, SCOPE_REMOTE_CLIENT);

    let identity = RemoteAuth::verify_bearer_async(remote.clone(), exchanged.token).await.unwrap();
    assert_eq!(identity.device_id, exchanged.device.id);
    assert_eq!(identity.scope, SCOPE_REMOTE_CLIENT);

    remote.disable_async().await.unwrap();
    remote.close_async().await;
    ctx.service.close().await;
}

#[tokio::test]
async fn status_exposes_both_lan_and_tailscale_addresses_and_switches_bind_addr() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), vibevalley_core::system_clock()).await;
    let fake: Arc<dyn Server> = Arc::new(FakeServer::new());
    let remote = Remote::open(ctx.clone(), "0.1.0-test".into()).await.unwrap();

    let dual_probe = NetworkProbe {
        tailscale: TailscaleInfo {
            online: true,
            ipv4: Some("100.64.1.23".into()),
            host: Some("studio-mac.tailnet.ts.net".into()),
        },
        lan_ip: Some("192.168.1.42".into()),
    };
    let status = remote.status_with_probe_async(dual_probe).await.unwrap();
    assert_eq!(status.lan_ip.as_deref(), Some("192.168.1.42"));
    assert_eq!(status.tailscale_ip.as_deref(), Some("100.64.1.23"));
    assert_eq!(status.tailscale_host.as_deref(), Some("studio-mac.tailnet.ts.net"));
    assert!(status.tailscale_online);

    // Switching explicit bind_addr updates both the live listener URL and generated pairing address.
    let first = remote
        .enable_with_probe_async(
            RemoteEnableRequest {
                bind_addr: Some("127.0.0.1".into()),
                port: Some(0),
            },
            fake.clone(),
            NetworkProbe::default(),
        )
        .await
        .unwrap();
    let first_pair = remote.pair_create().unwrap();
    assert_eq!(first_pair.url, format!("http://127.0.0.1:{}", first.port));

    if let Some(real_lan) = lan::detect_lan_ipv4() {
        let switched = remote
            .enable_with_probe_async(
                RemoteEnableRequest {
                    bind_addr: Some(real_lan.clone()),
                    port: None,
                },
                fake,
                NetworkProbe {
                    tailscale: TailscaleInfo::default(),
                    lan_ip: Some(real_lan.clone()),
                },
            )
            .await
            .unwrap();
        assert_eq!(switched.bind_addr.as_deref(), Some(real_lan.as_str()));
        let switched_pair = remote.pair_create().unwrap();
        assert_eq!(switched_pair.url, format!("http://{real_lan}:{}", switched.port));
    }

    remote.disable_async().await.unwrap();
    remote.close_async().await;
    ctx.service.close().await;
}
