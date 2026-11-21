pub const DEFAULT_MAX_BYTES: usize = 30_000;
pub const DEFAULT_MAX_LINES: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncatedText {
    pub text: String,
    pub truncated: bool,
    pub shown_lines: usize,
    pub total_lines: usize,
    pub shown_bytes: usize,
    pub total_bytes: usize,
}

pub fn count_lines(text: &str) -> usize {
    text.lines().count()
}

pub fn floor_char_boundary(text: &str, max_bytes: usize) -> usize {
    let mut cut = max_bytes.min(text.len());
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

pub fn truncate_bytes(text: &str, max_bytes: usize) -> TruncatedText {
    let total_bytes = text.len();
    let total_lines = count_lines(text);
    if total_bytes <= max_bytes {
        return TruncatedText {
            text: text.to_string(),
            truncated: false,
            shown_lines: total_lines,
            total_lines,
            shown_bytes: total_bytes,
            total_bytes,
        };
    }

    let mut cut = floor_char_boundary(text, max_bytes);
    if let Some(newline) = text[..cut].rfind('\n')
        && newline > 0
    {
        cut = newline;
    }

    let kept = &text[..cut];
    let shown_bytes = kept.len();
    let shown_lines = count_lines(kept);
    let hint = if shown_lines < total_lines && shown_lines > 0 {
        format!(
            "\n... (showing lines 1..{shown_lines} of {total_lines}, {shown_bytes} of {total_bytes} bytes; pass offset={} to continue)",
            shown_lines + 1
        )
    } else {
        format!("\n... (showing {shown_bytes} of {total_bytes} bytes across {total_lines} lines; truncated at {max_bytes} bytes)")
    };

    TruncatedText {
        text: format!("{kept}{hint}"),
        truncated: true,
        shown_lines,
        total_lines,
        shown_bytes,
        total_bytes,
    }
}

pub fn truncate_lines(text: &str, max_lines: usize) -> TruncatedText {
    let total_bytes = text.len();
    let total_lines = count_lines(text);
    if total_lines <= max_lines {
        return TruncatedText {
            text: text.to_string(),
            truncated: false,
            shown_lines: total_lines,
            total_lines,
            shown_bytes: total_bytes,
            total_bytes,
        };
    }

    if max_lines == 0 {
        return TruncatedText {
            text: format!("... (showing 0 of {total_lines} lines, 0 of {total_bytes} bytes; pass offset=1 to continue)"),
            truncated: true,
            shown_lines: 0,
            total_lines,
            shown_bytes: 0,
            total_bytes,
        };
    }

    let kept: String = text.lines().take(max_lines).collect::<Vec<_>>().join("\n");
    let shown_bytes = kept.len();
    let hint = format!(
        "\n... (showing lines 1..{max_lines} of {total_lines}, {shown_bytes} of {total_bytes} bytes; pass offset={} to continue)",
        max_lines + 1
    );

    TruncatedText {
        text: format!("{kept}{hint}"),
        truncated: true,
        shown_lines: max_lines,
        total_lines,
        shown_bytes,
        total_bytes,
    }
}
