package manager

import (
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func TestMoneyWords(t *testing.T) {
	testkit.Eq(t, spentText(protocol.Spent{Tokens: 26_000, CNY: ptr.To(0.03)}), "约 ¥0.03 · 2.6 万 token")
	testkit.Eq(t, spentText(protocol.Spent{Tokens: 12_500}), "1.3 万 token", "toFixed rounds halves up")
}
