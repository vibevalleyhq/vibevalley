package num

import "testing"

func TestAsJavaScriptWritesThem(t *testing.T) {
	for _, c := range []struct {
		got, want string
	}{
		{Text(66.7), "66.7"},
		{Text(1e21), "1e+21"},
		{Text(1.5e-7), "1.5e-7"},
		{Text(123456789012), "123456789012"},
		{Text(-0.5), "-0.5"},
		{Fixed(0.125, 2), "0.13"},
		{Fixed(1.005, 2), "1.00"},
		{Fixed(2.5, 0), "3"},
		{Fixed(-1.5, 0), "-2"},
	} {
		if c.got != c.want {
			t.Errorf("got %q, want %q", c.got, c.want)
		}
	}
	if Round(2.5) != 3 || Round(-2.5) != -2 {
		t.Error("Math.round: halves go up")
	}
}

// 35 × 1.7 is 59.5 once rounded to float64, but a hair under exactly: fused into x−r (arm64) it would round down.
func TestRoundAProduct(t *testing.T) {
	for _, c := range []struct{ a, b, want float64 }{{35, 1.7, 60}, {51, 1.5, 77}} {
		if got := Round(c.a * c.b); got != c.want {
			t.Fatalf("Math.round(%v*%v) is %v, got %v", c.a, c.b, c.want, got)
		}
	}
}
