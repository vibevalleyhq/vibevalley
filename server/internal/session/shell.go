package session

import (
	"regexp"
	"strings"
)

// codex runs every command as `/bin/zsh -lc '<command>'`; the label shows the command, not the shell around it.
var shellWrap = regexp.MustCompile(`^(?:\S*/)?(?:zsh|bash|sh) -l?c (.+)$`)

// shellCommand is the command inside a shell's -c, read as the one shell word the shell would see; anything else, or an
// argument that is not exactly one word, comes back as it is.
func shellCommand(command string) string {
	m := shellWrap.FindStringSubmatch(strings.TrimSpace(command))
	if m == nil {
		return command
	}
	word, ok := shellWord(m[1])
	if !ok {
		return command
	}
	return word
}

// shellWord reads POSIX quoting: '…' as written, "…" with \" \\ \$ \` escaped, and bare characters with \ escaping one.
func shellWord(s string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); {
		switch c := s[i]; c {
		case '\'':
			end := strings.IndexByte(s[i+1:], '\'')
			if end < 0 {
				return "", false
			}
			b.WriteString(s[i+1 : i+1+end])
			i += end + 2
		case '"':
			i++
			for {
				if i >= len(s) {
					return "", false
				}
				if s[i] == '"' {
					i++
					break
				}
				if s[i] == '\\' && i+1 < len(s) && strings.IndexByte("\"\\$`", s[i+1]) >= 0 {
					b.WriteByte(s[i+1])
					i += 2
					continue
				}
				b.WriteByte(s[i])
				i++
			}
		case '\\':
			if i+1 >= len(s) {
				return "", false
			}
			b.WriteByte(s[i+1])
			i += 2
		case ' ', '\t', '\n':
			return "", false
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String(), true
}
