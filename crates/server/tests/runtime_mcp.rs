//! `runtime.mcp.*` endpoint contract & delegation tests.

use crate::support::{RouterTestExt as _, ServerTestExt as _};
use serde_json::{Value, json};
use vibevalley_protocol::Caller;
use vibevalley_server::{App, Config, create_app_blocking};

fn app(dir: &std::path::Path) -> App {
    create_app_blocking(Config {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..Config::under(dir)
    })
    .unwrap()
}

#[test]
fn runtime_mcp_list_returns_all_four_oar_hosts_and_snippets() {
    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());
    started.set_mcp_url("http://127.0.0.1:8790/mcp");

    let list_res = serde_json::to_value(started.router().call("runtime.mcp.list", json!({}))).unwrap();
    assert_eq!(list_res["bizCode"], 0, "{list_res}");
    let data = &list_res["data"];
    assert_eq!(data["serverName"], "vibevalley");
    assert_eq!(data["stdioCommand"], "vibevalley");
    assert_eq!(data["httpUrl"], "http://127.0.0.1:8790/mcp");

    let hosts = data["hosts"].as_array().expect("hosts array");
    let ids: Vec<&str> = hosts.iter().filter_map(|h| h["id"].as_str()).collect();
    assert_eq!(ids, vec!["antigravity", "claude", "codex", "cursor"]);

    for host in hosts {
        assert_eq!(host["supportsStdio"], true);
        assert_eq!(host["supportsHttp"], true);
        let stdio = host["stdioSnippet"].as_str().unwrap();
        let http = host["httpSnippet"].as_str().unwrap();
        assert!(stdio.contains("vibevalley"));
        assert!(http.contains("http://127.0.0.1:8790/mcp"));
        if host["id"] == "codex" {
            assert!(stdio.contains("[mcp_servers.vibevalley]"));
            assert!(http.contains("[mcp_servers.vibevalley]"));
        } else {
            let parsed: Value = serde_json::from_str(stdio).unwrap();
            assert!(parsed["mcpServers"]["vibevalley"]["command"].is_string());
            let parsed_http: Value = serde_json::from_str(http).unwrap();
            assert_eq!(parsed_http["mcpServers"]["vibevalley"]["url"], "http://127.0.0.1:8790/mcp");
        }
    }

    // Remote caller can list, but cannot install or uninstall.
    let remote_list = serde_json::to_value(
        started
            .router()
            .call_as(Caller::Remote, "runtime.mcp.list", json!({ "transport": "streamableHttp" })),
    )
    .unwrap();
    assert_eq!(remote_list["bizCode"], 0);
    let remote_install = serde_json::to_value(started.router().call_as(Caller::Remote, "runtime.mcp.install", json!({ "host": "claude" }))).unwrap();
    assert_eq!(remote_install["bizCode"], 200002);
    let remote_uninstall = serde_json::to_value(started.router().call_as(Caller::Remote, "runtime.mcp.uninstall", json!({ "host": "claude" }))).unwrap();
    assert_eq!(remote_uninstall["bizCode"], 200002);

    // Invalid host id is rejected at the boundary.
    let bad_host = serde_json::to_value(started.router().call("runtime.mcp.install", json!({ "host": "unknown" }))).unwrap();
    assert_eq!(bad_host["bizCode"], 100001);

    started.close_blocking();
}

#[test]
fn runtime_mcp_server_crud_and_probe_populate_inventory_for_hosts() {
    struct HomeGuard(Option<std::ffi::OsString>);
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.0 {
                    Some(prev) => std::env::set_var("HOME", prev),
                    None => std::env::remove_var("HOME"),
                }
            }
        }
    }

    let prev_home = std::env::var_os("HOME");
    let _guard = HomeGuard(prev_home);
    let fake_home = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("HOME", fake_home.path());
    }

    // Seed Antigravity (~/.gemini/config/mcp_config.json) before server boot.
    let agy_cfg = fake_home.path().join(".gemini/config/mcp_config.json");
    std::fs::create_dir_all(agy_cfg.parent().unwrap()).unwrap();
    std::fs::write(
        &agy_cfg,
        r#"{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "linear": { "serverUrl": "https://mcp.linear.app/mcp", "disabled": true }
  }
}"#,
    )
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());

    // 1. runtime.mcpServer.list reads the real Antigravity config via OAR.
    let listed = serde_json::to_value(started.router().call("runtime.mcpServer.list", json!({ "host": "antigravity" }))).unwrap();
    assert_eq!(listed["bizCode"], 0, "{listed}");
    let servers = listed["data"]["servers"].as_array().unwrap();
    assert_eq!(servers.len(), 2);
    assert_eq!(servers[0]["name"], "github");
    assert_eq!(servers[0]["transport"], "stdio");
    assert_eq!(servers[0]["enabled"], true);
    assert_eq!(servers[1]["name"], "linear");
    assert_eq!(servers[1]["transport"], "streamableHttp");
    assert_eq!(servers[1]["url"], "https://mcp.linear.app/mcp");
    assert_eq!(servers[1]["enabled"], false);

    // 2. runtime.mcpServer.save adds a Codex server and preserves TOML formatting.
    let saved = serde_json::to_value(started.router().call(
        "runtime.mcpServer.save",
        json!({
            "host": "codex",
            "name": "context7",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@upstash/context7-mcp"],
            "env": { "API_KEY": "secret" },
            "headers": {},
            "enabled": true
        }),
    ))
    .unwrap();
    assert_eq!(saved["bizCode"], 0, "{saved}");
    assert_eq!(saved["data"]["servers"].as_array().unwrap().len(), 1);
    assert_eq!(saved["data"]["servers"][0]["name"], "context7");

    // 3. runtime.mcpServer.toggle disables and re-enables the server in place.
    let toggled = serde_json::to_value(
        started
            .router()
            .call("runtime.mcpServer.toggle", json!({ "host": "codex", "name": "context7", "enabled": false })),
    )
    .unwrap();
    assert_eq!(toggled["bizCode"], 0, "{toggled}");
    assert_eq!(toggled["data"]["servers"][0]["enabled"], false);

    // 4. Remote caller can list, but cannot save, toggle, or remove.
    let remote_list = serde_json::to_value(started.router().call_as(Caller::Remote, "runtime.mcpServer.list", json!({ "host": "codex" }))).unwrap();
    assert_eq!(remote_list["bizCode"], 0);
    let remote_save = serde_json::to_value(started.router().call_as(
        Caller::Remote,
        "runtime.mcpServer.save",
        json!({
            "host": "codex",
            "name": "x",
            "transport": "stdio",
            "command": "npx",
            "args": [],
            "env": {},
            "headers": {},
            "enabled": true
        }),
    ))
    .unwrap();
    assert_eq!(remote_save["bizCode"], 200002);
    let remote_toggle = serde_json::to_value(started.router().call_as(
        Caller::Remote,
        "runtime.mcpServer.toggle",
        json!({ "host": "codex", "name": "context7", "enabled": true }),
    ))
    .unwrap();
    assert_eq!(remote_toggle["bizCode"], 200002);
    let remote_remove = serde_json::to_value(started.router().call_as(
        Caller::Remote,
        "runtime.mcpServer.remove",
        json!({ "host": "codex", "name": "context7" }),
    ))
    .unwrap();
    assert_eq!(remote_remove["bizCode"], 200002);

    // 5. runtime.mcpServer.remove deletes the server cleanly.
    let removed = serde_json::to_value(
        started
            .router()
            .call("runtime.mcpServer.remove", json!({ "host": "codex", "name": "context7" })),
    )
    .unwrap();
    assert_eq!(removed["bizCode"], 0, "{removed}");
    assert!(removed["data"]["servers"].as_array().unwrap().is_empty());

    started.close_blocking();
}
