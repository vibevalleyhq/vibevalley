package runtime

// Per million tokens, in dollars.
type Price struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}
