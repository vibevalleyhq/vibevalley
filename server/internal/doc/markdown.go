package doc

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"vibevalley/internal/protocol"
)

// Markdown is how a document is traded with agents and MEMORY.md, not how it is stored. What a block is that Markdown has
// no word for goes in an HTML comment (<!-- issue:ID -->, <!-- memory:ID -->), an image's size in its title ("640x480").
// Nesting is two spaces of indent per level. What the export writes, the import reads back to the same blocks.

// mdBlock is a block as Markdown says it: its place is its depth under the block before it.
type mdBlock struct {
	depth int
	typ   string
	attrs protocol.BlockAttrs
	text  []protocol.DocSpan
}

func isList(t string) bool {
	return t == protocol.BlockBulleted || t == protocol.BlockNumbered || t == protocol.BlockTodo
}

// markdownOf writes the live blocks, in document order.
func markdownOf(blocks []protocol.Block) string {
	depth := map[string]int{}
	var b strings.Builder
	var prev *protocol.Block
	numbers := map[string]int{} // parent → the number the run of numbered siblings is at
	for _, blk := range ordered(blocks) {
		d := 0
		if blk.ParentID != nil {
			if pd, ok := depth[*blk.ParentID]; ok {
				d = pd + 1
			}
		}
		depth[blk.ID] = d
		parent := ptrValue(blk.ParentID)
		if blk.Type == protocol.BlockNumbered {
			numbers[parent]++
		} else {
			delete(numbers, parent)
		}
		if prev != nil {
			if isList(prev.Type) && isList(blk.Type) {
				b.WriteString("\n")
			} else {
				b.WriteString("\n\n")
			}
		}
		indent := strings.Repeat("  ", d)
		for i, line := range strings.Split(blockLine(blk, numbers[parent]), "\n") {
			if i > 0 {
				b.WriteString("\n")
			}
			if line != "" {
				b.WriteString(indent + line)
			}
		}
		prev = &blk
	}
	if b.Len() > 0 {
		b.WriteString("\n")
	}
	return b.String()
}

func blockLine(b protocol.Block, number int) string {
	text := inlineOf(b.Text)
	switch b.Type {
	case protocol.BlockHeading:
		level := 1
		if b.Attrs.Level != nil {
			level = min(max(int(*b.Attrs.Level), 1), 3)
		}
		return strings.Repeat("#", level) + " " + text
	case protocol.BlockBulleted:
		return "- " + text
	case protocol.BlockNumbered:
		return strconv.Itoa(number) + ". " + text
	case protocol.BlockTodo:
		if b.Attrs.Checked != nil && *b.Attrs.Checked {
			return "- [x] " + text
		}
		return "- [ ] " + text
	case protocol.BlockQuote:
		return "> " + strings.ReplaceAll(text, "\n", "\n> ")
	case protocol.BlockCode:
		return "```" + ptrValue(b.Attrs.Language) + "\n" + plain(b.Text) + "\n```"
	case protocol.BlockDivider:
		return "---"
	case protocol.BlockImage:
		title := ""
		if b.Attrs.Width != nil && b.Attrs.Height != nil {
			title = fmt.Sprintf(" \"%dx%d\"", *b.Attrs.Width, *b.Attrs.Height)
		}
		return "![" + escape(ptrValue(b.Attrs.Alt)) + "](" + ptrValue(b.Attrs.Src) + title + ")"
	case protocol.BlockIssueRef:
		return "<!-- issue:" + ptrValue(b.Attrs.IssueID) + " -->"
	case protocol.BlockMemoryItem:
		return "<!-- memory:" + ptrValue(b.Attrs.MemoryID) + " --> " + text
	}
	// A paragraph: a line that would read as another block's start is escaped.
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if line != "" && (line[0] == ' ' || classify(line).typ != protocol.BlockParagraph) {
			lines[i] = `\` + line
		}
	}
	return strings.Join(lines, "\n")
}

const specials = "\\*_`~[]"

func escape(t string) string {
	var b strings.Builder
	for _, r := range t {
		if strings.ContainsRune(specials, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func wordy(r rune) bool { return r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r)) }

func inlineOf(spans []protocol.DocSpan) string {
	var b strings.Builder
	spans = normal(spans)
	for i, s := range spans {
		t := escape(s.T)
		if s.Marks.Code {
			t = codeSpan(s.T)
		}
		if s.Marks.Italic {
			// Against a letter or digit an underscore would read as part of a word: a star does not.
			mark := "_"
			if (i > 0 && endsWordy(spans[i-1].T)) || (i+1 < len(spans) && startsWordy(spans[i+1].T)) {
				mark = "*"
			}
			t = mark + t + mark
		}
		if s.Marks.Bold {
			t = "**" + t + "**"
		}
		if s.Marks.Strike {
			t = "~~" + t + "~~"
		}
		if s.Marks.Link != nil {
			t = "[" + t + "](" + *s.Marks.Link + ")"
		}
		b.WriteString(t)
	}
	return b.String()
}

func endsWordy(t string) bool {
	r := []rune(t)
	return len(r) > 0 && wordy(r[len(r)-1])
}

func startsWordy(t string) bool {
	r := []rune(t)
	return len(r) > 0 && wordy(r[0])
}

func codeSpan(t string) string {
	if strings.Contains(t, "`") {
		return "`` " + t + " ``"
	}
	return "`" + t + "`"
}

var (
	headingLine  = regexp.MustCompile(`^(#{1,3}) (.*)$`)
	todoLine     = regexp.MustCompile(`^[-*+] \[( |x|X)\] ?(.*)$`)
	bulletLine   = regexp.MustCompile(`^[-*+] (.*)$`)
	numberLine   = regexp.MustCompile(`^\d+[.)] (.*)$`)
	dividerLine  = regexp.MustCompile(`^(-{3,}|\*{3,}|_{3,})$`)
	imageLine    = regexp.MustCompile(`^!\[((?:\\.|[^\]])*)\]\(([^)\s]*)(?: "(\d+)x(\d+)")?\)$`)
	issueLine    = regexp.MustCompile(`^<!-- issue:(\S+) -->$`)
	memoryLine   = regexp.MustCompile(`^<!-- memory:(\S+) -->(?: (.*))?$`)
	fenceLine    = regexp.MustCompile("^```(\\S*)$")
	quoteLine    = regexp.MustCompile(`^> ?(.*)$`)
	indentPrefix = regexp.MustCompile(`^ *`)
)

// classify reads one line (its indent taken off) as the start of a block; the text is still Markdown.
type lineKind struct {
	typ   string
	attrs protocol.BlockAttrs
	rest  string
}

func classify(line string) lineKind {
	if m := headingLine.FindStringSubmatch(line); m != nil {
		level := int64(len(m[1]))
		return lineKind{typ: protocol.BlockHeading, attrs: protocol.BlockAttrs{Level: &level}, rest: m[2]}
	}
	if dividerLine.MatchString(line) {
		return lineKind{typ: protocol.BlockDivider}
	}
	if m := todoLine.FindStringSubmatch(line); m != nil {
		checked := m[1] != " "
		return lineKind{typ: protocol.BlockTodo, attrs: protocol.BlockAttrs{Checked: &checked}, rest: m[2]}
	}
	if m := bulletLine.FindStringSubmatch(line); m != nil {
		return lineKind{typ: protocol.BlockBulleted, rest: m[1]}
	}
	if m := numberLine.FindStringSubmatch(line); m != nil {
		return lineKind{typ: protocol.BlockNumbered, rest: m[1]}
	}
	if m := fenceLine.FindStringSubmatch(line); m != nil {
		var lang *string
		if m[1] != "" {
			lang = &m[1]
		}
		return lineKind{typ: protocol.BlockCode, attrs: protocol.BlockAttrs{Language: lang}}
	}
	if m := quoteLine.FindStringSubmatch(line); m != nil {
		return lineKind{typ: protocol.BlockQuote, rest: m[1]}
	}
	if m := imageLine.FindStringSubmatch(line); m != nil {
		attrs := protocol.BlockAttrs{Alt: new(plain(inlineSpans(m[1]))), Src: new(m[2])}
		if m[3] != "" {
			w, _ := strconv.ParseInt(m[3], 10, 64)
			h, _ := strconv.ParseInt(m[4], 10, 64)
			attrs.Width, attrs.Height = &w, &h
		}
		return lineKind{typ: protocol.BlockImage, attrs: attrs}
	}
	if m := issueLine.FindStringSubmatch(line); m != nil {
		return lineKind{typ: protocol.BlockIssueRef, attrs: protocol.BlockAttrs{IssueID: new(m[1])}}
	}
	if m := memoryLine.FindStringSubmatch(line); m != nil {
		return lineKind{typ: protocol.BlockMemoryItem, attrs: protocol.BlockAttrs{MemoryID: new(m[1])}, rest: m[2]}
	}
	return lineKind{typ: protocol.BlockParagraph, rest: line}
}

// blocksOfMarkdown reads Markdown into blocks, each with its depth under the block before it.
func blocksOfMarkdown(md string) []mdBlock {
	lines := strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n")
	var out []mdBlock
	// The depth the last block at each level was at: a deeper line goes under the one before it.
	open := 0
	for i := 0; i < len(lines); i++ {
		raw := lines[i]
		if strings.TrimSpace(raw) == "" {
			continue
		}
		spaces := len(indentPrefix.FindString(raw))
		depth := min(spaces/2, open)
		line := raw[spaces:]
		strip := func(l string) (string, bool) {
			if len(indentPrefix.FindString(l)) < spaces {
				return strings.TrimLeft(l, " "), false
			}
			return l[spaces:], true
		}
		k := classify(line)
		switch k.typ {
		case protocol.BlockCode:
			var body []string
			for i++; i < len(lines); i++ {
				l, _ := strip(lines[i])
				if l == "```" {
					break
				}
				body = append(body, l)
			}
			k.rest = strings.Join(body, "\n")
		case protocol.BlockQuote:
			text := []string{k.rest}
			for i+1 < len(lines) {
				l, ok := strip(lines[i+1])
				m := quoteLine.FindStringSubmatch(l)
				if !ok || m == nil || strings.TrimSpace(lines[i+1]) == "" {
					break
				}
				text = append(text, m[1])
				i++
			}
			k.rest = strings.Join(text, "\n")
		case protocol.BlockParagraph:
			text := []string{line}
			for i+1 < len(lines) && strings.TrimSpace(lines[i+1]) != "" {
				l, ok := strip(lines[i+1])
				if !ok || len(indentPrefix.FindString(l)) > 0 || classify(l).typ != protocol.BlockParagraph {
					break
				}
				text = append(text, l)
				i++
			}
			k.rest = strings.Join(text, "\n")
		}
		b := mdBlock{depth: depth, typ: k.typ, attrs: k.attrs}
		switch k.typ {
		case protocol.BlockCode:
			b.text = unmarked([]protocol.DocSpan{{T: k.rest}})
		default:
			b.text = textFor(k.typ, inlineSpans(k.rest))
		}
		out = append(out, b)
		open = depth + 1
	}
	return out
}

// inlineSpans reads Markdown's inline marks: **bold**, _italic_ or *italic*, `code`, ~~strike~~, [text](url), and \ before
// any character to take it as it is.
func inlineSpans(s string) []protocol.DocSpan {
	return normal(inline([]rune(s), protocol.DocMarks{}))
}

func inline(s []rune, m protocol.DocMarks) []protocol.DocSpan {
	var out []protocol.DocSpan
	var buf []rune
	flush := func() {
		if len(buf) > 0 {
			out = append(out, protocol.DocSpan{T: string(buf), Marks: m})
			buf = nil
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s):
			i++
			buf = append(buf, s[i])
			continue
		case c == '`':
			fence := 1
			if i+1 < len(s) && s[i+1] == '`' {
				fence = 2
			}
			if j := closing(s, i+fence, strings.Repeat("`", fence), false); j >= 0 {
				flush()
				body := string(s[i+fence : j])
				if fence == 2 {
					body = strings.TrimSuffix(strings.TrimPrefix(body, " "), " ")
				}
				code := m
				code.Code = true
				out = append(out, protocol.DocSpan{T: body, Marks: code})
				i = j + fence - 1
				continue
			}
		case c == '*' && i+1 < len(s) && s[i+1] == '*', c == '~' && i+1 < len(s) && s[i+1] == '~':
			mark := string([]rune{c, c})
			if j := closing(s, i+2, mark, true); j >= 0 {
				flush()
				inner := m
				if c == '*' {
					inner.Bold = true
				} else {
					inner.Strike = true
				}
				out = append(out, inline(s[i+2:j], inner)...)
				i = j + 1
				continue
			}
		case c == '_' && i > 0 && wordy(s[i-1]):
			// snake_case: an underscore inside a word is a character, as in CommonMark.
		case c == '_' || c == '*':
			if j := closing(s, i+1, string(c), true); j >= 0 && (c == '*' || j+1 >= len(s) || !wordy(s[j+1])) {
				flush()
				inner := m
				inner.Italic = true
				out = append(out, inline(s[i+1:j], inner)...)
				i = j
				continue
			}
		case c == '[':
			if j := closing(s, i+1, "]", true); j >= 0 && j+1 < len(s) && s[j+1] == '(' {
				if k := closing(s, j+2, ")", false); k >= 0 {
					flush()
					inner := m
					inner.Link = new(string(s[j+2 : k]))
					out = append(out, inline(s[i+1:j], inner)...)
					i = k
					continue
				}
			}
		}
		buf = append(buf, c)
	}
	flush()
	return out
}

// closing is where mark next starts at or after from, past at least one character when nonEmpty; escapes and code
// spans are stepped over. -1 when it does not close.
func closing(s []rune, from int, mark string, nonEmpty bool) int {
	m := []rune(mark)
	start := from
	if nonEmpty {
		start++
	}
	for i := from; i < len(s); i++ {
		if mark[0] != '`' {
			if s[i] == '\\' {
				i++
				continue
			}
			if s[i] == '`' {
				if j := closing(s, i+1, "`", false); j >= 0 {
					i = j
					continue
				}
			}
		}
		if i >= start && i+len(m) <= len(s) && string(s[i:i+len(m)]) == mark {
			return i
		}
	}
	return -1
}
