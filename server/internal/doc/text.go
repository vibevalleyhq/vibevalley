package doc

import (
	"strings"

	"vibevalley/internal/protocol"
)

// Offsets into a block's text count Unicode code points (runes), as the op contract says; Dart counts UTF-16 units and
// pkg/x/str (the farm's words for people) does too, so nothing here uses str.

func plain(spans []protocol.DocSpan) string {
	var b strings.Builder
	for _, s := range spans {
		b.WriteString(s.T)
	}
	return b.String()
}

func runeLen(spans []protocol.DocSpan) int {
	n := 0
	for _, s := range spans {
		n += len([]rune(s.T))
	}
	return n
}

func sameMarks(a, b protocol.DocMarks) bool {
	if a.Bold != b.Bold || a.Italic != b.Italic || a.Code != b.Code || a.Strike != b.Strike || (a.Link == nil) != (b.Link == nil) {
		return false
	}
	return a.Link == nil || *a.Link == *b.Link
}

// normal drops empty spans and joins neighbours with the same marks, so one text has one way to be written.
func normal(spans []protocol.DocSpan) []protocol.DocSpan {
	out := []protocol.DocSpan{}
	for _, s := range spans {
		if s.T == "" {
			continue
		}
		if n := len(out); n > 0 && sameMarks(out[n-1].Marks, s.Marks) {
			out[n-1].T += s.T
			continue
		}
		out = append(out, s)
	}
	return out
}

func sameText(a, b []protocol.DocSpan) bool {
	a, b = normal(a), normal(b)
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].T != b[i].T || !sameMarks(a[i].Marks, b[i].Marks) {
			return false
		}
	}
	return true
}

// splitAt cuts spans at a code-point offset, 0 ≤ at ≤ runeLen(spans).
func splitAt(spans []protocol.DocSpan, at int) (left, right []protocol.DocSpan) {
	for _, s := range spans {
		r := []rune(s.T)
		switch {
		case at <= 0:
			right = append(right, s)
		case at >= len(r):
			left = append(left, s)
		default:
			left = append(left, protocol.DocSpan{T: string(r[:at]), Marks: s.Marks})
			right = append(right, protocol.DocSpan{T: string(r[at:]), Marks: s.Marks})
		}
		at -= len(r)
	}
	return normal(left), normal(right)
}

func joined(a, b []protocol.DocSpan) []protocol.DocSpan {
	return normal(append(append([]protocol.DocSpan{}, a...), b...))
}

// Code has no marks.
func unmarked(spans []protocol.DocSpan) []protocol.DocSpan {
	if t := plain(spans); t != "" {
		return []protocol.DocSpan{{T: t}}
	}
	return []protocol.DocSpan{}
}
