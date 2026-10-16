package base

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"vibevalley/internal/protocol"
)

// Text as the Dart client counts it: in UTF-16 units.

// SpaceClass is JavaScript's \s (and what trim() drops); Go's \s is ASCII only.
const SpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var Spaces = regexp.MustCompile(`[` + SpaceClass + `]+`)

func isSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func Trim(s string) string { return strings.TrimFunc(s, isSpace) }

func TrimEnd(s string) string { return strings.TrimRightFunc(s, isSpace) }

// Units is a string's length in UTF-16 units (JavaScript's length).
func Units(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Slice is JavaScript's s.slice(start, end) in UTF-16 units; a negative start counts from the end.
func Slice(s string, start, end int) string {
	u := utf16.Encode([]rune(s))
	n := len(u)
	if start < 0 {
		start = max(0, n+start)
	}
	if end < 0 {
		end = max(0, n+end)
	}
	start, end = min(start, n), min(end, n)
	if start >= end {
		return ""
	}
	return string(utf16.Decode(u[start:end]))
}

func ClipLine(text string, max int) string {
	flat := strings.Join(strings.Fields(text), " ")
	units := utf16.Encode([]rune(flat))
	if len(units) <= max {
		return flat
	}
	return string(utf16.Decode(units[:max-1])) + "…"
}

// Head is JS's s.slice(0, n): the first n UTF-16 units, without splitting a character.
func Head(s string, n int) string {
	units := 0
	for i, r := range s {
		units += utf16.RuneLen(r)
		if units > n {
			return s[:i]
		}
	}
	return s
}

func InboxLines(messages []InboxMessage) string {
	lines := make([]string, len(messages))
	for i, m := range messages {
		lines[i] = protocol.MessageLine(m)
	}
	return strings.Join(lines, "\n")
}
