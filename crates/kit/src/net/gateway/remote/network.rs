use std::net::{IpAddr, Ipv4Addr, UdpSocket};

const DEFAULT_ROUTE_TARGETS: &[&str] = &["1.1.1.1:80", "8.8.8.8:80"];
const PRIVATE_ROUTE_TARGETS: &[&str] = &["192.168.1.1:80", "10.0.0.1:80", "172.16.0.1:80"];

/// Extracts the token from an HTTP `Authorization: Bearer <token>` header value.
///
/// Returns `Some("")` when the header is bare `"Bearer"` (case-insensitive) so callers
/// can distinguish an empty Bearer attempt from an absent Authorization header.
pub fn parse_bearer_header(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("bearer") {
        return Some("");
    }
    let (scheme, token) = trimmed.split_once(char::is_whitespace)?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

/// Returns `true` when `host` is a loopback host (`127.0.0.1`, `localhost`, `[::1]`)
/// with an optional numeric `:port` suffix.
pub fn is_loopback_host(host: &str) -> bool {
    let Some(rest) = host
        .strip_prefix("127.0.0.1")
        .or_else(|| host.strip_prefix("localhost"))
        .or_else(|| host.strip_prefix("[::1]"))
    else {
        return false;
    };
    match rest.strip_prefix(':') {
        None => rest.is_empty(),
        Some(port) => !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// Validates that an HTTP request originates from the local loopback host with matching
/// `Origin` (when present) and safe `Sec-Fetch-Site` (`same-origin` or `none`, when present).
pub fn is_same_origin_loopback(host: &str, origin: Option<&str>, sec_fetch_site: Option<&str>) -> bool {
    let origin_ok = origin.is_none_or(|o| o == format!("http://{host}"));
    let site_ok = sec_fetch_site.is_none_or(|s| s == "same-origin" || s == "none");
    is_loopback_host(host) && origin_ok && site_ok
}

/// True for RFC 6598 CGNAT IPv4 range (`100.64.0.0/10`, used by Tailscale).
pub fn is_cgnat_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (octets[1] & 0b1100_0000) == 64
}

/// True for private RFC 1918 LAN IPv4 addresses (`10/8`, `172.16/12`, `192.168/16`),
/// excluding loopback, link-local, unspecified, and CGNAT (`100.64.0.0/10`).
pub fn is_lan_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !is_cgnat_ipv4(ip)
}

/// True for addresses safe for a local/private remote listener: loopback, RFC 1918
/// private LAN IPv4, CGNAT IPv4 (`100.64.0.0/10`), or IPv6 ULA (`fc00::/7`).
pub fn is_allowed_private_bind_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || is_cgnat_ipv4(v4),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
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

/// Detects the machine's primary non-loopback LAN IPv4 address via kernel routing probes.
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
    fn bearer_and_loopback_guards_work() {
        assert_eq!(parse_bearer_header("Bearer abc123"), Some("abc123"));
        assert_eq!(parse_bearer_header("  bearer   tok  "), Some("tok"));
        assert_eq!(parse_bearer_header("Bearer"), Some(""));
        assert_eq!(parse_bearer_header("Basic dXNlcjpwYXNz"), None);

        assert!(is_loopback_host("127.0.0.1:8790"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("[::1]:8080"));
        assert!(!is_loopback_host("127.0.0.1.evil.com"));
        assert!(!is_loopback_host("localhost:abc"));

        assert!(is_same_origin_loopback("127.0.0.1:8790", Some("http://127.0.0.1:8790"), Some("same-origin")));
        assert!(!is_same_origin_loopback("127.0.0.1:8790", Some("https://evil.example"), Some("same-origin")));
        assert!(!is_same_origin_loopback("127.0.0.1:8790", None, Some("cross-site")));
    }

    #[test]
    fn ip_classifiers_distinguish_lan_cgnat_and_public() {
        assert!(is_cgnat_ipv4(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!is_cgnat_ipv4(Ipv4Addr::new(192, 168, 1, 1)));
        assert!(is_lan_ipv4(Ipv4Addr::new(192, 168, 1, 1)));
        assert!(!is_lan_ipv4(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!is_lan_ipv4(Ipv4Addr::LOCALHOST));
        assert!(is_allowed_private_bind_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_allowed_private_bind_ip(IpAddr::V4(Ipv4Addr::new(100, 100, 1, 2))));
        assert!(!is_allowed_private_bind_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }
}
