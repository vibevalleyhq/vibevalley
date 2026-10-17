// Package str is text as JavaScript and the Dart client count and trim it: lengths in UTF-16 code units, whitespace as
// JavaScript's \s. What the farm says, stores and cuts is measured this way, so the client shows it the same.
package str

import (
	"regexp"
	"strings"
	"unicode/utf16"
)

// SpaceClass is JavaScript's \s (WhiteSpace and LineTerminator), as the inside of a Go regexp class; Go's \s is
// ASCII only and has no \v.
const SpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var Spaces = regexp.MustCompile(`[` + SpaceClass + `]+`)

// IsSpace is whether r is whitespace to JavaScript's trim and \s.
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func Trim(s string) string      { return strings.TrimFunc(s, IsSpace) }
func TrimStart(s string) string { return strings.TrimLeftFunc(s, IsSpace) }
func TrimEnd(s string) string   { return strings.TrimRightFunc(s, IsSpace) }

// Units is a string's JavaScript length: UTF-16 code units.
func Units(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Slice is JavaScript's s.slice(start, end) over UTF-16 units: negative counts from the end. A surrogate pair
// cut in half becomes U+FFFD.
func Slice(s string, start, end int) string {
	units := utf16.Encode([]rune(s))
	n := len(units)
	clamp := func(i int) int {
		if i < 0 {
			i += n
		}
		return min(max(i, 0), n)
	}
	from, to := clamp(start), clamp(end)
	if from >= to {
		return ""
	}
	return string(utf16.Decode(units[from:to]))
}

// Head is the first n UTF-16 units, without cutting a character in half (it is left out).
func Head(s string, n int) string {
	units := 0
	for i, r := range s {
		w := utf16.RuneLen(r)
		if w < 0 {
			w = 1
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// Cut is s as it is when it fits in max units; else its first max units and an ellipsis.
func Cut(s string, max int) string {
	if Units(s) > max {
		return Slice(s, 0, max) + "…"
	}
	return s
}

// Clip is s on one line (each run of whitespace one space, trimmed), at most max units with the ellipsis.
func Clip(s string, max int) string {
	flat := Trim(Spaces.ReplaceAllString(s, " "))
	if Units(flat) > max {
		return Slice(flat, 0, max-1) + "…"
	}
	return flat
}

// Lower is JavaScript's toLowerCase where it differs from Go's: İ lowers to i and a combining dot.
func Lower(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "İ", "i̇"))
}
