package doc

import (
	"testing"

	"vibevalley/internal/protocol"
)

func span(t string) protocol.DocSpan { return protocol.DocSpan{T: t} }

func bold(t string) protocol.DocSpan {
	return protocol.DocSpan{T: t, Marks: protocol.DocMarks{Bold: true}}
}

// Offsets are code points: 中 is one, 👍 one (two UTF-16 units), 👍🏽 two, é written as e and a combining accent two.
func TestSplitCountsCodePoints(t *testing.T) {
	for _, c := range []struct {
		name        string
		text        []protocol.DocSpan
		at          int
		left, right string
	}{
		{"chinese", []protocol.DocSpan{span("你好世界")}, 2, "你好", "世界"},
		{"emoji", []protocol.DocSpan{span("a👍b")}, 2, "a👍", "b"},
		{"skin tone", []protocol.DocSpan{span("👍🏽x")}, 2, "👍🏽", "x"},
		{"combining", []protocol.DocSpan{span("ét")}, 2, "é", "t"},
		{"start", []protocol.DocSpan{span("ab")}, 0, "", "ab"},
		{"end", []protocol.DocSpan{span("ab")}, 2, "ab", ""},
		{"across spans", []protocol.DocSpan{span("你"), bold("好世"), span("界")}, 2, "你好", "世界"},
	} {
		l, r := splitAt(c.text, c.at)
		if plain(l) != c.left || plain(r) != c.right {
			t.Errorf("%s: %q | %q", c.name, plain(l), plain(r))
		}
		if runeLen(l)+runeLen(r) != runeLen(c.text) {
			t.Errorf("%s: lost text", c.name)
		}
	}
	l, r := splitAt([]protocol.DocSpan{span("你"), bold("好世"), span("界")}, 2)
	if !sameText(l, []protocol.DocSpan{span("你"), bold("好")}) || !sameText(r, []protocol.DocSpan{bold("世"), span("界")}) {
		t.Fatalf("marks not kept: %v | %v", l, r)
	}
}

func TestNormalJoinsLikeMarks(t *testing.T) {
	got := normal([]protocol.DocSpan{span("a"), span(""), span("b"), bold("c"), bold("d")})
	if len(got) != 2 || got[0].T != "ab" || got[1].T != "cd" {
		t.Fatalf("%v", got)
	}
}
