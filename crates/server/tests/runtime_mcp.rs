//! `runtime.mcp.*` endpoint contract & delegation tests.

use serde_json::{Value, json};
use vibevalley_protocol::Caller;
use vibevalley_server::{App, Config, Server, create_app_blocking};

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
