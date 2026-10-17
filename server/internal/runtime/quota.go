package runtime

import (
	"math"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/num"
)

// A nil Value is null: no percentages.
func quotaLeft(usage protocol.AccountUsage) (float64, bool) {
	ok, isOk := usage.Value.(protocol.AccountUsageOk)
	if !isOk || len(ok.Windows) == 0 {
		return 0, false
	}
	least := math.Inf(1)
	for _, w := range ok.Windows {
		least = math.Min(least, 100-w.UsedPercent)
	}
	return math.Max(0, least), true
}

func balanceText(b protocol.Balance) string {
	symbol := b.Currency + " "
	switch b.Currency {
	case "CNY":
		symbol = "¥"
	case "USD":
		symbol = "$"
	}
	return symbol + num.Fixed(b.Amount, 2)
}

func quotaText(usage protocol.AccountUsage) string {
	switch u := usage.Value.(type) {
	case nil:
		return "不报额度"
	case protocol.AccountUsageLoginRequired:
		return "没登录"
	case protocol.AccountUsageUnavailable:
		return "读不到额度（" + u.Reason + "）"
	case protocol.AccountUsageBalance:
		if len(u.Balances) == 0 {
			return u.Provider + " 读不到余额"
		}
		parts := make([]string, len(u.Balances))
		for i, b := range u.Balances {
			parts[i] = balanceText(b)
		}
		short := ""
		if !u.Available {
			short = "，不够用了"
		}
		return u.Provider + " 余额 " + strings.Join(parts, "、") + short
	case protocol.AccountUsageOk:
		if len(u.Windows) == 0 {
			if u.Plan != nil {
				return *u.Plan
			}
			return "有额度"
		}
		parts := make([]string, len(u.Windows))
		for i, w := range u.Windows {
			parts[i] = w.Label + " 剩 " + num.Text(100-w.UsedPercent) + "%"
		}
		return strings.Join(parts, "，")
	}
	return ""
}

// What RuntimeInfo.quota says: the lowest window left, and in words.
func quotaOf(usage protocol.AccountUsage) *protocol.RuntimeQuota {
	q := &protocol.RuntimeQuota{Text: quotaText(usage)}
	if left, ok := quotaLeft(usage); ok {
		q.Left = &left
	}
	return q
}
