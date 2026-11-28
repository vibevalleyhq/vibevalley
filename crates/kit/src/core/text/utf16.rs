/// Byte index in `s` after at most `max` UTF-16 code units, always on a UTF-8 char boundary.
pub fn within(s: &str, max: usize) -> usize {
    let mut units = 0usize;
    for (at, ch) in s.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return at;
        }
    }
    s.len()
}

/// Prefix of `s` containing at most `max` UTF-16 code units, preserving whole Unicode scalar values.
pub fn head(s: &str, max: usize) -> String {
    let cut = within(s, max);
    s[..cut].to_owned()
}

/// Collapses runs of Unicode whitespace into single ASCII spaces and trims leading/trailing whitespace.
pub fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Collapses whitespace and clips to at most `max_units` UTF-16 code units, appending `"…"` if truncated.
pub fn clip_utf16(s: &str, max_units: usize) -> String {
    let collapsed = collapse_whitespace(s);
    let cut = within(&collapsed, max_units);
    if cut < collapsed.len() {
        format!("{}…", collapsed[..cut].trim_end())
    } else {
        collapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_truncation_handles_surrogate_pairs_and_ellipsis() {
        // '😀' is 4 UTF-8 bytes and 2 UTF-16 code units.
        let s = "a😀b";
        assert_eq!(head(s, 0), "");
        assert_eq!(head(s, 1), "a");
        assert_eq!(head(s, 2), "a");
        assert_eq!(head(s, 3), "a😀");
        assert_eq!(head(s, 4), "a😀b");
        assert_eq!(collapse_whitespace("  hello \n\t world  "), "hello world");
        assert_eq!(clip_utf16("hello   world", 5), "hello…");
        assert_eq!(clip_utf16("hello", 5), "hello");
    }
}
