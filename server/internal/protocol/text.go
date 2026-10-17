package protocol

import "vibevalley/pkg/x/num"

func Yuan(cny float64) string {
	if cny > 0 && cny < 0.01 {
		return "不到 ¥0.01"
	}
	return "¥" + num.Fixed(cny, 2)
}

const QuotaLow = 15
