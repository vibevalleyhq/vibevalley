pub(super) struct StyledLine {
    pub(super) text: String,
    pub(super) font_size: f64,
    pub(super) bold: bool,
}

pub(super) fn layout_markdown_lines(text: &str, max_width: f64, base_font_size: f64) -> Vec<StyledLine> {
    let mut out = Vec::new();
    for raw in text.replace("\r\n", "\n").split('\n') {
        let trimmed = raw.trim_end();
        if trimmed.is_empty() {
            out.push(StyledLine {
                text: String::new(),
                font_size: base_font_size * 0.7,
                bold: false,
            });
            continue;
        }
        let (clean, font_size, bold) = if let Some(rest) = trimmed.strip_prefix("### ") {
            (simplify_markdown_inline(rest), base_font_size * 1.05, true)
        } else if let Some(rest) = trimmed.strip_prefix("## ") {
            (simplify_markdown_inline(rest), base_font_size * 1.15, true)
        } else if let Some(rest) = trimmed.strip_prefix("# ") {
            (simplify_markdown_inline(rest), base_font_size * 1.28, true)
        } else if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            (format!("• {}", simplify_markdown_inline(rest)), base_font_size, false)
        } else {
            (simplify_markdown_inline(trimmed), base_font_size, false)
        };

        for wrapped in wrap_text(&clean, max_width, font_size) {
            out.push(StyledLine {
                text: wrapped,
                font_size,
                bold,
            });
        }
    }
    out
}

/// Replaces inline Markdown `[label](url)` links with `label` for clean SVG text cards.
fn simplify_markdown_inline(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open_bracket) = rest.find('[') {
        out.push_str(&rest[..open_bracket]);
        let after_open = &rest[open_bracket + 1..];
        if let Some(close_bracket) = after_open.find("](") {
            let label = &after_open[..close_bracket];
            let after_mid = &after_open[close_bracket + 2..];
            if let Some(close_paren) = after_mid.find(')') {
                out.push_str(label);
                rest = &after_mid[close_paren + 1..];
                continue;
            }
        }
        out.push('[');
        rest = after_open;
    }
    out.push_str(rest);
    out
}

fn char_width_factor(ch: char) -> f64 {
    if ch.is_ascii() {
        match ch {
            'i' | 'l' | 'I' | '!' | '.' | ',' | ':' | ';' | '|' | '\'' => 0.32,
            'm' | 'w' | 'M' | 'W' => 0.85,
            _ => 0.56,
        }
    } else {
        1.0
    }
}

pub(super) fn estimate_text_width(text: &str, font_size: f64) -> f64 {
    text.chars().map(char_width_factor).sum::<f64>() * font_size
}

pub(super) fn wrap_text(text: &str, max_width: f64, font_size: f64) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_w = 0.0_f64;

    for word in text.split_inclusive(|c: char| c.is_whitespace()) {
        let word_w = estimate_text_width(word, font_size);
        if !current.is_empty() && current_w + word_w > max_width {
            lines.push(current.trim_end().to_owned());
            current.clear();
            current_w = 0.0;
        }
        if word_w <= max_width {
            current.push_str(word);
            current_w += word_w;
        } else {
            // Break long tokens (URLs, paths, CJK runs) safely at Unicode scalar boundaries.
            for ch in word.chars() {
                let cw = char_width_factor(ch) * font_size;
                if !current.is_empty() && current_w + cw > max_width {
                    lines.push(current.trim_end().to_owned());
                    current.clear();
                    current_w = 0.0;
                }
                current.push(ch);
                current_w += cw;
            }
        }
    }

    if !current.is_empty() || lines.is_empty() {
        lines.push(current.trim_end().to_owned());
    }
    lines
}

pub(super) fn extract_url_host(url: &str) -> Option<&str> {
    let (_, after_scheme) = url.split_once("://")?;
    let host_port = after_scheme.split(['/', '?', '#']).next()?;
    let host = host_port.rsplit('@').next().unwrap_or(host_port);
    (!host.is_empty()).then_some(host)
}

pub(super) fn escape_xml(input: &str) -> String {
    quick_xml::escape::escape(input).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simplify_markdown_inline_strips_links_and_keeps_broken_brackets() {
        assert_eq!(
            simplify_markdown_inline("See [Spec](spec/1.0.md) and [Apps](/docs/apps.md)!"),
            "See Spec and Apps!"
        );
        assert_eq!(simplify_markdown_inline("Array [1, 2] stays"), "Array [1, 2] stays");
    }

    #[test]
    fn wrap_text_splits_long_unicode_and_urls_safely() {
        let lines = wrap_text("https://example.com/very/long/path/without/spaces", 80.0, 12.0);
        assert!(lines.len() >= 3);
        assert_eq!(lines.concat(), "https://example.com/very/long/path/without/spaces");

        let cjk = wrap_text("一二三四五六七八九十", 50.0, 14.0);
        assert!(cjk.len() >= 3);
        assert_eq!(cjk.concat(), "一二三四五六七八九十");
    }

    #[test]
    fn extract_url_host_handles_user_port_and_non_authority_schemes() {
        assert_eq!(extract_url_host("https://github.com/obsidianmd/jsoncanvas"), Some("github.com"));
        assert_eq!(extract_url_host("http://user@127.0.0.1:8787/api"), Some("127.0.0.1:8787"));
        assert_eq!(extract_url_host("mailto:hello@vibevalley.dev"), None);
    }
}
