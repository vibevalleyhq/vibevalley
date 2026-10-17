// Package num writes numbers as JavaScript does (String(x), x.toFixed(n), Math.round), so what the farm says about
// money and counts reads the same as the client's.
package num

import (
	"math"
	"math/big"
	"strconv"
	"strings"
)

// Round is JavaScript's Math.round: halves go up. x is rounded to float64 first: Go may fuse the caller's x = a*b into
// x-r (FMA, on arm64), which JavaScript never does, and a half would then fall either way.
func Round(x float64) float64 {
	x = float64(x)
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// Text is JavaScript's String(x) for a number.
func Text(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case x == 0:
		return "0"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	case x < 0:
		return "-" + Text(-x)
	}
	e := strconv.FormatFloat(x, 'e', -1, 64)
	mantissa, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	power, _ := strconv.Atoi(exp)
	k, n := len(digits), power+1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	tail := ""
	if k > 1 {
		tail = "." + digits[1:]
	}
	return digits[:1] + tail + "e" + sign + strconv.Itoa(abs(n-1))
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// Fixed is JavaScript's x.toFixed(digits): the exact value rounded, halves away from zero.
func Fixed(x float64, digits int) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.Abs(x) >= 1e21 {
		return Text(x)
	}
	sign := ""
	if x < 0 {
		sign, x = "-", -x
	}
	scaled := new(big.Float).SetPrec(512).SetFloat64(x)
	scaled.Mul(scaled, new(big.Float).SetPrec(512).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)))
	whole, _ := scaled.Int(nil)
	rest := new(big.Float).SetPrec(512).Sub(scaled, new(big.Float).SetPrec(512).SetInt(whole))
	if rest.Cmp(big.NewFloat(0.5)) >= 0 {
		whole.Add(whole, big.NewInt(1))
	}
	text := whole.String()
	if digits == 0 {
		return sign + text
	}
	if len(text) <= digits {
		text = strings.Repeat("0", digits-len(text)+1) + text
	}
	return sign + text[:len(text)-digits] + "." + text[len(text)-digits:]
}
