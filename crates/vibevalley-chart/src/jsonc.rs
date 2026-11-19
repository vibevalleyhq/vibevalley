use crate::error::ChartError;

/// Strips `//` line comments, `/* ... */` block comments, and trailing commas
/// before `}` or `]` in a single linear pass while preserving string contents.
pub(crate) fn strip_jsonc(input: &str) -> Result<String, ChartError> {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;

    // Strip UTF-8 BOM if present.
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        i = 3;
    }

    let mut in_string = false;
    let mut escaped = false;

    while i < len {
        let b = bytes[i];

        if in_string {
            out.push(b);
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if b == b'"' {
            in_string = true;
            out.push(b);
            i += 1;
            continue;
        }

        if b == b'/' && i + 1 < len {
            let next = bytes[i + 1];
            if next == b'/' {
                i += 2;
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            if next == b'*' {
                let start = i;
                i += 2;
                let mut closed = false;
                while i + 1 < len {
                    if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        i += 2;
                        closed = true;
                        break;
                    }
                    if bytes[i] == b'\n' {
                        out.push(b'\n');
                    }
                    i += 1;
                }
                if !closed {
                    return Err(ChartError::JsoncSyntax {
                        offset: start,
                        message: "unterminated block comment".to_string(),
                    });
                }
                continue;
            }
        }

        if b == b',' {
            // Look ahead past whitespace and comments to see if the next token closes an array/object.
            let mut look = i + 1;
            let trailing = loop {
                if look >= len {
                    break false;
                }
                let lb = bytes[look];
                if lb.is_ascii_whitespace() {
                    look += 1;
                    continue;
                }
                if lb == b'/' && look + 1 < len && bytes[look + 1] == b'/' {
                    look += 2;
                    while look < len && bytes[look] != b'\n' {
                        look += 1;
                    }
                    continue;
                }
                if lb == b'/' && look + 1 < len && bytes[look + 1] == b'*' {
                    let start = look;
                    look += 2;
                    let mut closed = false;
                    while look + 1 < len {
                        if bytes[look] == b'*' && bytes[look + 1] == b'/' {
                            look += 2;
                            closed = true;
                            break;
                        }
                        look += 1;
                    }
                    if !closed {
                        return Err(ChartError::JsoncSyntax {
                            offset: start,
                            message: "unterminated block comment".to_string(),
                        });
                    }
                    continue;
                }
                break lb == b'}' || lb == b']';
            };
            if trailing {
                i += 1;
                continue;
            }
        }

        out.push(b);
        i += 1;
    }

    // Input was valid UTF-8 and we only skipped ASCII tokens outside strings.
    String::from_utf8(out).map_err(|err| ChartError::JsoncSyntax {
        offset: err.utf8_error().valid_up_to(),
        message: "invalid UTF-8 after stripping comments".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::strip_jsonc;

    #[test]
    fn preserves_escaped_quotes_and_backslashes_in_strings() {
        let raw = r#"{"a": "trail\\","b": "// not a comment /* nope */",}"#;
        let stripped = strip_jsonc(raw).expect("strip");
        assert_eq!(stripped, r#"{"a": "trail\\","b": "// not a comment /* nope */"}"#);
    }

    #[test]
    fn handles_empty_and_unterminated_block_comments() {
        assert_eq!(strip_jsonc("/**/{\"x\":1,}").expect("empty comment"), "{\"x\":1}");
        assert!(strip_jsonc("/*/").is_err());
        assert!(strip_jsonc("{\"x\":1, /* trailing").is_err());
    }

    #[test]
    fn strips_utf8_bom() {
        let with_bom = "\u{FEFF}{\"x\": 1,}";
        assert_eq!(strip_jsonc(with_bom).expect("bom"), "{\"x\": 1}");
    }
}
