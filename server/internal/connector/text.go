package connector

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

// In UTF-16 units; longer ones are cut.
var maxChars = map[protocol.ConnectorID]int{protocol.ConnectorIDWeixin: 1800, protocol.ConnectorIDFeishu: 4000, protocol.ConnectorIDQq: 2000}

const digestOver = 3

// Only once a message is final: the manager's grow while he speaks.
func forOwner(m protocol.ChatMessage) bool {
	if !m.Final || m.From == "user" {
		return false
	}
	switch m.Kind {
	case protocol.MessageKindReport, protocol.MessageKindDispatch:
		return true
	case protocol.MessageKindNotice:
		return false
	case protocol.MessageKindChat:
		return m.FromKind == protocol.SenderKindManager || slices.Contains(m.Mentions, "user") || slices.Contains(m.Mentions, protocol.Everyone)
	}
	return false
}

// coreLineEnd is what ends a line to JavaScript's . and multiline ^.
const coreLineEnd = `\n\r\x{2028}\x{2029}`

var (
	plainFence    = regexp.MustCompile("```[^\\n]*\\n((?s:.*?))```")
	plainTick     = regexp.MustCompile("`([^`\\n]+)`")
	plainImage    = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)
	plainLink     = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
	plainHeading  = regexp.MustCompile(`^#{1,6}[` + str.SpaceClass + `]+`)
	plainStrong   = regexp.MustCompile(`\*\*([^` + coreLineEnd + `]+?)\*\*|__([^` + coreLineEnd + `]+?)__`)
	plainEmphasis = regexp.MustCompile(`(^|[^*])\*([^*` + str.SpaceClass + `][^*\n]*?)\*`)
	plainBullet   = regexp.MustCompile(`^[` + str.SpaceClass + `]*[-*+][` + str.SpaceClass + `]+`)
	plainGap      = regexp.MustCompile(`\n{3,}`)
)

// coreAtLineStart is whether i is where a line starts, as JavaScript's multiline ^ sees it.
func coreAtLineStart(s string, i int) bool {
	if i == 0 {
		return true
	}
	if s[i-1] == '\n' || s[i-1] == '\r' {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(s[:i])
	return r == 0x2028 || r == 0x2029
}

// coreReplaceLineStarts is JavaScript's s.replace(/^…/gm, repl) for a pattern anchored with ^ (and never empty):
// Go's (?m) knows only \n as a line's end.
func coreReplaceLineStarts(s string, re *regexp.Regexp, repl string) string {
	var b strings.Builder
	last, pos := 0, 0
	for pos < len(s) {
		if coreAtLineStart(s, pos) {
			if loc := re.FindStringIndex(s[pos:]); loc != nil && loc[1] > 0 {
				b.WriteString(s[last:pos])
				b.WriteString(repl)
				pos += loc[1]
				last = pos
				continue
			}
		}
		_, size := utf8.DecodeRuneInString(s[pos:])
		pos += size
	}
	b.WriteString(s[last:])
	return b.String()
}

func plainText(markdown string) string {
	s := plainFence.ReplaceAllStringFunc(markdown, func(match string) string {
		return str.TrimEnd(plainFence.FindStringSubmatch(match)[1])
	})
	s = plainTick.ReplaceAllString(s, "${1}")
	s = plainImage.ReplaceAllString(s, "[${1}] ${2}")
	s = plainLink.ReplaceAllString(s, "${1} (${2})")
	s = coreReplaceLineStarts(s, plainHeading, "")
	s = plainStrong.ReplaceAllString(s, "${1}${2}")
	s = plainEmphasis.ReplaceAllString(s, "${1}${2}")
	s = coreReplaceLineStarts(s, plainBullet, "· ")
	s = plainGap.ReplaceAllLiteralString(s, "\n\n")
	return str.Trim(s)
}

// The owner sees one chat, the farm has many threads.
func ownerLine(m protocol.ChatMessage, where *protocol.Conversation) string {
	who := m.Name
	if m.FromKind == protocol.SenderKindManager {
		who = "管家"
	}
	what := ""
	switch {
	case m.Kind == protocol.MessageKindReport:
		switch {
		case m.Outcome != nil && *m.Outcome == protocol.OutcomeCompleted:
			what = "做完了"
		case m.Outcome != nil && *m.Outcome == protocol.OutcomeFailed:
			what = "没做成"
		default:
			what = "停下了"
		}
	case m.Kind == protocol.MessageKindDispatch:
		what = "派活"
	case where != nil && where.Kind == protocol.ConversationKindThread:
		what = "在工单串里"
	}
	head := "【" + who + "】"
	if what != "" {
		head = "【" + who + " · " + what + "】"
	}
	return head + "\n" + plainText(m.Text)
}

// Every JS whitespace is one unit.
func coreUnitsTrimEnd(u []uint16) []uint16 {
	for len(u) > 0 && str.IsSpace(rune(u[len(u)-1])) {
		u = u[:len(u)-1]
	}
	return u
}

func coreUnitsTrimStart(u []uint16) []uint16 {
	for len(u) > 0 && str.IsSpace(rune(u[0])) {
		u = u[1:]
	}
	return u
}

func coreLastIndex(u []uint16, of string) int {
	needle := utf16.Encode([]rune(of))
	for i := len(u) - len(needle); i >= 0; i-- {
		if slices.Equal(u[i:i+len(needle)], needle) {
			return i
		}
	}
	return -1
}

func splitText(text string, max int) []string {
	pieces := []string{}
	rest := utf16.Encode([]rune(text))
	for len(rest) > max {
		window := rest[:max]
		cut := coreLastIndex(window, "\n\n")
		if i := coreLastIndex(window, "\n"); i > cut {
			cut = i
		}
		at := max
		if cut*2 > max {
			at = cut
		}
		pieces = append(pieces, string(utf16.Decode(coreUnitsTrimEnd(rest[:at]))))
		rest = coreUnitsTrimStart(rest[at:])
	}
	if len(rest) > 0 {
		pieces = append(pieces, string(utf16.Decode(rest)))
	}
	return pieces
}

func flushText(lines []string) []string {
	if len(lines) <= digestOver {
		return lines
	}
	firstLines := make([]string, len(lines))
	for i, l := range lines {
		parts := strings.SplitN(l, "\n", 3)
		head, body := parts[0], ""
		if len(parts) > 1 {
			body = parts[1]
		}
		more := ""
		if str.Units(body) > 60 {
			more = "…"
		}
		firstLines[i] = head + " " + str.Slice(body, 0, 60) + more
	}
	return []string{fmt.Sprintf("你不在的时候有 %d 条消息：\n%s\n\n完整的在农场的田头里。", len(lines), strings.Join(firstLines, "\n"))}
}

// Spaces and a 配对 in front allowed.
func isPairing(text, code string) bool {
	return strings.TrimPrefix(str.Spaces.ReplaceAllLiteralString(text, ""), "配对") == code
}

// Enough to recognise, not to copy.
func shortID(id string) string {
	if str.Units(id) > 10 {
		return str.Slice(id, 0, 4) + "…" + str.Slice(id, -4, str.Units(id))
	}
	return id
}
