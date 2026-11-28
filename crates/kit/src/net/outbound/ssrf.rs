//! SSRF-safe public HTTPS downloader with IP/DNS validation, DNS pinning,
//! redirect re-validation, and streaming byte caps.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::client::{BoxFuture, Fetch, FetchError, Request, Response, execute_request_async, install_tls};

/// Returns `true` when `ip` is NOT globally routable (loopback, private RFC 1918,
/// CGNAT/Tailscale, link-local/cloud metadata, ULA, documentation, multicast, or reserved).
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => !is_public_v4(v4),
        IpAddr::V6(v6) => is_forbidden_v6(v6),
    }
}

/// Returns `true` when `ip` is globally routable IPv4 (not loopback, private,
/// link-local/metadata, CGNAT, documentation, benchmarking, multicast, or reserved).
pub fn is_public_v4(ip: Ipv4Addr) -> bool {
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

fn is_forbidden_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return !is_public_v4(v4);
    }
    let segs = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // Unique Local Address (fc00::/7)
        || (segs[0] & 0xfe00) == 0xfc00
        // Link-local unicast (fe80::/10)
        || (segs[0] & 0xffc0) == 0xfe80
        // Deprecated site-local (fec0::/10)
        || (segs[0] & 0xffc0) == 0xfec0
        // Documentation (2001:db8::/32)
        || (segs[0] == 0x2001 && segs[1] == 0x0db8)
        // NAT64 well-known prefix (64:ff9b::/96)
        || (segs[0] == 0x0064 && segs[1] == 0xff9b && segs[2] == 0 && segs[3] == 0 && segs[4] == 0 && segs[5] == 0)
        // IPv4-compatible deprecated (::/96)
        || (segs[0] == 0 && segs[1] == 0 && segs[2] == 0 && segs[3] == 0 && segs[4] == 0 && segs[5] == 0)
}

/// Returns `true` for HTTPS on port 443 without credentials or fragment and with a domain or public IPv4 host.
pub fn public_https(url: &url::Url) -> bool {
    let host_ok = match url.host() {
        Some(url::Host::Domain(_)) => true,
        Some(url::Host::Ipv4(ip)) => is_public_v4(ip),
        _ => false,
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port().is_none_or(|p| p == 443)
        && host_ok
}

/// Resolves a redirect `location` against `current` and validates that the target
/// still satisfies [`public_https`] (blocking scheme downgrades, private IPs, and credentials).
pub fn validate_public_redirect(current: &url::Url, location: &str) -> Result<url::Url, String> {
    let target = current.join(location.trim()).map_err(|e| format!("invalid redirect location: {e}"))?;
    if !public_https(&target) {
        return Err(format!("redirect target rejected by SSRF guard: {target}"));
    }
    Ok(target)
}

/// Validates that a DNS resolution set is non-empty and contains only globally routable IPv4 addresses.
pub fn validate_resolved_addrs(addrs: &[SocketAddr]) -> Result<(), String> {
    if addrs.is_empty() || addrs.iter().any(|a| !matches!(a.ip(), IpAddr::V4(ip) if !is_forbidden_ip(IpAddr::V4(ip)))) {
        return Err("Public IPv4 resolution required".to_string());
    }
    Ok(())
}

/// Resolves `host:443` and rejects any response that is empty or includes a non-public IP address.
pub async fn resolve_public_v4(host: &str) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "Public IPv4 resolution required".to_string())?
        .collect();
    validate_resolved_addrs(&addrs)?;
    Ok(addrs)
}

/// Builds a `reqwest::Client` pinned to `addrs` with proxies and automatic redirects disabled.
pub fn pinned_public_client(host: &str, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    install_tls();
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|e| e.to_string())
}

/// Bound-DNS public HTTPS fetcher: resolves the host to public IPv4 addresses
/// once and pins `reqwest` to those exact addresses with redirects and proxies disabled.
pub struct PublicDownload;

pub struct PublicBytes {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub url: url::Url,
}

#[derive(Debug)]
pub enum PublicDownloadError {
    BadUrl,
    Dns(String),
    Timeout,
    HttpStatus(u16),
    TooLarge,
    Network(String),
}

impl fmt::Display for PublicDownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadUrl => f.write_str("not a public https address"),
            Self::Dns(msg) => write!(f, "dns resolution failed: {msg}"),
            Self::Timeout => f.write_str("download timed out"),
            Self::HttpStatus(code) => write!(f, "unexpected http status {code}"),
            Self::TooLarge => f.write_str("download exceeds maximum allowed size"),
            Self::Network(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for PublicDownloadError {}

impl PublicDownload {
    /// Downloads a public HTTPS resource asynchronously with bound-DNS pinning,
    /// enforcing `timeout`, HTTP 200, and `max_bytes` (redirects disabled).
    pub async fn get_bytes_async(address: &str, timeout: Duration, max_bytes: usize) -> Result<PublicBytes, PublicDownloadError> {
        Self::get_bytes_with_redirects_async(address, timeout, max_bytes, 0).await
    }

    /// Downloads a public HTTPS resource, re-validating [`public_https`] and re-pinning
    /// DNS on every redirect hop up to `max_redirects`.
    pub async fn get_bytes_with_redirects_async(
        address: &str,
        timeout: Duration,
        max_bytes: usize,
        max_redirects: usize,
    ) -> Result<PublicBytes, PublicDownloadError> {
        let mut url = url::Url::parse(address).map_err(|_| PublicDownloadError::BadUrl)?;
        if !public_https(&url) {
            return Err(PublicDownloadError::BadUrl);
        }

        let mut hops = 0usize;
        loop {
            let host = url.host_str().ok_or(PublicDownloadError::BadUrl)?.to_string();
            let addrs = tokio::time::timeout(timeout, resolve_public_v4(&host))
                .await
                .map_err(|_| PublicDownloadError::Timeout)?
                .map_err(PublicDownloadError::Dns)?;
            let client = pinned_public_client(&host, &addrs).map_err(PublicDownloadError::Network)?;
            let mut response = client.get(url.clone()).timeout(timeout).send().await.map_err(|e| {
                if e.is_timeout() {
                    PublicDownloadError::Timeout
                } else {
                    PublicDownloadError::Network(e.to_string())
                }
            })?;
            let status = response.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) && hops < max_redirects {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or(PublicDownloadError::HttpStatus(status))?;
                url = validate_public_redirect(&url, location).map_err(|_| PublicDownloadError::BadUrl)?;
                hops += 1;
                continue;
            }
            if status != 200 {
                return Err(PublicDownloadError::HttpStatus(status));
            }
            let media_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
                .unwrap_or_default();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| {
                if e.is_timeout() {
                    PublicDownloadError::Timeout
                } else {
                    PublicDownloadError::Network(e.to_string())
                }
            })? {
                if bytes.len() + chunk.len() > max_bytes {
                    return Err(PublicDownloadError::TooLarge);
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(PublicBytes { bytes, media_type, url });
        }
    }

    pub async fn fetch_async(r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
        if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(FetchError::Network("cancelled".into()));
        }
        let parsed = url::Url::parse(&r.url).map_err(|e| FetchError::Network(e.to_string()))?;
        if !public_https(&parsed) {
            return Err(FetchError::Network("not a public https address".into()));
        }
        let host = parsed.host_str().ok_or_else(|| FetchError::Network("missing host".into()))?.to_string();
        let timeout = r.timeout;
        let resolve = async {
            tokio::time::timeout(timeout, resolve_public_v4(&host))
                .await
                .map_err(|_| FetchError::Timeout)?
                .map_err(FetchError::Network)
        };
        let addrs = match &cancel {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => return Err(FetchError::Network("cancelled".into())),
                res = resolve => res?,
            },
            None => resolve.await?,
        };
        let client = pinned_public_client(&host, &addrs).map_err(FetchError::Network)?;
        execute_request_async(client, r, cancel).await
    }
}

impl Fetch for PublicDownload {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> BoxFuture<'static, Result<Response, FetchError>> {
        Box::pin(Self::fetch_async(request, Some(cancel)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden_ip_blocks_loopback_private_link_local_metadata_cgnat_and_ipv6_local() {
        for forbidden in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.254",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "203.0.113.5",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::10.0.0.1",
        ] {
            let ip: IpAddr = forbidden.parse().unwrap();
            assert!(is_forbidden_ip(ip), "{forbidden} must be forbidden");
        }

        for allowed in ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] {
            let ip: IpAddr = allowed.parse().unwrap();
            assert!(!is_forbidden_ip(ip), "{allowed} must be allowed");
        }
    }

    #[test]
    fn resolved_addr_validation_rejects_empty_and_mixed_private_results() {
        assert!(validate_resolved_addrs(&[]).is_err());
        assert!(validate_resolved_addrs(&["8.8.8.8:443".parse().unwrap(), "169.254.169.254:443".parse().unwrap()]).is_err());
        assert!(validate_resolved_addrs(&["[::1]:443".parse().unwrap()]).is_err());
        assert!(validate_resolved_addrs(&["8.8.8.8:443".parse().unwrap(), "1.1.1.1:443".parse().unwrap()]).is_ok());
    }

    #[test]
    fn redirect_revalidation_blocks_ssrf_downgrades_and_allows_public_https() {
        let base = url::Url::parse("https://cdn.example.com/assets/a.png").unwrap();

        let rel = validate_public_redirect(&base, "/assets/b.png").unwrap();
        assert_eq!(rel.as_str(), "https://cdn.example.com/assets/b.png");

        let abs = validate_public_redirect(&base, "https://images.example.org/b.png?sig=1").unwrap();
        assert_eq!(abs.as_str(), "https://images.example.org/b.png?sig=1");

        for bad in [
            "http://cdn.example.com/downgrade",
            "https://127.0.0.1/admin",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.5/internal",
            "https://[::ffff:127.0.0.1]/loopback",
            "https://user:pass@cdn.example.com/secret",
            "https://cdn.example.com:8443/alt-port",
            "https://cdn.example.com/a#frag",
            "file:///etc/passwd",
        ] {
            assert!(validate_public_redirect(&base, bad).is_err(), "redirect to {bad} must fail");
        }
    }

    #[tokio::test]
    async fn public_download_rejects_private_metadata_and_non_https_urls() {
        for bad in [
            "https://127.0.0.1/image",
            "https://169.254.169.254/latest",
            "https://10.0.0.2/image",
            "https://192.168.0.1/",
            "http://example.com/image",
            "https://user:secret@example.com/a",
        ] {
            assert!(
                matches!(
                    PublicDownload::get_bytes_async(bad, Duration::from_secs(1), 1024).await,
                    Err(PublicDownloadError::BadUrl)
                ),
                "{bad} must be rejected"
            );
        }
    }
}
