//! Desensitized slow-SQL logging stripping string and numeric literals.

use std::time::Duration;

/// Default latency threshold above which a query is logged at `WARN` level.
pub const DEFAULT_SLOW_QUERY_THRESHOLD: Duration = Duration::from_millis(50);

/// Strips single-quoted string literals and standalone numeric literals from a SQL string
/// so diagnostic logs never expose user content, tokens, or PII.
pub fn redact_sql_literals(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut prev_ident_char = false;

    while let Some(ch) = chars.next() {
        if ch == '\'' {
            out.push('?');
            while let Some(next) = chars.next() {
                if next == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
            prev_ident_char = false;
            continue;
        }
        if ch.is_ascii_digit() && !prev_ident_char {
            out.push('?');
            while let Some(&next) = chars.peek() {
                if next.is_ascii_digit() || next == '.' {
                    chars.next();
                } else {
                    break;
                }
            }
            prev_ident_char = false;
            continue;
        }
        if ch.is_whitespace() {
            if !out.ends_with(' ') {
                out.push(' ');
            }
            prev_ident_char = false;
            continue;
        }
        prev_ident_char = ch.is_ascii_alphanumeric() || ch == '_' || ch == '$';
        out.push(ch);
    }

    out.trim().to_owned()
}

/// Emits a redacted `tracing::warn!` record for a slow SQL operation.
pub fn warn_slow_query(op: &'static str, sql_hint: &str, elapsed: Duration, threshold: Duration) {
    let sanitized = redact_sql_literals(sql_hint);
    tracing::warn!(
        op,
        elapsed_ms = elapsed.as_secs_f64() * 1000.0,
        threshold_ms = threshold.as_secs_f64() * 1000.0,
        sql = %sanitized,
        "slow database query"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_sql_literals_hides_strings_and_numbers_while_preserving_identifiers() {
        let raw = "SELECT id, col_2 FROM channel_message WHERE sender_id = 'secret-user' AND body LIKE '%it''s private%' AND created_at > 1700000000 LIMIT 50";
        let redacted = redact_sql_literals(raw);
        assert!(!redacted.contains("secret-user"));
        assert!(!redacted.contains("private"));
        assert!(!redacted.contains("1700000000"));
        assert!(redacted.contains("col_2"), "identifier digits should stay intact: {redacted}");
        assert_eq!(
            redacted,
            "SELECT id, col_2 FROM channel_message WHERE sender_id = ? AND body LIKE ? AND created_at > ? LIMIT ?"
        );
    }
}
