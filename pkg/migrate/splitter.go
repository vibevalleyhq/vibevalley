package migrate

import "strings"

type blockKind uint8

const (
	blockBegin blockKind = iota + 1
	blockCase
)

// SplitStatements splits a SQL script into executable non-empty statements.
// It preserves semicolons inside string literals, quoted identifiers,
// dollar-quoted blocks, comments, and compound BEGIN...END blocks (such as
// SQLite CREATE TRIGGER bodies) while distinguishing CASE...END expressions
// and standalone transaction BEGIN statements.
func SplitStatements(sqlText string) []string {
	sqlText = strings.TrimPrefix(sqlText, "\ufeff")
	n := len(sqlText)
	if n == 0 {
		return nil
	}

	var (
		stmts          []string
		blockStack     []blockKind
		stmtStart      int
		hasExecutable  bool
		stmtTokenCount int
		prevToken      string
	)

	for i := 0; i < n; {
		ch := sqlText[i]

		if isASCIIWhitespace(ch) {
			i++
			continue
		}

		// Line comment: -- ... \n
		if ch == '-' && i+1 < n && sqlText[i+1] == '-' {
			i += 2
			for i < n && sqlText[i] != '\n' {
				i++
			}
			if i < n {
				i++
			}
			continue
		}

		// Block comment: /* ... */
		if ch == '/' && i+1 < n && sqlText[i+1] == '*' {
			i += 2
			if end := strings.Index(sqlText[i:], "*/"); end >= 0 {
				i += end + 2
			} else {
				i = n
			}
			continue
		}

		// Single-quoted string literal ('...' with '' escape).
		if ch == '\'' {
			i = scanQuoted(sqlText, i, '\'')
			hasExecutable = true
			stmtTokenCount++
			prevToken = "'"
			continue
		}

		// Double-quoted identifier ("..." with "" escape).
		if ch == '"' {
			i = scanQuoted(sqlText, i, '"')
			hasExecutable = true
			stmtTokenCount++
			prevToken = `"`
			continue
		}

		// Backtick-quoted identifier (`...` with `` escape).
		if ch == '`' {
			i = scanQuoted(sqlText, i, '`')
			hasExecutable = true
			stmtTokenCount++
			prevToken = "`"
			continue
		}

		// PostgreSQL dollar-quoted string ($tag$...$tag$).
		if ch == '$' {
			if span, ok := matchDollarQuote(sqlText[i:]); ok {
				i += span
				hasExecutable = true
				stmtTokenCount++
				prevToken = "$"
				continue
			}
		}

		if ch == ';' {
			if len(blockStack) == 0 {
				if hasExecutable {
					if stmt := strings.TrimSpace(sqlText[stmtStart:i]); stmt != "" {
						stmts = append(stmts, stmt)
					}
				}
				stmtStart = i + 1
				hasExecutable = false
				stmtTokenCount = 0
				prevToken = ""
			} else {
				hasExecutable = true
				stmtTokenCount++
				prevToken = ";"
			}
			i++
			continue
		}

		if isIdentStart(ch) {
			start := i
			i++
			for i < n && isIdentCont(sqlText[i]) {
				i++
			}
			word := sqlText[start:i]
			if prevToken != "." {
				switch {
				case strings.EqualFold(word, "CASE"):
					blockStack = append(blockStack, blockCase)
				case strings.EqualFold(word, "BEGIN"):
					if stmtTokenCount > 0 || !isTransactionBeginLookahead(sqlText, i) {
						blockStack = append(blockStack, blockBegin)
					}
				case strings.EqualFold(word, "END"):
					if len(blockStack) > 0 {
						blockStack = blockStack[:len(blockStack)-1]
					}
				}
			}
			hasExecutable = true
			stmtTokenCount++
			prevToken = word
			continue
		}

		hasExecutable = true
		stmtTokenCount++
		prevToken = sqlText[i : i+1]
		i++
	}

	if hasExecutable {
		if stmt := strings.TrimSpace(sqlText[stmtStart:]); stmt != "" {
			stmts = append(stmts, stmt)
		}
	}

	return stmts
}

func scanQuoted(s string, start int, quote byte) int {
	n := len(s)
	i := start + 1
	for i < n {
		if s[i] == quote {
			if i+1 < n && s[i+1] == quote {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return n
}

func matchDollarQuote(s string) (int, bool) {
	n := len(s)
	if n < 2 || s[0] != '$' {
		return 0, false
	}

	tagEnd := -1
	if s[1] == '$' {
		tagEnd = 2
	} else if isIdentStart(s[1]) {
		j := 2
		for j < n && isIdentCont(s[j]) {
			j++
		}
		if j < n && s[j] == '$' {
			tagEnd = j + 1
		}
	}
	if tagEnd < 0 {
		return 0, false
	}

	delim := s[:tagEnd]
	closeIdx := strings.Index(s[tagEnd:], delim)
	if closeIdx < 0 {
		return 0, false
	}
	return tagEnd + closeIdx + len(delim), true
}

func isTransactionBeginLookahead(sqlText string, pos int) bool {
	next := peekNextToken(sqlText, pos)
	if next == "" || next == ";" {
		return true
	}
	switch {
	case strings.EqualFold(next, "TRANSACTION"),
		strings.EqualFold(next, "DEFERRED"),
		strings.EqualFold(next, "IMMEDIATE"),
		strings.EqualFold(next, "EXCLUSIVE"),
		strings.EqualFold(next, "WORK"),
		strings.EqualFold(next, "ISOLATION"),
		strings.EqualFold(next, "READ"),
		strings.EqualFold(next, "DEFERRABLE"),
		strings.EqualFold(next, "NOT"):
		return true
	default:
		return false
	}
}

func peekNextToken(sqlText string, pos int) string {
	n := len(sqlText)
	for pos < n {
		ch := sqlText[pos]
		if isASCIIWhitespace(ch) {
			pos++
			continue
		}
		if ch == '-' && pos+1 < n && sqlText[pos+1] == '-' {
			pos += 2
			for pos < n && sqlText[pos] != '\n' {
				pos++
			}
			if pos < n {
				pos++
			}
			continue
		}
		if ch == '/' && pos+1 < n && sqlText[pos+1] == '*' {
			pos += 2
			if end := strings.Index(sqlText[pos:], "*/"); end >= 0 {
				pos += end + 2
			} else {
				pos = n
			}
			continue
		}
		if isIdentStart(ch) {
			start := pos
			pos++
			for pos < n && isIdentCont(sqlText[pos]) {
				pos++
			}
			return sqlText[start:pos]
		}
		return sqlText[pos : pos+1]
	}
	return ""
}

func isASCIIWhitespace(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\v' || ch == '\f'
}

func isIdentStart(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_'
}

func isIdentCont(ch byte) bool {
	return isIdentStart(ch) || (ch >= '0' && ch <= '9')
}
