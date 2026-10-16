package claude

import (
	"math"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// claudeContextUsageFromResult reads context usage off a result frame
// (context-usage.ts; structured, no need for the human-facing /context
// command): usage.{input,cache_read,cache_creation} tokens are the context
// sent, and modelUsage[first model].contextWindow is the window. The latest
// is the current snapshot (last-write-wins). nil when the frame has no usage.
func claudeContextUsageFromResult(message nativeMessage) *oar.ContextUsage {
	usage := jsonx.AsRecord(message.Record["usage"])
	if usage == nil {
		return nil
	}
	number := func(key string) float64 {
		value, _ := jsonx.Num(usage, key)
		return value
	}
	tokens := int64(number("input_tokens") + number("cache_read_input_tokens") + number("cache_creation_input_tokens"))
	result := &oar.ContextUsage{Tokens: &tokens}
	if jsonx.AsRecord(message.Record["modelUsage"]) != nil {
		first := jsonx.ParseRecord(firstFieldRaw(rawField(message.raw, "modelUsage")))
		if window, ok := jsonx.Num(first, "contextWindow"); ok {
			contextWindow := int64(window)
			result.ContextWindow = &contextWindow
			if window != 0 {
				// Math.round: halves round up.
				percent := math.Floor(float64(tokens)/window*100 + 0.5)
				result.Percent = &percent
			}
		}
	}
	return result
}
