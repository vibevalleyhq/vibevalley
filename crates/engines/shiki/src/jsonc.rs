/// Strips UTF-8 BOM, `//` and `/* */` comments, and trailing commas from JSONC text
/// so standard `serde_json` can decode VS Code themes and TextMate grammars directly
/// into typed structs.
pub(crate) fn strip_jsonc(input: &str) -> String {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;

    while i < len {
        let b = bytes[i];
        if b == b'"' {
            out.push('"');
            i += 1;
            while i < len {
                let c = bytes[i];
                if c == b'\\' && i + 1 < len {
                    out.push('\\');
                    let ch = input[i + 1..].chars().next().unwrap();
                    out.push(ch);
                    i += 1 + ch.len_utf8();
                } else if c == b'"' {
                    out.push('"');
                    i += 1;
                    break;
                } else {
                    let ch = input[i..].chars().next().unwrap();
                    out.push(ch);
                    i += ch.len_utf8();
                }
            }
            continue;
        }

        if b == b'/' && i + 1 < len && bytes[i + 1] == b'/' {
            i += 2;
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if b == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] == b'\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i = (i + 2).min(len);
            continue;
        }

        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    strip_trailing_commas(&out)
}

fn strip_trailing_commas(input: &str) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;

    while i < len {
        let b = bytes[i];
        if b == b'"' {
            out.push('"');
            i += 1;
            while i < len {
                let c = bytes[i];
                if c == b'\\' && i + 1 < len {
                    out.push('\\');
                    let ch = input[i + 1..].chars().next().unwrap();
                    out.push(ch);
                    i += 1 + ch.len_utf8();
                } else if c == b'"' {
                    out.push('"');
                    i += 1;
                    break;
                } else {
                    let ch = input[i..].chars().next().unwrap();
                    out.push(ch);
                    i += ch.len_utf8();
                }
            }
            continue;
        }

        if b == b',' {
            let mut j = i + 1;
            while j < len && matches!(bytes[j], b' ' | b'\t' | b'\r' | b'\n') {
                j += 1;
            }
            if j < len && matches!(bytes[j], b'}' | b']') {
                i += 1;
                continue;
            }
        }

        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::strip_jsonc;

    #[derive(Debug, Deserialize, PartialEq)]
    struct SampleDoc {
        a: String,
        b: Vec<i32>,
    }

    #[test]
    fn strips_comments_bom_and_trailing_commas() {
        let src = "\u{feff}{\n  // line comment\n  \"a\": \"http://example.com /* not a comment */\",\n  /* block\n     comment */\n  \"b\": [1, 2,],\n}\n";
        let stripped = strip_jsonc(src);
        let parsed: SampleDoc = serde_json::from_str(&stripped).expect("valid JSON");
        assert_eq!(parsed.a, "http://example.com /* not a comment */");
        assert_eq!(parsed.b, vec![1, 2]);
    }
}
