//! Public HTTPS policy shared by media download and library imports.
use std::net::Ipv4Addr;

/// `publicIpv4`.
pub(crate) fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}

/// `publicHttps`: https on 443, no credentials, no fragment, a name or a
/// public IPv4 address.
pub(crate) fn public_https(url: &url::Url) -> bool {
    let host_ok = match url.host() {
        Some(url::Host::Domain(_)) => true,
        Some(url::Host::Ipv4(ip)) => public_v4(ip),
        _ => false,
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port().is_none_or(|p| p == 443)
        && host_ok
}

#[cfg(test)]
mod tests {
    use super::public_https;
    #[test]
    fn download_addresses_cannot_reach_private_networks_or_carry_credentials() {
        for address in [
            "https://127.0.0.1/image",
            "https://[::ffff:7f00:1]/image",
            "https://10.0.0.2/image",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/",
            "https://192.168.0.1/",
            "file:///etc/passwd",
            "http://example.com/image",
            "https://user:secret@example.com/a",
            "https://example.com:8443/a",
            "https://example.com/a#fragment",
        ] {
            assert!(!public_https(&url::Url::parse(address).unwrap()), "{address}");
        }
        for address in ["https://example.com/image?signed=x", "https://8.8.8.8/image"] {
            assert!(public_https(&url::Url::parse(address).unwrap()));
        }
    }
}
