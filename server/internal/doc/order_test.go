package doc

import (
	"slices"
	"testing"

	"vibevalley/internal/protocol"
)

func TestKeyBetween(t *testing.T) {
	for _, c := range []struct{ a, b string }{
		{"", ""}, {"", "V"}, {"V", ""}, {"V", "W"}, {"1", "2"}, {"0V", "1"}, {"a", "a1"}, {"Zz", "a"}, {"az", "b"}, {"", "01"},
	} {
		k, err := keyBetween(c.a, c.b)
		if err != nil {
			t.Fatalf("%q..%q: %v", c.a, c.b, err)
		}
		if !validKey(k) || (c.a != "" && k <= c.a) || (c.b != "" && k >= c.b) {
			t.Errorf("%q..%q gave %q", c.a, c.b, k)
		}
	}
	for _, c := range []struct{ a, b string }{{"b", "a"}, {"a", "a"}, {"a0", ""}, {"", "a-"}, {"", "é"}} {
		if _, err := keyBetween(c.a, c.b); err == nil {
			t.Errorf("%q..%q: taken", c.a, c.b)
		}
	}
}

// Typing at the end, at the start and always in the same gap keeps the keys in order and short enough.
func TestKeysStayInOrder(t *testing.T) {
	for name, next := range map[string]func(keys []string) (int, string, string){
		"append":  func(keys []string) (int, string, string) { return len(keys), last(keys), "" },
		"prepend": func(keys []string) (int, string, string) { return 0, "", first(keys) },
		"same gap": func(keys []string) (int, string, string) {
			if len(keys) < 2 {
				return len(keys), last(keys), ""
			}
			return 1, keys[0], keys[1]
		},
	} {
		var keys []string
		for range 500 {
			at, a, b := next(keys)
			k, err := keyBetween(a, b)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			keys = slices.Insert(keys, at, k)
		}
		if !slices.IsSorted(keys) {
			t.Fatalf("%s: out of order", name)
		}
		if name != "same gap" && len(slices.MaxFunc(keys, func(a, b string) int { return len(a) - len(b) })) > 12 {
			t.Errorf("%s: keys grew long", name)
		}
	}
}

func last(keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	return keys[len(keys)-1]
}

func first(keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	return keys[0]
}

// Two clients that made the same key at the same place still see one order: by id.
func TestSameKeySortsByID(t *testing.T) {
	p := newPage("d", "owner", 1, []protocol.Block{
		{ID: "b2", OrderKey: "V", Type: protocol.BlockParagraph},
		{ID: "b1", OrderKey: "V", Type: protocol.BlockParagraph},
		{ID: "b0", OrderKey: "U", Type: protocol.BlockParagraph},
	})
	var ids []string
	for _, b := range p.children("") {
		ids = append(ids, b.ID)
	}
	if !slices.Equal(ids, []string{"b0", "b1", "b2"}) {
		t.Fatalf("order %v", ids)
	}
}
