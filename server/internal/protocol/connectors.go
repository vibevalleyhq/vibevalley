package protocol

// Connectors: doors into the farm from chat apps (packages/protocol/src/connectors.ts). The rules for which farm
// messages go out to the owner and how they read in a chat app; the shapes are in gen.go.

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

var ConnectorLabel = map[ConnectorID]string{ConnectorIDWeixin: "微信", ConnectorIDFeishu: "飞书", ConnectorIDQq: "QQ"}

// ConnectorMaxChars is how long a message each app takes (UTF-16 units); longer ones are cut.
var ConnectorMaxChars = map[ConnectorID]int{ConnectorIDWeixin: 1800, ConnectorIDFeishu: 4000, ConnectorIDQq: 2000}

// DigestOver: more held messages than this go out as one digest, not one by one.
const DigestOver = 3

// ForOwner is whether a message on the farm's chat is the owner's business in a chat app: the manager's answers,
// what a helper asks or tells them (@主人), every report, every new job. Not the owner's own words (they wrote them),
// notices, or helpers talking among themselves. Only once a message is final: the manager's grow while he speaks.
func ForOwner(m ChatMessage) bool {
	if !m.Final || m.From == "user" {
		return false
	}
	switch m.Kind {
	case MessageKindReport, MessageKindDispatch:
		return true
	case MessageKindNotice:
		return false
	case MessageKindChat:
		return m.FromKind == SenderKindForeman || slices.Contains(m.Mentions, "user") || slices.Contains(m.Mentions, Everyone)
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
	plainHeading  = regexp.MustCompile(`^#{1,6}[` + coreSpaceClass + `]+`)
	plainStrong   = regexp.MustCompile(`\*\*([^` + coreLineEnd + `]+?)\*\*|__([^` + coreLineEnd + `]+?)__`)
	plainEmphasis = regexp.MustCompile(`(^|[^*])\*([^*` + coreSpaceClass + `][^*\n]*?)\*`)
	plainBullet   = regexp.MustCompile(`^[` + coreSpaceClass + `]*[-*+][` + coreSpaceClass + `]+`)
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

// PlainText is Markdown as plain text that reads in a chat bubble: no fences, no emphasis marks, links as
// "text (url)".
func PlainText(markdown string) string {
	s := plainFence.ReplaceAllStringFunc(markdown, func(match string) string {
		return coreTrimEnd(plainFence.FindStringSubmatch(match)[1])
	})
	s = plainTick.ReplaceAllString(s, "${1}")
	s = plainImage.ReplaceAllString(s, "[${1}] ${2}")
	s = plainLink.ReplaceAllString(s, "${1} (${2})")
	s = coreReplaceLineStarts(s, plainHeading, "")
	s = plainStrong.ReplaceAllString(s, "${1}${2}")
	s = plainEmphasis.ReplaceAllString(s, "${1}${2}")
	s = coreReplaceLineStarts(s, plainBullet, "· ")
	s = plainGap.ReplaceAllLiteralString(s, "\n\n")
	return coreTrim(s)
}

// OwnerLine is who said it and where, in front of the words: the owner sees one chat, the farm has many threads.
// where: the message's conversation, nil when not known.
func OwnerLine(m ChatMessage, where *Conversation) string {
	who := m.Name
	if m.FromKind == SenderKindForeman {
		who = "管家"
	}
	what := ""
	switch {
	case m.Kind == MessageKindReport:
		switch {
		case m.Outcome != nil && *m.Outcome == OutcomeCompleted:
			what = "做完了"
		case m.Outcome != nil && *m.Outcome == OutcomeFailed:
			what = "没做成"
		default:
			what = "停下了"
		}
	case m.Kind == MessageKindDispatch:
		what = "派活"
	case where != nil && where.Kind == ConversationKindThread:
		what = "在工单串里"
	}
	head := "【" + who + "】"
	if what != "" {
		head = "【" + who + " · " + what + "】"
	}
	return head + "\n" + PlainText(m.Text)
}

// coreUnitsTrimEnd and coreUnitsTrimStart are JavaScript's trimEnd and trimStart over UTF-16 units (every JS
// whitespace is one unit).
func coreUnitsTrimEnd(u []uint16) []uint16 {
	for len(u) > 0 && coreIsSpace(rune(u[len(u)-1])) {
		u = u[:len(u)-1]
	}
	return u
}

func coreUnitsTrimStart(u []uint16) []uint16 {
	for len(u) > 0 && coreIsSpace(rune(u[0])) {
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

// SplitText is a long text cut into pieces an app takes (max UTF-16 units each), at paragraph or line breaks where
// it can.
func SplitText(text string, max int) []string {
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

// FlushText is held messages going out late: one by one when there are few, else one digest with the first lines
// of each.
func FlushText(lines []string) []string {
	if len(lines) <= DigestOver {
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
		if coreUnits(body) > 60 {
			more = "…"
		}
		firstLines[i] = head + " " + coreSlice(body, 0, 60) + more
	}
	return []string{fmt.Sprintf("你不在的时候有 %d 条消息：\n%s\n\n完整的在农场的田头里。", len(lines), strings.Join(firstLines, "\n"))}
}

var pairingSpace = regexp.MustCompile(`[` + coreSpaceClass + `]+`)

// IsPairing is whether a message is the pairing code: the code alone, spaces and a 配对 in front allowed.
func IsPairing(text, code string) bool {
	return strings.TrimPrefix(pairingSpace.ReplaceAllLiteralString(text, ""), "配对") == code
}

// ShortID is an id as the page shows it: enough to recognise, not to copy.
func ShortID(id string) string {
	if coreUnits(id) > 10 {
		return coreSlice(id, 0, 4) + "…" + coreSlice(id, -4, coreUnits(id))
	}
	return id
}
