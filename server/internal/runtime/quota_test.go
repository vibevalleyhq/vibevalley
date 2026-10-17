package runtime

import (
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func TestQuotaWords(t *testing.T) {
	testkit.Eq(t, quotaText(protocol.AccountUsage{Value: protocol.AccountUsageOk{Windows: []protocol.UsageWindow{{Label: "5 小时", UsedPercent: 33.3}}}}), "5 小时 剩 66.7%")
	left, ok := quotaLeft(protocol.AccountUsage{Value: protocol.AccountUsageOk{Windows: []protocol.UsageWindow{{UsedPercent: 30}, {UsedPercent: 120}}}})
	testkit.Eq(t, [2]any{left, ok}, [2]any{0.0, true})
	q := quotaOf(protocol.AccountUsage{Value: protocol.AccountUsageOk{Windows: []protocol.UsageWindow{{Label: "5 小时", UsedPercent: 40}}}})
	testkit.Eq(t, *q.Left, 60.0, "the lowest window left")
	testkit.Eq(t, q.Text, "5 小时 剩 60%", "in words")
	testkit.Eq(t, quotaOf(protocol.AccountUsage{Value: protocol.AccountUsageLoginRequired{}}).Left, (*float64)(nil), "no windows, nothing left to say")
}
