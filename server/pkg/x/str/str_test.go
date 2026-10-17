package str

import "testing"

func TestCountedInUTF16Units(t *testing.T) {
	for _, c := range []struct {
		got, want any
	}{
		{Units("田头"), 2},
		{Units("🌾a"), 3},
		{Slice("🌾ab", 2, 3), "a"},
		{Slice("🌾ab", 1, 3), "\ufffda"},
		{Slice("abc", -2, 3), "bc"},
		{Head("🌾ab", 1), ""},
		{Head("🌾ab", 3), "🌾a"},
		{Cut("一二三四", 2), "一二…"},
		{Cut("一二", 2), "一二"},
		{Clip("  一\n二\t三 四 ", 4), "一 二…"},
		{Clip("一 二", 9), "一 二"},
		{Trim("\ufeff 好 \u3000"), "好"},
		{Lower("İ"), "i̇"},
		{IsSpace('\u0085'), false},
	} {
		if c.got != c.want {
			t.Errorf("got %#v, want %#v", c.got, c.want)
		}
	}
}
