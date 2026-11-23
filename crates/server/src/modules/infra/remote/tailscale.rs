//! Local Tailscale status probe (`tailscale status --json`) with a short bounded timeout.

use std::net::Ipv4Addr;
use std::time::Duration;

use serde::Deserialize;

const PROBE_TIMEOUT: Duration = Duration::from_millis(1200);
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const CANDIDATE_PATHS: &[&str] = &[
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
];

/// Parsed summary of the local machine's Tailscale node.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TailscaleInfo {
    pub online: bool,
    pub ipv4: Option<String>,
    pub host: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawTailscaleStatus {
    #[serde(rename = "BackendState", default)]
    backend_state: String,
    #[serde(rename = "TailscaleIPs", default)]
    tailscale_ips: Vec<String>,
    #[serde(rename = "Self")]
    self_peer: Option<RawSelfPeer>,
}

#[derive(Debug, Deserialize)]
struct RawSelfPeer {
    #[serde(rename = "DNSName", default)]
    dns_name: String,
    #[serde(rename = "HostName", default)]
    host_name: String,
    #[serde(rename = "Online")]
    online: Option<bool>,
    #[serde(rename = "TailscaleIPs", default)]
    tailscale_ips: Vec<String>,
}

/// True for Tailscale's CGNAT IPv4 range (`100.64.0.0/10`).
pub fn is_tailscale_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (octets[1] & 0b1100_0000) == 64
}

fn first_tailscale_ipv4<'a>(ips: impl IntoIterator<Item = &'a str>) -> Option<String> {
    ips.into_iter()
        .filter_map(|raw| raw.trim().parse::<Ipv4Addr>().ok())
        .find(|ip| is_tailscale_ipv4(*ip))
        .map(|ip| ip.to_string())
}

fn clean_host(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('.');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Parses `tailscale status --json` output into a typed [`TailscaleInfo`].
pub fn parse_status_json(raw: &str) -> Result<TailscaleInfo, serde_json::Error> {
    let parsed: RawTailscaleStatus = serde_json::from_str(raw)?;
    let self_ips = parsed.self_peer.as_ref().map(|p| p.tailscale_ips.as_slice()).unwrap_or(&[]);
    let ipv4 = first_tailscale_ipv4(self_ips.iter().chain(parsed.tailscale_ips.iter()).map(String::as_str));
    let host = parsed
        .self_peer
        .as_ref()
        .and_then(|peer| clean_host(&peer.dns_name).or_else(|| clean_host(&peer.host_name)));
    let self_online = parsed.self_peer.as_ref().and_then(|p| p.online).unwrap_or(true);
    let online = parsed.backend_state.eq_ignore_ascii_case("Running") && self_online && ipv4.is_some();
    Ok(TailscaleInfo { online, ipv4, host })
}

async fn run_tailscale_status_async(bin: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["status", "--json"]);
    let output = vibevalley_runtime::oar::run_output_with_timeout(cmd, PROBE_TIMEOUT, Some(MAX_OUTPUT_BYTES))
        .await
        .ok()?;
    output.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Probes the local Tailscale CLI asynchronously without panicking when Tailscale is missing or stopped.
pub async fn probe_async() -> TailscaleInfo {
    for candidate in CANDIDATE_PATHS {
        if tokio::fs::metadata(candidate).await.is_ok_and(|m| m.is_file()) {
            return run_tailscale_status_async(candidate)
                .await
                .and_then(|raw| parse_status_json(&raw).ok())
                .unwrap_or_default();
        }
    }
    run_tailscale_status_async("tailscale")
        .await
        .and_then(|raw| parse_status_json(&raw).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_running_tailscale_status_with_trailing_dot_dns_and_ipv6() {
        let json = r#"{
            "BackendState": "Running",
            "Self": {
                "DNSName": "studio-mac.tail98ab1.ts.net.",
                "HostName": "studio-mac",
                "Online": true,
                "TailscaleIPs": ["fd7a:115c:a1e0::42", "100.99.221.58"]
            }
        }"#;
        let info = parse_status_json(json).unwrap();
        assert_eq!(
            info,
            TailscaleInfo {
                online: true,
                ipv4: Some("100.99.221.58".into()),
                host: Some("studio-mac.tail98ab1.ts.net".into()),
            }
        );
    }

    #[test]
    fn parses_stopped_and_offline_states_without_marking_online() {
        let stopped = r#"{
            "BackendState": "Stopped",
            "Self": {
                "DNSName": "",
                "HostName": "my-mac",
                "Online": false,
                "TailscaleIPs": ["100.64.0.1"]
            }
        }"#;
        let info = parse_status_json(stopped).unwrap();
        assert!(!info.online);
        assert_eq!(info.ipv4.as_deref(), Some("100.64.0.1"));
        assert_eq!(info.host.as_deref(), Some("my-mac"));

        let top_level_ip = r#"{
            "BackendState": "Running",
            "TailscaleIPs": ["192.168.1.5", "100.127.255.254"]
        }"#;
        let info = parse_status_json(top_level_ip).unwrap();
        assert!(info.online);
        assert_eq!(info.ipv4.as_deref(), Some("100.127.255.254"));
        assert_eq!(info.host, None);
    }

    #[test]
    fn rejects_non_cgnat_ipv4_addresses() {
        assert!(is_tailscale_ipv4(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_tailscale_ipv4(Ipv4Addr::new(100, 127, 255, 254)));
        assert!(!is_tailscale_ipv4(Ipv4Addr::new(100, 63, 255, 255)));
        assert!(!is_tailscale_ipv4(Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_tailscale_ipv4(Ipv4Addr::new(192, 168, 1, 10)));
        assert!(!is_tailscale_ipv4(Ipv4Addr::new(127, 0, 0, 1)));

        let only_lan = r#"{
            "BackendState": "Running",
            "Self": { "Online": true, "TailscaleIPs": ["192.168.1.10", "100.63.0.1"] }
        }"#;
        let info = parse_status_json(only_lan).unwrap();
        assert!(!info.online);
        assert_eq!(info.ipv4, None);
    }
}
