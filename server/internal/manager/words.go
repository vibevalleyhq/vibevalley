package manager

import (
	"strconv"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/num"
)

func wan(n int64) string {
	if n >= 10_000 {
		digits := 1
		if n >= 100_000 {
			digits = 0
		}
		return num.Fixed(float64(n)/10_000, digits) + " 万"
	}
	return strconv.FormatInt(n, 10)
}

func spentText(spent protocol.Spent) string {
	tokens := wan(spent.Tokens) + " token"
	if spent.CNY != nil {
		return "约 " + protocol.Yuan(*spent.CNY) + " · " + tokens
	}
	return tokens
}
