//! Pure-Rust non-loopback LAN IPv4 detection via stdlib UDP routing probes.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

const DEFAULT_ROUTE_TARGETS: &[&str] = &["1.1.1.1:80", "8.8.8.8:80"];
const PRIVATE_ROUTE_TARGETS: &[&str] = &["192.168.1.1:80", "10.0.0.1:80", "172.16.0.1:80"];

/// True for private RFC1918 LAN IPv4 addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`),
/// excluding loopback, link-local (`169.254.0.0/16`), unspecified, and Tailscale CGNAT (`100.64.0.0/10`).
pub fn is_lan_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private()
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_unspecified()
        && !super::tailscale::is_tailscale_ipv4(ip)
}

fn probe_udp_local_ipv4(target: &str) -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    // UDP connect only queries the kernel routing table; no packets are transmitted.
    socket.connect(target).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if is_lan_ipv4(ip) => Some(ip),
        _ => None,
    }
}

/// Selects the first valid private LAN IPv4 address from a list of probe candidates.
#[cfg(test)]
pub(crate) fn select_lan_ipv4(candidates: impl IntoIterator<Item = Option<Ipv4Addr>>) -> Option<Ipv4Addr> {
    candidates.into_iter().flatten().find(|ip| is_lan_ipv4(*ip))
}

/// Detects the machine's primary non-loopback LAN IPv4 address without spawning external CLIs.
pub fn probe_lan_ipv4() -> Option<Ipv4Addr> {
    for target in DEFAULT_ROUTE_TARGETS.iter().chain(PRIVATE_ROUTE_TARGETS.iter()) {
        if let Some(ip) = probe_udp_local_ipv4(target) {
            return Some(ip);
        }
    }
    None
}

/// Detects the primary non-loopback LAN IPv4 address as a formatted string.
pub fn detect_lan_ipv4() -> Option<String> {
    probe_lan_ipv4().map(|ip| ip.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_rfc1918_lan_ipv4_and_rejects_loopback_cgnat_and_public() {
        assert!(is_lan_ipv4(Ipv4Addr::new(10, 0, 0, 5)));
        assert!(is_lan_ipv4(Ipv4Addr::new(172, 16, 0, 1)));
        assert!(is_lan_ipv4(Ipv4Addr::new(172, 31, 255, 254)));
        assert!(is_lan_ipv4(Ipv4Addr::new(192, 168, 1, 42)));

        assert!(!is_lan_ipv4(Ipv4Addr::LOCALHOST));
        assert!(!is_lan_ipv4(Ipv4Addr::UNSPECIFIED));
        assert!(!is_lan_ipv4(Ipv4Addr::new(169, 254, 10, 20)));
        assert!(!is_lan_ipv4(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!is_lan_ipv4(Ipv4Addr::new(100, 127, 255, 254)));
        assert!(!is_lan_ipv4(Ipv4Addr::new(172, 15, 255, 255)));
        assert!(!is_lan_ipv4(Ipv4Addr::new(172, 32, 0, 1)));
        assert!(!is_lan_ipv4(Ipv4Addr::new(8, 8, 8, 8)));
    }

    #[test]
    fn select_lan_ipv4_skips_loopback_and_tailscale_candidates() {
        let chosen = select_lan_ipv4([
            None,
            Some(Ipv4Addr::LOCALHOST),
            Some(Ipv4Addr::new(100, 64, 1, 23)),
            Some(Ipv4Addr::new(192, 168, 50, 12)),
            Some(Ipv4Addr::new(10, 0, 0, 8)),
        ]);
        assert_eq!(chosen, Some(Ipv4Addr::new(192, 168, 50, 12)));

        let none = select_lan_ipv4([Some(Ipv4Addr::LOCALHOST), Some(Ipv4Addr::new(100, 99, 1, 2))]);
        assert_eq!(none, None);
    }

    #[test]
    fn probe_lan_ipv4_never_returns_loopback_or_tailscale() {
        if let Some(ip) = probe_lan_ipv4() {
            assert!(is_lan_ipv4(ip), "probed IP {ip} must be valid LAN IPv4");
            assert!(!ip.is_loopback());
            assert!(!super::super::tailscale::is_tailscale_ipv4(ip));
        }
    }
}
