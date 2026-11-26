//! Sandboxed HTML/CSS/JS assembly for `prototype` artifact applets.
//!
//! Mirrors `apps/mac/ui/features/artifact/frame.ts` so `VibeValleyShim` hosts a
//! self-contained `WKWebView` document with strict CSP (`connect-src 'none'`).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;
use vibevalley_protocol::{Artifact, ArtifactFileContent, ArtifactFileEncoding, ArtifactFileListResult};
use vibevalley_server::gateway::bridge::{CallerContext, Server};

const POLICY_META: &str = concat!(
    "<meta http-equiv=\"Content-Security-Policy\" content=\"",
    "default-src 'none'; ",
    "script-src 'unsafe-inline'; ",
    "style-src 'unsafe-inline'; ",
    "img-src data: blob:; ",
    "font-src data:; ",
    "media-src data: blob:; ",
    "connect-src 'none'; ",
    "form-action 'none'; ",
    "base-uri 'none'",
    "\">",
);

const DEFAULT_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\" /></head><body><main id=\"app\"></main></body></html>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrototypeBundle {
    pub title: String,
    pub artifact_type: String,
    pub seq: i64,
    pub html: String,
}

fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    h.windows(n.len()).position(|w| w.eq_ignore_ascii_case(n))
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// Inserts the strict CSP `<meta>` right after `<head>`, else after `<!doctype ...>`, else first.
pub fn with_policy(page: &str) -> String {
    if let Some(head_idx) = find_head_tag_end(page) {
        let mut out = String::with_capacity(page.len() + POLICY_META.len());
        out.push_str(&page[..head_idx]);
        out.push_str(POLICY_META);
        out.push_str(&page[head_idx..]);
        return out;
    }
    let trimmed_start = page.len() - page.trim_start().len();
    if let Some(after_ws) = page.get(trimmed_start..)
        && starts_with_ci(after_ws, "<!doctype")
        && let Some(gt) = after_ws.find('>')
    {
        let insert_at = trimmed_start + gt + 1;
        let mut out = String::with_capacity(page.len() + POLICY_META.len());
        out.push_str(&page[..insert_at]);
        out.push_str(POLICY_META);
        out.push_str(&page[insert_at..]);
        return out;
    }
    format!("{POLICY_META}{page}")
}

fn find_head_tag_end(page: &str) -> Option<usize> {
    let mut offset = 0usize;
    while let Some(rel) = find_ascii_ci(&page[offset..], "<head") {
        let start = offset + rel;
        let after = &page[start + "<head".len()..];
        let next_ok = after.as_bytes().first().is_some_and(|b| b.is_ascii_whitespace() || *b == b'>');
        if next_ok && let Some(gt) = after.find('>') {
            return Some(start + "<head".len() + gt + 1);
        }
        offset = start + "<head".len();
    }
    None
}

fn escape_close_tag(raw: &str, tag: &str) -> String {
    let needle = format!("</{tag}");
    let replacement = format!("<\\/{tag}");
    let mut out = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    while let Some(rel) = find_ascii_ci(&raw[cursor..], &needle) {
        let idx = cursor + rel;
        out.push_str(&raw[cursor..idx]);
        out.push_str(&replacement);
        cursor = idx + needle.len();
    }
    out.push_str(&raw[cursor..]);
    out
}

fn extract_attr(attrs: &str, name: &str) -> Option<String> {
    let bytes = attrs.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
            i += 1;
        }
        let key = &attrs[key_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let val = if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != quote {
                i += 1;
            }
            let val = &attrs[start..i];
            if i < bytes.len() {
                i += 1;
            }
            val
        } else {
            let start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            &attrs[start..i]
        };
        if key.eq_ignore_ascii_case(name) {
            return Some(val.to_string());
        }
    }
    None
}

fn lookup_rel_file<'a>(files: &'a HashMap<String, String>, raw_ref: &str) -> Option<&'a str> {
    let mut rel = raw_ref;
    while let Some(rest) = rel.strip_prefix("../") {
        rel = rest;
    }
    rel = rel.strip_prefix("./").unwrap_or(rel);
    files
        .get(&format!("structure/{rel}"))
        .or_else(|| files.get(rel))
        .or_else(|| files.get(&format!("asset/{rel}")))
        .map(String::as_str)
}

fn encode_uri_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for &b in raw.as_bytes() {
        let safe = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn replace_attr_double_quoted(attrs: &str, name: &str, new_val: &str) -> Option<String> {
    let bytes = attrs.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
            i += 1;
        }
        let key = &attrs[key_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let val_start = i;
        let val_end = if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            i += 1;
            while i < bytes.len() && bytes[i] != quote {
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            i
        } else {
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            i
        };
        if key.eq_ignore_ascii_case(name) {
            let mut out = String::with_capacity(attrs.len() + new_val.len());
            out.push_str(&attrs[..val_start]);
            out.push('"');
            out.push_str(new_val);
            out.push('"');
            out.push_str(&attrs[val_end..]);
            return Some(out);
        }
    }
    None
}

fn inline_svg_images(html: &str, files: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while let Some(rel) = find_ascii_ci(&html[cursor..], "<img") {
        let start = cursor + rel;
        let after = &html[start + "<img".len()..];
        let boundary_ok = after.as_bytes().first().is_some_and(|b| b.is_ascii_whitespace() || *b == b'>' || *b == b'/');
        if !boundary_ok {
            out.push_str(&html[cursor..start + "<img".len()]);
            cursor = start + "<img".len();
            continue;
        }
        let Some(gt) = after.find('>') else {
            break;
        };
        let tag_end = start + "<img".len() + gt + 1;
        let attrs = &after[..gt];
        if let Some(src) = extract_attr(attrs, "src")
            && src.to_ascii_lowercase().ends_with(".svg")
            && let Some(svg) = lookup_rel_file(files, &src)
            && let Some(replaced_attrs) = replace_attr_double_quoted(attrs, "src", &format!("data:image/svg+xml;charset=utf-8,{}", encode_uri_component(svg)))
        {
            out.push_str(&html[cursor..start]);
            out.push_str("<img");
            out.push_str(&replaced_attrs);
            out.push('>');
            cursor = tag_end;
            continue;
        }
        out.push_str(&html[cursor..tag_end]);
        cursor = tag_end;
    }
    out.push_str(&html[cursor..]);
    out
}

fn inline_css_links(html: &str, files: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while let Some(rel) = find_ascii_ci(&html[cursor..], "<link") {
        let start = cursor + rel;
        let after = &html[start + "<link".len()..];
        let boundary_ok = after.as_bytes().first().is_some_and(|b| b.is_ascii_whitespace() || *b == b'>' || *b == b'/');
        if !boundary_ok {
            out.push_str(&html[cursor..start + "<link".len()]);
            cursor = start + "<link".len();
            continue;
        }
        let Some(gt) = after.find('>') else {
            break;
        };
        let tag_end = start + "<link".len() + gt + 1;
        let attrs = after[..gt].trim_end_matches('/');
        if let Some(href) = extract_attr(attrs, "href")
            && href.to_ascii_lowercase().ends_with(".css")
            && let Some(css) = lookup_rel_file(files, &href)
        {
            out.push_str(&html[cursor..start]);
            out.push_str("<style>\n");
            out.push_str(&escape_close_tag(css, "style"));
            out.push_str("\n</style>");
            cursor = tag_end;
            continue;
        }
        out.push_str(&html[cursor..tag_end]);
        cursor = tag_end;
    }
    out.push_str(&html[cursor..]);
    out
}

fn inline_scripts(html: &str, files: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while let Some(rel) = find_ascii_ci(&html[cursor..], "<script") {
        let start = cursor + rel;
        let after = &html[start + "<script".len()..];
        let boundary_ok = after.as_bytes().first().is_some_and(|b| b.is_ascii_whitespace() || *b == b'>');
        if !boundary_ok {
            out.push_str(&html[cursor..start + "<script".len()]);
            cursor = start + "<script".len();
            continue;
        }
        let Some(gt) = after.find('>') else {
            break;
        };
        let open_end = start + "<script".len() + gt + 1;
        let attrs = &after[..gt];
        let Some(close_rel) = find_ascii_ci(&html[open_end..], "</script>") else {
            out.push_str(&html[cursor..open_end]);
            cursor = open_end;
            continue;
        };
        let close_end = open_end + close_rel + "</script>".len();
        if close_rel == 0
            && let Some(src) = extract_attr(attrs, "src")
            && {
                let lower = src.to_ascii_lowercase();
                lower.ends_with(".js") || lower.ends_with(".mjs")
            }
            && let Some(js) = lookup_rel_file(files, &src)
        {
            let is_module = extract_attr(attrs, "type").is_some_and(|t| t.eq_ignore_ascii_case("module"));
            out.push_str(&html[cursor..start]);
            out.push_str(if is_module { "<script type=\"module\">\n" } else { "<script>\n" });
            out.push_str(&escape_close_tag(js, "script"));
            out.push_str("\n</script>");
            cursor = close_end;
            continue;
        }
        out.push_str(&html[cursor..open_end]);
        cursor = open_end;
    }
    out.push_str(&html[cursor..]);
    out
}

fn pick_html_entry(files: &HashMap<String, String>) -> &str {
    if let Some(primary) = files.get("structure/index.html") {
        return primary.as_str();
    }
    let mut candidates: Vec<(&String, &String)> = files
        .iter()
        .filter(|(k, _)| {
            let lower = k.to_ascii_lowercase();
            lower.ends_with(".html") || lower.ends_with(".htm")
        })
        .collect();
    candidates.sort_by(|a, b| a.0.cmp(b.0));
    candidates.first().map(|(_, v)| v.as_str()).unwrap_or(DEFAULT_HTML)
}

/// Assembles a self-contained, CSP-sandboxed document for a `prototype` artifact directory.
pub fn build_prototype_document(files: &HashMap<String, String>) -> String {
    let raw_html = pick_html_entry(files);
    let with_css = inline_css_links(raw_html, files);
    let with_svg = inline_svg_images(&with_css, files);
    let with_js = inline_scripts(&with_svg, files);
    with_policy(&with_js)
}

fn is_text_web_asset(mime: &str, path: &str) -> bool {
    if mime.starts_with("text/") || mime == "application/javascript" || mime == "application/json" || mime == "image/svg+xml" {
        return true;
    }
    let lower = path.to_ascii_lowercase();
    [".html", ".htm", ".css", ".js", ".mjs", ".svg", ".json", ".txt"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

async fn call_json<T: serde::de::DeserializeOwned>(server: &Arc<dyn Server>, op: &str, payload: serde_json::Value) -> Result<T, String> {
    let env = Arc::clone(server).call_with_async(CallerContext::local(), op.to_string(), payload).await;
    if env.biz_code != 0 {
        return Err(env.message);
    }
    let data = env.data.ok_or_else(|| format!("{op} returned empty payload"))?;
    serde_json::from_value(data).map_err(|e| format!("decode {op}: {e}"))
}

pub async fn load_prototype_bundle(server: &Arc<dyn Server>, artifact_id: &str) -> Result<PrototypeBundle, String> {
    let artifact: Artifact = call_json(server, "artifact.get", json!({ "id": artifact_id })).await?;
    let listed: ArtifactFileListResult = call_json(server, "artifact.file.list", json!({ "id": artifact_id })).await?;
    let mut files = HashMap::new();
    for meta in listed.files {
        if !is_text_web_asset(&meta.mime, &meta.path) {
            continue;
        }
        let Ok(file) = call_json::<ArtifactFileContent>(server, "artifact.file.get", json!({ "id": artifact_id, "path": meta.path })).await else {
            continue;
        };
        if file.encoding == ArtifactFileEncoding::Utf8 {
            files.insert(file.path, file.content);
        }
    }
    Ok(PrototypeBundle {
        title: artifact.title,
        artifact_type: artifact.artifact_type.as_str().to_string(),
        seq: listed.seq,
        html: build_prototype_document(&files),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_goes_after_head_else_after_doctype_else_first() {
        assert!(with_policy("<html><head><title>x</title></head></html>").starts_with(&format!("<html><head>{POLICY_META}")));
        assert!(with_policy("<html><HEAD lang=\"en\"><title>x</title></HEAD></html>").starts_with(&format!("<html><HEAD lang=\"en\">{POLICY_META}")));
        assert!(with_policy("<!doctype html><p>x</p>").starts_with(&format!("<!doctype html>{POLICY_META}")));
        assert!(with_policy("<p>x</p>").starts_with(POLICY_META));
    }

    #[test]
    fn build_prototype_document_inlines_css_and_js_with_strict_csp() {
        let files = HashMap::from([
            (
                "structure/index.html".into(),
                "<!doctype html><html><head><link rel=\"stylesheet\" href=\"./styles.css\" /></head><body><main id=\"app\">Hi</main><script type=\"module\" src=\"./app.js\"></script></body></html>".into(),
            ),
            ("structure/styles.css".into(), "body { color: #1c1917; } </style>".into()),
            ("structure/app.js".into(), "export const ok = \"</script>\";".into()),
        ]);
        let doc = build_prototype_document(&files);
        assert!(doc.contains("connect-src 'none'"));
        assert!(doc.contains("<style>\nbody { color: #1c1917; } <\\/style>\n</style>"));
        assert!(doc.contains("<script type=\"module\">\nexport const ok = \"<\\/script>\";\n</script>"));
    }

    #[test]
    fn missing_local_files_stay_unmodified_and_default_html_is_used_when_absent() {
        let files = HashMap::new();
        let doc = build_prototype_document(&files);
        assert!(doc.contains("<main id=\"app\"></main>"));
        assert!(doc.contains("default-src 'none'"));

        let partial = HashMap::from([(
            "structure/index.html".into(),
            "<html><head><link rel=\"stylesheet\" href=\"./missing.css\"></head><body><script src=\"./missing.js\"></script></body></html>".into(),
        )]);
        let doc = build_prototype_document(&partial);
        assert!(doc.contains("href=\"./missing.css\""));
        assert!(doc.contains("src=\"./missing.js\""));
    }

    #[test]
    fn falls_back_to_alternate_html_entry_and_inlines_svg_assets() {
        let files = HashMap::from([
            (
                "structure/demo.html".into(),
                "<!doctype html><html><head></head><body><img alt=\"badge\" src=\"../asset/badge.svg\"></body></html>".into(),
            ),
            (
                "asset/badge.svg".into(),
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 12 12\"><rect width=\"10\" height=\"10\"/></svg>".into(),
            ),
        ]);
        let doc = build_prototype_document(&files);
        assert!(doc.contains("data:image/svg+xml;charset=utf-8,"));
        assert!(doc.contains("connect-src 'none'"));
    }

    #[test]
    fn load_prototype_bundle_fetches_and_assembles_from_server() {
        use vibevalley_server::gateway::bridge::fake::FakeServer;

        let fake = FakeServer::new();
        fake.respond(
            "artifact.get",
            json!({
                "id": "proto-1",
                "title": "Demo Prototype",
                "artifactType": "prototype",
                "isDefault": false,
                "by": "user",
                "byName": "User",
                "version": 1,
                "seq": 3,
                "versions": [],
                "at": 100,
                "updated": 200
            }),
        );
        fake.respond(
            "artifact.file.list",
            json!({
                "artifactId": "proto-1",
                "seq": 3,
                "files": [
                    { "path": "structure/index.html", "mime": "text/html", "size": 90, "hash": "h1", "updatedAt": 200 },
                    { "path": "structure/app.js", "mime": "application/javascript", "size": 20, "hash": "h2", "updatedAt": 200 }
                ]
            }),
        );
        fake.respond(
            "artifact.file.get",
            json!({
                "artifactId": "proto-1",
                "path": "structure/app.js",
                "mime": "application/javascript",
                "encoding": "utf8",
                "content": "console.log('hi')",
                "size": 17,
                "hash": "h2",
                "updatedAt": 200
            }),
        );
        let server: Arc<dyn Server> = Arc::new(fake);
        let bundle = vibevalley_runtime::rt::block_on(load_prototype_bundle(&server, "proto-1")).unwrap();
        assert_eq!(bundle.title, "Demo Prototype");
        assert_eq!(bundle.artifact_type, "prototype");
        assert_eq!(bundle.seq, 3);
        assert!(bundle.html.contains("connect-src 'none'"));
    }
}
