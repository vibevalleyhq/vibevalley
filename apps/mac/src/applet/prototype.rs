//! Strict CSP (`connect-src 'none'`) injection for standalone HTML preview documents.

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
}
