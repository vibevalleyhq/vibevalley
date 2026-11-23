//! End-to-end integration tests for Tailscale / mobile remote access (`remote.*`),
//! controlled Bearer authentication, SSE slice resume, revocation, and security walls.

use std::io::{BufRead, BufReader};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sqlx::Row;
use vibevalley_i18n::t;
use vibevalley_protocol::{BizCode, Caller};
use vibevalley_server::modules::infra::remote::{default_remote_port, tailscale};
use vibevalley_server::transport::http::{is_allowed_remote_ip, serve, serve_remote};

use crate::support::inspect_db;

fn start_server(dir: &std::path::Path) -> vibevalley_server::Started {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    vibevalley_server::start(vibevalley_server::ServerConfig {
        version: "2.3.4-remote-test".into(),
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        debug_enabled: true,
        ..vibevalley_server::ServerConfig::under(dir)
    })
    .unwrap()
}

fn http_agent() -> reqwest::blocking::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap()
}

fn post_json(url: &str, token: Option<&str>, body: Value) -> (u16, Value) {
    let mut req = http_agent().post(url);
    if let Some(tok) = token {
        req = req.header("authorization", format!("Bearer {tok}"));
    }
    let res = req.json(&body).send().unwrap();
    let status = res.status().as_u16();
    let text = res.text().unwrap();
    let parsed = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }));
    (status, parsed)
}

fn get_json(url: &str, token: Option<&str>) -> (u16, Value) {
    let mut req = http_agent().get(url);
    if let Some(tok) = token {
        req = req.header("authorization", format!("Bearer {tok}"));
    }
    let res = req.send().unwrap();
    let status = res.status().as_u16();
    let text = res.text().unwrap();
    let parsed = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }));
    (status, parsed)
}

fn open_sse(url: &str, token: &str, last_event_id: Option<&str>) -> BufReader<Box<dyn std::io::Read + Send>> {
    let mut req = http_agent()
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .header("accept", "text/event-stream");
    if let Some(id) = last_event_id {
        req = req.header("last-event-id", id);
    }
    let res = req.send().unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.headers().get("content-type").unwrap().to_str().unwrap(), "text/event-stream");
    BufReader::new(Box::new(res))
}

fn next_sse_event(reader: &mut BufReader<Box<dyn std::io::Read + Send>>) -> (Option<String>, Value) {
    let mut line = String::new();
    let mut event_id = None;
    loop {
        line.clear();
        let read = reader.read_line(&mut line).unwrap();
        assert_ne!(read, 0, "SSE stream closed before yielding an event");
        if let Some(id) = line.strip_prefix("id:") {
            event_id = Some(id.trim().to_string());
        } else if let Some(data) = line.strip_prefix("data:") {
            return (event_id, serde_json::from_str(data.trim()).unwrap());
        }
    }
}

fn first_sse_event(url: &str, token: &str, last_event_id: Option<&str>) -> (Option<String>, Value) {
    let mut reader = open_sse(url, token, last_event_id);
    next_sse_event(&mut reader)
}

#[test]
fn remote_full_lifecycle_pairing_bearer_ops_slices_sse_resume_and_disable() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let local_listener = serve(started.hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();

    let status_env = started.hub.call_as(Caller::User, "remote.status", json!({}));
    assert_eq!(status_env.biz_code, 0, "{}", status_env.message);
    let status = status_env.data.unwrap();
    assert_eq!(status["enabled"], false);
    assert_eq!(status["listening"], false);
    assert_eq!(status["port"], default_remote_port());
    assert!(status.get("url").is_none());
    assert_eq!(status["devices"], json!([]));

    let pair_disabled = started.hub.call_as(Caller::User, "remote.pair.create", json!({}));
    assert_eq!(pair_disabled.biz_code, BizCode::Refused.code());
    assert_eq!(pair_disabled.message, t("server.remote.disabled", &[]));

    let enabled_env = started
        .hub
        .call_as(Caller::User, "remote.enable", json!({ "bindAddr": "127.0.0.1", "port": 0 }));
    assert_eq!(enabled_env.biz_code, 0, "{}", enabled_env.message);
    let enabled = enabled_env.data.unwrap();
    assert_eq!(enabled["enabled"], true);
    assert_eq!(enabled["listening"], true);
    assert_eq!(enabled["bindAddr"], "127.0.0.1");
    let bound_port = enabled["port"].as_u64().unwrap();
    assert!(bound_port > 0);
    let remote_url = enabled["url"].as_str().unwrap().to_string();
    assert_eq!(remote_url, format!("http://127.0.0.1:{bound_port}"));

    let pair_env = started.hub.call_as(Caller::User, "remote.pair.create", json!({}));
    assert_eq!(pair_env.biz_code, 0, "{}", pair_env.message);
    let pair = pair_env.data.unwrap();
    let code = pair["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 6);
    assert_eq!(pair["url"], remote_url);
    assert!(pair["pairUrl"].as_str().unwrap().starts_with("vibevalley://pair?url="));
    assert!(pair["expiresAt"].as_i64().unwrap() > vibevalley_server::now());

    let (exchange_status, exchange_body) = post_json(
        &format!("{remote_url}/api/v1/remote/pair/exchange"),
        None,
        json!({ "code": code, "deviceName": "Lucas iPhone", "platform": "ios" }),
    );
    assert_eq!(exchange_status, 200, "{exchange_body}");
    assert_eq!(exchange_body["bizCode"], 0);
    let exchange = &exchange_body["data"];
    let token = exchange["token"].as_str().unwrap().to_string();
    let device_id = exchange["device"]["id"].as_str().unwrap().to_string();
    assert!(token.starts_with("vv_dev_"));
    assert_eq!(token.len(), "vv_dev_".len() + 64);
    assert_eq!(exchange["device"]["name"], "Lucas iPhone");
    assert_eq!(exchange["device"]["platform"], "ios");
    assert_eq!(exchange["device"]["scope"], "remote:default");
    assert_eq!(exchange["version"], "2.3.4-remote-test");
    assert!(!exchange["serverName"].as_str().unwrap().is_empty());

    {
        let mut conn = inspect_db(&dir.path().join("server.db"));
        let row = vibevalley_runtime::rt::block_on(
            sqlx::query("select token_hash from remote_device where id = ?1")
                .bind(&device_id)
                .fetch_one(&mut conn),
        )
        .unwrap();
        let stored_hash: String = row.get("token_hash");
        assert_eq!(stored_hash.len(), 64);
        assert_ne!(stored_hash, token);
        assert!(!stored_hash.contains("vv_dev_"));
    }

    let (replay_status, replay_body) = post_json(
        &format!("{remote_url}/api/v1/remote/pair/exchange"),
        None,
        json!({ "code": code, "deviceName": "Replay Phone", "platform": "android" }),
    );
    assert_eq!(replay_status, 403, "{replay_body}");
    assert_eq!(replay_body["bizCode"], BizCode::AuthRefused.code());
    assert_eq!(replay_body["message"], t("server.remote.invalidCode", &[]));

    let (st, local_whoami) = post_json(&format!("{}/api/v1/remote/whoami", local_listener.url()), None, json!({}));
    assert_eq!(st, 200, "{local_whoami}");
    assert_eq!(local_whoami["data"]["caller"], "user");
    assert!(local_whoami["data"].get("device").is_none());

    let (st, whoami) = post_json(&format!("{remote_url}/api/v1/remote/whoami"), Some(&token), json!({}));
    assert_eq!(st, 200, "{whoami}");
    assert_eq!(whoami["data"]["caller"], "remote");
    assert_eq!(whoami["data"]["device"]["id"], device_id);
    assert_eq!(whoami["data"]["device"]["name"], "Lucas iPhone");
    assert_eq!(whoami["data"]["version"], "2.3.4-remote-test");
    assert!(!whoami["data"]["channel"].as_str().unwrap().is_empty());

    let (st, issues) = post_json(&format!("{remote_url}/api/v1/issue/list"), Some(&token), json!({}));
    assert_eq!(st, 200, "{issues}");
    assert!(issues["data"].is_array());

    let channels = started.hub.call_as(Caller::User, "channel.list", json!({})).data.unwrap();
    let default_channel_id = channels[0]["id"].as_str().unwrap().to_string();
    let (st, sent) = post_json(
        &format!("{remote_url}/api/v1/channel/message/send"),
        Some(&token),
        json!({ "id": default_channel_id, "text": "hello from ios" }),
    );
    assert_eq!(st, 200, "{sent}");
    assert_eq!(sent["bizCode"], 0);
    let msgs = started
        .hub
        .call_as(Caller::User, "channel.message.list", json!({ "id": default_channel_id }))
        .data
        .unwrap();
    assert!(msgs.to_string().contains("hello from ios"), "{msgs}");

    let (st, inbox) = get_json(&format!("{remote_url}/api/v1/slice/inbox?once=1"), Some(&token));
    assert_eq!(st, 200, "{inbox}");
    assert!(inbox["items"].is_array());

    let (initial_id, initial_board) = first_sse_event(&format!("{remote_url}/api/v1/slice/board"), &token, None);
    let initial_seq = initial_id.expect("SSE board slice carries id");
    assert_eq!(initial_board["seq"].to_string(), initial_seq);

    let mut resumed_reader = open_sse(&format!("{remote_url}/api/v1/slice/board"), &token, Some(&initial_seq));
    let (st, created_issue) = post_json(
        &format!("{remote_url}/api/v1/issue/create"),
        Some(&token),
        json!({ "title": "Mobile created task" }),
    );
    assert_eq!(st, 200, "{created_issue}");
    let (resumed_id, resumed_board) = next_sse_event(&mut resumed_reader);
    drop(resumed_reader);
    assert_ne!(resumed_id.as_deref(), Some(initial_seq.as_str()));
    assert!(resumed_board["issues"].to_string().contains("Mobile created task"), "{resumed_board}");

    let status_after = started.hub.call_as(Caller::User, "remote.status", json!({})).data.unwrap();
    assert!(status_after["devices"][0]["lastSeenAt"].as_i64().is_some());

    let disabled = started.hub.call_as(Caller::User, "remote.disable", json!({})).data.unwrap();
    assert_eq!(disabled["enabled"], false);
    assert_eq!(disabled["listening"], false);
    assert!(disabled.get("url").is_none());

    assert!(
        http_agent().post(format!("{remote_url}/api/v1/remote/whoami")).json(&json!({})).send().is_err(),
        "disabled remote listener must stop accepting TCP connections"
    );
    let (st, disabled_err) = post_json(&format!("{}/api/v1/issue/list", local_listener.url()), Some(&token), json!({}));
    assert_eq!(st, 401, "Bearer token on loopback must never fall back to LocalOwner: {disabled_err}");
    assert_eq!(disabled_err["bizCode"], BizCode::Unauthorized.code());

    let reenabled = started
        .hub
        .call_as(Caller::User, "remote.enable", json!({ "bindAddr": "127.0.0.1", "port": 0 }))
        .data
        .unwrap();
    let persisted_port = reenabled["port"].as_u64().unwrap();
    drop(local_listener);
    let weak = Arc::downgrade(&started.hub);
    started.close();
    drop(started);
    assert_eq!(weak.strong_count(), 0, "Hub must drop cleanly after Started::close");

    let reopened = start_server(dir.path());
    let restored = reopened.hub.call_as(Caller::User, "remote.status", json!({})).data.unwrap();
    assert_eq!(restored["enabled"], true);
    assert_eq!(restored["listening"], true);
    assert_eq!(restored["port"], persisted_port);
    reopened.close();
}

#[test]
fn remote_security_wall_rejects_privileged_ops_mcp_and_invalid_or_revoked_tokens() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let local_listener = serve(started.hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();

    for forbidden_ip in ["0.0.0.0", "8.8.8.8", "1.1.1.1", "::"] {
        let ip = forbidden_ip.parse::<IpAddr>().unwrap();
        assert!(!is_allowed_remote_ip(ip), "{forbidden_ip}");
        let err = started.hub.call_as(Caller::User, "remote.enable", json!({ "bindAddr": forbidden_ip }));
        assert_eq!(err.biz_code, BizCode::Refused.code(), "{forbidden_ip}: {err:?}");
        assert!(serve_remote(started.hub.clone(), SocketAddr::new(ip, 0)).is_err());
    }
    for allowed_ip in [
        "127.0.0.1",
        "::1",
        "100.64.0.1",
        "100.127.255.254",
        "10.0.0.5",
        "172.16.0.9",
        "192.168.1.42",
        "fd7a:115c:a1e0::1",
    ] {
        assert!(is_allowed_remote_ip(allowed_ip.parse::<IpAddr>().unwrap()), "{allowed_ip}");
    }

    let enabled = started
        .hub
        .call_as(Caller::User, "remote.enable", json!({ "bindAddr": "127.0.0.1", "port": 0 }))
        .data
        .unwrap();
    let remote_url = enabled["url"].as_str().unwrap().to_string();

    let (st, _) = post_json(&format!("{remote_url}/api/v1/issue/list"), None, json!({}));
    assert_eq!(st, 403);
    let (st, _) = get_json(&format!("{remote_url}/api/v1/slice/board?once=1"), None);
    assert_eq!(st, 403);

    let pair = started.hub.call_as(Caller::User, "remote.pair.create", json!({})).data.unwrap();
    let (st, paired) = post_json(
        &format!("{remote_url}/api/v1/remote/pair/exchange"),
        None,
        json!({ "code": pair["code"], "deviceName": "Test iPad", "platform": "ios" }),
    );
    assert_eq!(st, 200, "{paired}");
    let token = paired["data"]["token"].as_str().unwrap().to_string();
    let device_id = paired["data"]["device"]["id"].as_str().unwrap().to_string();

    for (op_path, payload) in [
        ("debug/snapshot", json!({})),
        ("setting/update", json!({ "locale": "en" })),
        ("remote/pair/create", json!({})),
        ("remote/device/revoke", json!({ "id": device_id })),
        ("remote/status", json!({})),
        ("remote/disable", json!({})),
        ("remote/enable", json!({})),
    ] {
        let (st, body) = post_json(&format!("{remote_url}/api/v1/{op_path}"), Some(&token), payload);
        assert_eq!(st, 403, "{op_path} must reject Caller::Remote: {body}");
        assert_eq!(body["bizCode"], BizCode::Forbidden.code(), "{op_path}: {body}");
    }

    let mcp_body = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" });
    let (st, _) = post_json(&format!("{remote_url}/mcp"), Some(&token), mcp_body.clone());
    assert_eq!(st, 403, "remote listener /mcp must be forbidden");
    let (st, _) = post_json(&format!("{remote_url}/mcp"), None, mcp_body.clone());
    assert_eq!(st, 403, "remote listener /mcp without auth must be forbidden");
    let (st, _) = post_json(&format!("{}/mcp", local_listener.url()), Some(&token), mcp_body);
    assert_eq!(st, 403, "loopback /mcp with vv_dev_ Bearer token must be forbidden");

    for bad_tok in [
        "vv_dev_0000000000000000000000000000000000000000000000000000000000000000",
        "not-a-valid-token",
        "",
    ] {
        let (st, body) = post_json(&format!("{}/api/v1/issue/list", local_listener.url()), Some(bad_tok), json!({}));
        assert_eq!(st, 401, "invalid token `{bad_tok}` on loopback must be 401: {body}");
        assert_eq!(body["bizCode"], BizCode::Unauthorized.code());
        assert_eq!(body["message"], t("server.remote.unauthorized", &[]));
    }

    let unknown = started.hub.call_as(Caller::User, "remote.device.revoke", json!({ "id": "dev_missing" }));
    assert_eq!(unknown.biz_code, BizCode::NotFound.code());
    assert_eq!(unknown.message, t("server.remote.deviceNotFound", &[]));

    let revoked = started.hub.call_as(Caller::User, "remote.device.revoke", json!({ "id": device_id }));
    assert_eq!(revoked.biz_code, 0, "{}", revoked.message);

    for base in [&remote_url, &local_listener.url()] {
        let (st, body) = post_json(&format!("{base}/api/v1/remote/whoami"), Some(&token), json!({}));
        assert_eq!(st, 401, "revoked token on {base} must be 401: {body}");
        assert_eq!(body["bizCode"], BizCode::Unauthorized.code());
        assert_eq!(body["message"], t("server.remote.revoked", &[]));
    }
    let (st, _) = get_json(&format!("{remote_url}/api/v1/slice/inbox?once=1"), Some(&token));
    assert_eq!(st, 401, "revoked token on slice endpoint must be 401");

    let ts = tailscale::parse_status_json(r#"{"BackendState":"Running","Self":{"DNSName":"mbp.tailnet.ts.net.","Online":true,"TailscaleIPs":["100.88.1.2"]}}"#)
        .unwrap();
    assert!(ts.online);
    assert_eq!(ts.ipv4.as_deref(), Some("100.88.1.2"));
    assert_eq!(ts.host.as_deref(), Some("mbp.tailnet.ts.net"));

    drop(local_listener);
    started.close();
}
