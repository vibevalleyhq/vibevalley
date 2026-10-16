package shared

import (
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// The native-reading half of shared/token-totals.ts; the arithmetic
// (addTokens, subtractTokens) is observe.AddTokens / observe.SubtractTokens.

// ReasoningPart sets totals.Reasoning from a native reasoning subset of
// output; absence stays unknown, never inferred from text or effort.
func ReasoningPart(totals *oar.TokenTotals, usage jsonx.Record, field string) {
	if value, ok := jsonx.Num(usage, field); ok {
		reasoning := int64(value)
		totals.Reasoning = &reasoning
	}
}

// CacheParts sets the cache parts a native usage record reports, read from
// the runtime's own field names: a field the record lacks (or that is not a
// number) stays absent, never a guessed 0.
func CacheParts(totals *oar.TokenTotals, usage jsonx.Record, read, write string) {
	if value, ok := jsonx.Num(usage, read); ok {
		cacheRead := int64(value)
		totals.CacheRead = &cacheRead
	}
	if value, ok := jsonx.Num(usage, write); ok {
		cacheWrite := int64(value)
		totals.CacheWrite = &cacheWrite
	}
}
