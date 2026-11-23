//! What the chat reads out of words (VibeValley `modules/channel/
//! mentions.ts`, `messages.ts`' search and `embeds.ts`): who they name,
//! where an address points, a search's filters, and link previews.

use std::sync::LazyLock;

use regex::Regex;
use vibevalley_i18n::{maybe, t};
use vibevalley_protocol::{DEFAULT_ORCHESTRATOR, EVERYONE, Embed, USER_ID};

/// The chat's names for who is not a helper; the orchestrator's is filled
/// in where the place is known.
pub fn chat_named(token: &str) -> Option<&'static str> {
    Some(match token {
        "主助手" | "助手" | "manager" => DEFAULT_ORCHESTRATOR,
        "用户" | "user" => USER_ID,
        "所有人" | "everyone" => EVERYONE,
        _ => return None,
    })
}

const CHAT_NAMES: [&str; 7] = ["主助手", "助手", "用户", "所有人", "manager", "user", "everyone"];

/// `mentionOf`: how the page writes a mention of one of the chat's names.
pub fn mention_of(id: &str) -> Option<String> {
    maybe(&format!("server.channel.mention.{id}"))
}

/// Who a place's words can name besides the sessions.
pub struct Nameable<'a> {
    /// The place's own orchestrator (@助手).
    pub here: &'a str,
    pub orchestrators: &'a [String],
}

static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?```").expect("fence"));
static TICK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`").expect("tick"));
static LATIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{Latin}$").expect("latin"));

/// `mentionLead`: an @ right after a Latin letter, a number, `_` or another
/// @ names no one (an address, a word).
fn leads(prev: Option<char>) -> bool {
    match prev {
        None => true,
        Some(c) => !(c == '_' || c == '@' || c.is_numeric() || LATIN.is_match(c.encode_utf8(&mut [0; 4]))),
    }
}

fn match_worker_mention(rest: &str) -> Option<&str> {
    let bytes = rest.as_bytes();
    if bytes.first() != Some(&b'w') {
        return None;
    }
    let digits_end = 1 + bytes[1..].iter().take_while(|b| b.is_ascii_digit()).count();
    (digits_end > 1).then_some(&rest[..digits_end])
}

/// `mentionsIn`: who some words name, once each, in order. Code names no
/// one; the longest name is tried first, and a name ends where its token
/// ends (`@w3你看` names w3).
pub fn mentions_in(text: &str, names: &Nameable) -> Vec<String> {
    let mut alts: Vec<&str> = names.orchestrators.iter().map(String::as_str).chain(CHAT_NAMES).collect();
    alts.sort_by_key(|a| std::cmp::Reverse(a.encode_utf16().count()));
    let prose = FENCE.replace_all(text, " ");
    let prose = TICK.replace_all(&prose, " ");
    let mut found: Vec<String> = vec![];
    let mut cursor = 0;
    while let Some(rel) = prose[cursor..].find('@') {
        let at_idx = cursor + rel;
        let rest = &prose[at_idx + 1..];
        let matched = match_worker_mention(rest).or_else(|| alts.iter().copied().find(|alt| !alt.is_empty() && rest.starts_with(alt)));
        let Some(token) = matched else {
            cursor = at_idx + 1;
            continue;
        };
        cursor = at_idx + 1 + token.len();
        if !leads(prose[..at_idx].chars().next_back()) {
            continue;
        }
        let id = match chat_named(token) {
            Some(DEFAULT_ORCHESTRATOR) => names.here.to_string(),
            Some(named) => named.to_string(),
            None => token.to_string(),
        };
        if !found.contains(&id) {
            found.push(id);
        }
    }
    found
}

static CHANNEL_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_-]{1,24}$").expect("name"));
static THREAD_TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_-]{1,24}:([0-9]+)$").expect("thread"));
static DIRECT_TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@(\S+)$").expect("direct"));

/// JS counts a name's length in UTF-16 units; the pattern's `{1,24}`
/// counts characters, so a name past the BMP is checked again here.
fn name_fits(name: &str) -> bool {
    CHANNEL_NAME.is_match(name) && name.encode_utf16().count() <= 24
}

/// `channelNameProblem`: what is wrong with a new channel name, or "".
pub fn channel_name_problem(name: &str, taken: &[String]) -> String {
    if !name_fits(name) {
        return t("server.channel.channelName", &[]);
    }
    if taken.iter().any(|n| n == name) {
        return t("server.channel.channelTaken", &[("name", name.into())]);
    }
    String::new()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatTarget {
    Channel(String),
    Thread(i64),
    Direct(String),
}

/// `parseChatTarget`: a channel's name, a thread by its parent message's
/// number, or @ the one a direct channel is with.
pub fn parse_chat_target(target: &str) -> Option<ChatTarget> {
    let trimmed = target.trim();
    if let Some(m) = DIRECT_TARGET.captures(trimmed) {
        let who = &m[1];
        return Some(ChatTarget::Direct(chat_named(who).unwrap_or(who).to_string()));
    }
    let text = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if let Some(m) = THREAD_TARGET.captures(text) {
        return m[1].parse::<i64>().ok().map(ChatTarget::Thread);
    }
    name_fits(text).then(|| ChatTarget::Channel(text.to_string()))
}

/// `targetOf`: a place's address as an agent writes it.
pub fn target_of(kind: &str, root_number: Option<i64>, name: Option<&str>, channel_name: &str) -> String {
    match (kind, root_number) {
        ("direct", _) => format!("@{USER_ID}"),
        ("thread", Some(n)) => format!("#{channel_name}:{n}"),
        _ => format!("#{}", name.unwrap_or(channel_name)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Has {
    File,
    Image,
    Link,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchQuery {
    pub words: String,
    pub from: Option<String>,
    pub r#in: Option<String>,
    pub has: Vec<Has>,
    pub before: Option<i64>,
    pub after: Option<i64>,
}

static FILTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|\s)(from|in|has|before|after):(\S+)").expect("filter"));
static DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})-(\d{1,2})-(\d{1,2})$").expect("day"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("spaces"));

/// A day's midnight on this machine, in ms.
fn midnight(day: &str) -> Option<i64> {
    let m = DAY.captures(day)?;
    let date = jiff::civil::Date::new(m[1].parse().ok()?, m[2].parse().ok()?, m[3].parse().ok()?).ok()?;
    Some(date.to_zoned_datetime(jiff::tz::TimeZone::system()).ok()?.timestamp().as_millisecond())
}

/// `parseSearch`: a search's filters read out of its words; a filter that
/// does not read stays among them.
pub fn parse_search(text: &str) -> SearchQuery {
    let mut q = SearchQuery::default();
    let words = FILTER.replace_all(text, |c: &regex::Captures| {
        let (lead, key, value) = (&c[1], c[2].to_lowercase(), &c[3]);
        let keep = c[0].to_string();
        let gone = format!("{lead} ");
        match key.as_str() {
            "from" => {
                let v = value.strip_prefix('@').unwrap_or(value);
                q.from = Some(chat_named(v).unwrap_or(v).to_string());
                gone
            }
            "in" => {
                q.r#in = Some(value.strip_prefix('#').unwrap_or(value).to_string());
                gone
            }
            "has" => {
                let has = match value {
                    "file" => Has::File,
                    "image" => Has::Image,
                    "link" => Has::Link,
                    _ => return keep,
                };
                if !q.has.contains(&has) {
                    q.has.push(has);
                }
                gone
            }
            "before" | "after" => match midnight(value) {
                Some(at) if key == "before" => {
                    q.before = Some(at);
                    gone
                }
                Some(at) => {
                    q.after = Some(at);
                    gone
                }
                None => keep,
            },
            _ => keep,
        }
    });
    q.words = SPACES.replace_all(&words, " ").trim().to_string();
    q
}

const EMBED_MAX: usize = 3;
const EMBED_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const BODY_MAX: usize = 512 * 1024;
const REDIRECTS_MAX: usize = 3;

static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&*+,;=%]+").expect("link"));
static LINK_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.,;:!?\]]+$").expect("tail"));

/// `linksIn`: the links in some words, once each, three at most.
pub fn links_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for m in LINK.find_iter(text) {
        let url = LINK_TAIL.replace(m.as_str(), "").to_string();
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out.truncate(EMBED_MAX);
    out
}

/// `privateAddress`: one only this computer, its network or its cloud
/// reaches.
pub fn private_address(ip: &std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    let v4 = match ip {
        IpAddr::V4(v4) => Some(*v4),
        IpAddr::V6(v6) => v6.to_ipv4_mapped(),
    };
    if let Some(v4) = v4 {
        let [a, b, ..] = v4.octets();
        return a == 0
            || a == 10
            || a == 127
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 100 && (64..=127).contains(&b))
            || a >= 224;
    }
    let IpAddr::V6(v6) = ip else { return true };
    let s = v6.segments();
    v6.is_unspecified() || v6.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
}

/// `reachable`: http(s), no credentials, not a local name, and every
/// address the name has is on the public web.
pub fn reachable(url: &url::Url, resolve: &dyn Fn(&str, u16) -> Vec<std::net::IpAddr>) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") {
        return false;
    }
    let addresses = resolve(host, url.port_or_known_default().unwrap_or(80));
    !addresses.is_empty() && addresses.iter().all(|a| !private_address(a))
}

async fn resolve_all_async(host: &str, port: u16) -> Vec<std::net::IpAddr> {
    if let Ok(ip) = host.parse() {
        return vec![ip];
    }
    tokio::net::lookup_host((host, port))
        .await
        .map(|addrs| addrs.map(|s| s.ip()).collect())
        .unwrap_or_default()
}

async fn reachable_async(url: &url::Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") {
        return false;
    }
    let addresses = resolve_all_async(host, url.port_or_known_default().unwrap_or(80)).await;
    !addresses.is_empty() && addresses.iter().all(|a| !private_address(a))
}

static META_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<meta\s+[^>]*>").expect("meta"));
static META_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(?:property|name)\s*=\s*["']([^"']+)["']"#).expect("name"));
static META_CONTENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)content\s*=\s*["']([^"']*)["']"#).expect("content"));
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<title[^>]*>([^<]*)</title>").expect("title"));
static ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&(amp|lt|gt|quot|#39|apos|nbsp);").expect("entity"));

fn decode_entities(s: &str) -> String {
    ENTITY
        .replace_all(s, |c: &regex::Captures| {
            match &c[1] {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "#39" | "apos" => "'",
                _ => " ",
            }
            .to_string()
        })
        .trim()
        .to_string()
}

/// At most n units, the ellipsis among them.
fn up_to(s: &str, n: usize) -> String {
    vibevalley_core::rules::cut(s, n - 1)
}

/// `embedOf`: what a page says of itself in its head, Open Graph first.
pub fn embed_of(url: &str, html: &str) -> Option<Embed> {
    let meta = |key: &str| {
        META_TAG.find_iter(html).find_map(|tag| {
            let name = META_NAME.captures(tag.as_str())?[1].to_lowercase();
            let content = META_CONTENT.captures(tag.as_str()).map(|c| c[1].to_string())?;
            (name == key && !content.is_empty()).then(|| decode_entities(&content))
        })
    };
    let title = meta("og:title").unwrap_or_else(|| decode_entities(TITLE.captures(html).map_or("", |c| c.get(1).map_or("", |m| m.as_str()))));
    let description = meta("og:description").or_else(|| meta("description"));
    let site = meta("og:site_name");
    let image = meta("og:image");
    if title.is_empty() && description.as_deref().unwrap_or("").is_empty() {
        return None;
    }
    let image = image
        .and_then(|i| url::Url::parse(url).ok()?.join(&i).ok())
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
        .map(|u| u.to_string())
        .unwrap_or_default();
    Some(Embed {
        url: url.into(),
        title: up_to(&title, 200),
        description: up_to(description.as_deref().unwrap_or(""), 300),
        site: up_to(site.as_deref().unwrap_or(""), 80),
        image,
    })
}

/// `readEmbed`: asynchronously reads a link's preview without blocking an OS thread,
/// or returns none when it cannot be read (not public, not a page, too slow, too big).
pub async fn read_embed_async(link: &str) -> Option<Embed> {
    let mut url = url::Url::parse(link).ok()?;
    let client = crate::modules::infra::http::no_redirect_client().ok()?.clone();
    for _ in 0..=REDIRECTS_MAX {
        if !reachable_async(&url).await {
            return None;
        }
        let mut res = client
            .get(url.as_str())
            .timeout(EMBED_TIMEOUT)
            .header("accept", "text/html")
            .header("user-agent", "VibeValley link preview")
            .send()
            .await
            .ok()?;
        let status = res.status().as_u16();
        if (300..400).contains(&status) {
            let next = res.headers().get("location").and_then(|v| v.to_str().ok())?;
            url = url.join(next).ok()?;
            continue;
        }
        let html = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .contains("text/html");
        if !(200..300).contains(&status) || !html {
            return None;
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = match res.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(_) => {
                    if bytes.is_empty() {
                        return None;
                    }
                    break;
                }
            };
            let remaining = BODY_MAX.saturating_sub(bytes.len());
            if remaining == 0 {
                break;
            }
            let take = chunk.len().min(remaining);
            bytes.extend_from_slice(&chunk[..take]);
            if bytes.len() >= BODY_MAX {
                break;
            }
        }
        return embed_of(link, &String::from_utf8_lossy(&bytes));
    }
    None
}

/// `readEmbed`: a link's preview, or none when it cannot be read (not
/// public, not a page, too slow, too big).
pub fn read_embed(link: &str) -> Option<Embed> {
    let link = link.to_string();
    crate::modules::infra::http::run_http(async move { read_embed_async(&link).await })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(text: &str) -> Vec<String> {
        mentions_in(
            text,
            &Nameable {
                here: DEFAULT_ORCHESTRATOR,
                orchestrators: &[DEFAULT_ORCHESTRATOR.into()],
            },
        )
    }

    #[test]
    fn an_at_after_chinese_names_someone_and_one_inside_a_word_does_not() {
        assert_eq!(named("问@w3 看看"), ["w3"]);
        assert_eq!(named("「@w3」你呢"), ["w3"]);
        assert!(named("mail a@w3.dev, x@@w3").is_empty());
    }

    #[test]
    fn with_several_orchestrators() {
        let orchestrators: Vec<String> = ["orchestrator", "lead", "agent-1", "agent-12"].iter().map(|s| s.to_string()).collect();
        let names = Nameable {
            here: "lead",
            orchestrators: &orchestrators,
        };
        assert_eq!(mentions_in("@助手 看看，@agent-12 也看看，@agent-1", &names), ["lead", "agent-12", "agent-1"]);
        assert_eq!(mentions_in("@orchestrator 你呢 `@lead`", &names), ["orchestrator"]);
        assert!(named("@lead 在吗").is_empty());
        assert_eq!(mentions_in("@w12你好，@agent-123", &names), ["w12", "agent-12"]);
        assert_eq!(mentions_in("@w1@w2, @w1,@w2 and a@w3 and @助手你看", &names), ["w1", "w2", "lead"]);
        assert_eq!(mentions_in("```\n@w9 @助手\n```\n`@w8` @w4", &names), ["w4"]);
    }

    #[test]
    fn a_search_reads_its_filters() {
        let q = parse_search("苹果 from:助手 in:#clock-in has:image has:link");
        assert_eq!(
            q,
            SearchQuery {
                words: "苹果".into(),
                from: Some(DEFAULT_ORCHESTRATOR.into()),
                r#in: Some("clock-in".into()),
                has: vec![Has::Image, Has::Link],
                ..Default::default()
            }
        );
        assert_eq!(parse_search("from:@用户 来了").from.as_deref(), Some(USER_ID));
        assert_eq!(parse_search("from:w3").from.as_deref(), Some("w3"));
        let day = parse_search("before:2026-10-28 after:2026-10-01 has:pdf");
        assert_eq!(day.before, midnight("2026-10-28"));
        assert_eq!(day.after, midnight("2026-10-01"));
        assert!(day.before.is_some());
        assert_eq!(day.words, "has:pdf");
        assert_eq!(parse_search("before:明天").words, "before:明天");
    }

    #[test]
    fn targets_read_back() {
        assert_eq!(parse_chat_target("#general"), Some(ChatTarget::Channel("general".into())));
        assert_eq!(parse_chat_target("general:12"), Some(ChatTarget::Thread(12)));
        assert_eq!(parse_chat_target("@用户"), Some(ChatTarget::Direct(USER_ID.into())));
        assert_eq!(parse_chat_target("no spaces here"), None);
    }

    #[test]
    fn links_are_read_three_at_most() {
        assert_eq!(
            links_in("看 https://a.example/x，还有 (https://b.example/y). 和 https://a.example/x"),
            ["https://a.example/x", "https://b.example/y"]
        );
        assert_eq!(links_in("https://1.example https://2.example https://3.example https://4.example").len(), 3);
    }

    #[test]
    fn private_addresses_are_never_read() {
        for ip in [
            "127.0.0.1",
            "10.0.0.2",
            "192.168.1.1",
            "172.16.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(private_address(&ip.parse().unwrap()), "{ip}");
        }
        assert!(!private_address(&"93.184.216.34".parse().unwrap()));
        let at = |ips: &'static [&'static str]| move |_: &str, _: u16| ips.iter().map(|i| i.parse().unwrap()).collect();
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(reachable(&u("https://example.com"), &at(&["93.184.216.34"])));
        assert!(!reachable(&u("https://example.com"), &at(&["93.184.216.34", "10.0.0.1"])));
        assert!(!reachable(&u("http://localhost:8787"), &at(&["127.0.0.1"])));
        assert!(!reachable(&u("file:///etc/passwd"), &at(&["93.184.216.34"])));
        assert!(!reachable(&u("https://user:pw@example.com"), &at(&["93.184.216.34"])));
    }

    #[test]
    fn a_page_says_what_it_is() {
        let e = embed_of(
            "https://a.example/x",
            r#"<head><title>T &amp; t</title><meta property="og:description" content="D"><meta property="og:image" content="/i.png"></head>"#,
        )
        .unwrap();
        assert_eq!(
            (e.title.as_str(), e.description.as_str(), e.image.as_str()),
            ("T & t", "D", "https://a.example/i.png")
        );
        assert!(embed_of("https://a.example", "<p>nothing</p>").is_none());
    }
}
