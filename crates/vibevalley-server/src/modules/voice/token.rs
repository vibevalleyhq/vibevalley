//! Agora's AccessToken2 ("007") for one account in one channel: the RTC
//! service with every publisher privilege and the RTM login, as
//! `RtcTokenBuilder.buildTokenWithRtm` of `agora-token` builds it. The grant
//! the client joins with, the agent's own token and the ConvoAI REST calls'
//! `Authorization` are all this token.

use std::io::Write;

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::modules::setting::Secret;

const RTC: u16 = 1;
const RTM: u16 = 2;
/// Join, publish audio, publish video, publish data.
const RTC_PRIVILEGES: [u16; 4] = [1, 2, 3, 4];
const RTM_LOGIN: u16 = 1;

/// An app id or certificate that is not 32 hex characters: Agora's builder
/// answers such with an empty token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadCredentials;

impl std::fmt::Display for BadCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the App ID and the App Certificate must each be 32 hex characters")
    }
}

/// When a token is issued and its salt (1..=99999999).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Issue {
    pub at_seconds: u32,
    pub salt: u32,
}

impl Issue {
    pub fn now() -> Issue {
        let salt = uuid::Uuid::new_v4().as_u128() % 99_999_999;
        Issue {
            at_seconds: (crate::now() / 1000) as u32,
            salt: salt as u32 + 1,
        }
    }
}

fn hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |with: u8| block.map(|b| b ^ with);
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(message).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn put_service(out: &mut Vec<u8>, kind: u16, privileges: &[u16], expire: u32) {
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&(privileges.len() as u16).to_le_bytes());
    for p in privileges {
        out.extend_from_slice(&p.to_le_bytes());
        out.extend_from_slice(&expire.to_le_bytes());
    }
}

/// The signature and what it signs, before compression: what a token says.
pub fn content(app_id: &str, certificate: &Secret, channel: &str, account: &str, expire_seconds: u32, issue: Issue) -> Result<Vec<u8>, BadCredentials> {
    if !hex32(app_id) || !hex32(certificate.expose()) {
        return Err(BadCredentials);
    }
    // The key is the issue time then the salt; the certificate is the message.
    let signing = hmac(
        &issue.salt.to_le_bytes(),
        &hmac(&issue.at_seconds.to_le_bytes(), certificate.expose().as_bytes()),
    );
    let mut info = Vec::new();
    put_bytes(&mut info, app_id.as_bytes());
    info.extend_from_slice(&issue.at_seconds.to_le_bytes());
    info.extend_from_slice(&expire_seconds.to_le_bytes());
    info.extend_from_slice(&issue.salt.to_le_bytes());
    info.extend_from_slice(&2u16.to_le_bytes());
    put_service(&mut info, RTC, &RTC_PRIVILEGES, expire_seconds);
    put_bytes(&mut info, channel.as_bytes());
    put_bytes(&mut info, account.as_bytes());
    put_service(&mut info, RTM, &[RTM_LOGIN], expire_seconds);
    put_bytes(&mut info, account.as_bytes());
    let mut out = Vec::new();
    put_bytes(&mut out, &hmac(&signing, &info));
    out.extend_from_slice(&info);
    Ok(out)
}

/// The token: `007` and the zlib-compressed content in base64.
pub fn rtc_with_rtm(app_id: &str, certificate: &Secret, channel: &str, account: &str, expire_seconds: u32, issue: Issue) -> Result<Secret, BadCredentials> {
    let content = content(app_id, certificate, channel, account, expire_seconds, issue)?;
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let compressed = z.write_all(&content).and_then(|()| z.finish()).unwrap_or_default();
    Ok(Secret::new(format!("007{}", base64::engine::general_purpose::STANDARD.encode(compressed))))
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    const APP: &str = "11111111111111111111111111111111";
    const CERTIFICATE: &str = "22222222222222222222222222222222";

    /// `RtcTokenBuilder.buildTokenWithRtm(app, certificate, channel, account, PUBLISHER, expire, expire)`
    /// of agora-token 2.0.7 (what `packages/provider/src/agora/server.ts` `sign` called), its clock
    /// and salt held: (issued, salt, channel, account, expire, token).
    const VECTORS: [(u32, u32, &str, &str, u32, &str); 3] = [
        (
            1_800_000_000,
            12_345_678,
            "parity-channel",
            "10001",
            3600,
            "007eJxTYNh4hst/4QL/hc3rW9Z6Jpu+CJO8d+u3dZfKpuemNi4HHTUUGAwJAIZLntkCfAwMfol7GJgYGBlYGBgZQHwmMMkMJlnAJB9DQWJRZkmlbnJGYl5eag4rg6GBgYEhSBNEC1QAAHy7IWw=",
        ),
        (
            1_111_111,
            1,
            "vibevalley-1800000000000-ab12cd",
            "123456",
            86400,
            "007eJxTYPjx8kRV947P31iYfr289n9xmVDo7SyuNSxXVKbd4LjuqrtTgcGQAHD/IsDQEMjIwMjAwMDEwMjAAmSB+ExgkhlMsoBJeYayzKTUssScnNRKXUMLAwTQTUwyNEpOYWMwNDI2MTUDGQMxBCYCADT9KjI=",
        ),
        (
            1_800_000_123,
            99_999_999,
            "stop",
            "0",
            86400,
            "007eJxTYIgO+P9G/NjNjoMvdM8en7tjQYf61OXV6hWvDNz1EiKzHnIqMBgSANWXPLMbAhkZ/j/4ysrEwMjAwsDIAOIzgUlmMMkCJYtL8gsYGQxAyiCKGBkMAJaDIzw=",
        ),
    ];

    fn inflated(token: &str) -> Vec<u8> {
        let compressed = base64::engine::general_purpose::STANDARD.decode(token.strip_prefix("007").unwrap()).unwrap();
        let mut out = Vec::new();
        flate2::read::ZlibDecoder::new(&compressed[..]).read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn a_token_says_what_agoras_builder_says() {
        for (at_seconds, salt, channel, account, expire, theirs) in VECTORS {
            let issue = Issue { at_seconds, salt };
            let certificate = Secret::new(CERTIFICATE);
            let ours = content(APP, &certificate, channel, account, expire, issue).unwrap();
            assert_eq!(ours, inflated(theirs), "{channel}");
            // The compressed bytes differ by the zlib used; what they inflate to is the token.
            let token = rtc_with_rtm(APP, &certificate, channel, account, expire, issue).unwrap();
            assert_eq!(inflated(token.expose()), ours);
        }
    }

    #[test]
    fn credentials_that_are_not_32_hex_sign_nothing() {
        let issue = Issue { at_seconds: 1, salt: 1 };
        assert_eq!(rtc_with_rtm("short", &Secret::new(CERTIFICATE), "c", "1", 60, issue), Err(BadCredentials));
        assert_eq!(
            rtc_with_rtm(APP, &Secret::new("zz222222222222222222222222222222"), "c", "1", 60, issue),
            Err(BadCredentials)
        );
    }

    #[test]
    fn each_token_has_its_own_salt_in_range() {
        for _ in 0..50 {
            let i = Issue::now();
            assert!((1..=99_999_999).contains(&i.salt));
        }
    }
}
