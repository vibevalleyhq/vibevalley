//! Pure-Rust non-loopback LAN IPv4 detection delegated to [`vibevalley_kit::net::gateway::remote`].

#[cfg(test)]
use std::net::Ipv4Addr;

pub use vibevalley_kit::net::gateway::remote::{detect_lan_ipv4, is_lan_ipv4, probe_lan_ipv4};

/// Selects the first valid private LAN IPv4 address from a list of probe candidates.
#[cfg(test)]
pub(crate) fn select_lan_ipv4(candidates: impl IntoIterator<Item = Option<Ipv4Addr>>) -> Option<Ipv4Addr> {
    candidates.into_iter().flatten().find(|ip| is_lan_ipv4(*ip))
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
