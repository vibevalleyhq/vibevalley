package ai

// A host may use a model not listed here: a Model is plain data.

func named(s string) *string { return &s }

func deepseekThinking() ThinkingLevelMap {
	return ThinkingLevelMap{
		ThinkingMinimal: named("high"), ThinkingLow: named("high"), ThinkingMedium: named("high"),
		ThinkingHigh: named("high"), ThinkingXHigh: named("max"), ThinkingMax: named("max"),
	}
}

func deepseek(id, name string, cost ModelCost) Model {
	return Model{
		ID:               id,
		Name:             name,
		API:              "openai-completions",
		Provider:         "deepseek",
		BaseURL:          "https://api.deepseek.com",
		Reasoning:        true,
		Input:            []string{"text"},
		Cost:             cost,
		ContextWindow:    1_000_000,
		MaxTokens:        384_000,
		ThinkingLevelMap: deepseekThinking(),
		Compat:           &Compat{RequiresReasoningContentOnAssistantMessages: true, ThinkingFormat: "deepseek"},
	}
}

// Prices in dollars per million tokens.
var MODELS = []Model{
	deepseek("deepseek-flash", "DeepSeek V4.1 Flash", ModelCost{Input: 0.14, Output: 0.28, CacheRead: 0.028, CacheWrite: 0}),
	deepseek("deepseek-v4-pro", "DeepSeek V4 Pro", ModelCost{Input: 1.74, Output: 3.48, CacheRead: 0.145, CacheWrite: 0}),
}

func GetProviders() []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range MODELS {
		if !seen[m.Provider] {
			seen[m.Provider] = true
			out = append(out, m.Provider)
		}
	}
	return out
}

func GetModels(provider string) []Model {
	var out []Model
	for _, m := range MODELS {
		if m.Provider == provider {
			out = append(out, m)
		}
	}
	return out
}

func GetModel(provider, id string) (Model, bool) {
	for _, m := range MODELS {
		if m.Provider == provider && m.ID == id {
			return m, true
		}
	}
	return Model{}, false
}

func CalculateCost(model Model, usage RawUsage) UsageCost {
	per := func(tokens int, rate float64) float64 { return float64(tokens) * rate / 1_000_000 }
	input := per(usage.Input, model.Cost.Input)
	output := per(usage.Output, model.Cost.Output)
	cacheRead := per(usage.CacheRead, model.Cost.CacheRead)
	cacheWrite := per(usage.CacheWrite, model.Cost.CacheWrite)
	return UsageCost{Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite, Total: input + output + cacheRead + cacheWrite}
}

var thinkingOrder = []string{ThinkingOff, ThinkingMinimal, ThinkingLow, ThinkingMedium, ThinkingHigh, ThinkingXHigh, ThinkingMax}

func GetSupportedThinkingLevels(model Model) []string {
	if !model.Reasoning {
		return []string{ThinkingOff}
	}
	var out []string
	for _, level := range thinkingOrder {
		if v, ok := model.ThinkingLevelMap[level]; ok && v == nil {
			continue
		}
		out = append(out, level)
	}
	return out
}

func indexOf(list []string, s string) int {
	for i, x := range list {
		if x == s {
			return i
		}
	}
	return -1
}

// Not above the one asked for when it can help it.
func ClampThinkingLevel(model Model, level string) string {
	supported := GetSupportedThinkingLevels(model)
	if indexOf(supported, level) >= 0 {
		return level
	}
	at := indexOf(thinkingOrder, level)
	var below []string
	for _, l := range supported {
		if indexOf(thinkingOrder, l) <= at {
			below = append(below, l)
		}
	}
	if len(below) > 0 {
		return below[len(below)-1]
	}
	if len(supported) > 0 {
		return supported[0]
	}
	return ThinkingOff
}

// "" when the model does not have it.
func ProviderThinkingLevel(model Model, level ThinkingLevel) string {
	v, ok := model.ThinkingLevelMap[level]
	if !ok {
		return level
	}
	if v == nil {
		return ""
	}
	return *v
}
