package codex

import (
	"math"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// codex's `thread/tokenUsage/updated` read as a `usage` event, and the
// baseline that makes its totals count from when this Session opened (#169;
// token-usage.ts). Pure: the projection fold carries the baseline in its state.

// codexTokenBaseline is where the root thread's token count starts. codex's
// `total` spans the thread's life: after a resume, before this Session's
// first turn starts, codex re-reports it once, under the previous turn's id
// ([env] 0.151.0 and later). A new thread counts from zero; a resumed one
// from that re-report. A resumed thread whose first turn starts without one
// (codex before 0.151.0) has no known start: don't know, don't report, so its
// totals are left out of every later root usage event.
//
// Kind is "awaiting" (a resumed thread whose re-report may still come),
// "known" (root totals count from Tokens) or "unknown" (a resumed thread
// whose first turn started without a re-report).
type codexTokenBaseline struct {
	Kind   string
	Tokens oar.TokenTotals
}

var fromZero = codexTokenBaseline{Kind: "known"}

func initialTokenBaseline(resumed bool) codexTokenBaseline {
	if resumed {
		return codexTokenBaseline{Kind: "awaiting"}
	}
	return fromZero
}

// baselineTokens is what root totals count from; nil when unknown (no `tokens` then).
func baselineTokens(baseline codexTokenBaseline) *oar.TokenTotals {
	if baseline.Kind != "known" {
		return nil
	}
	tokens := baseline.Tokens
	return &tokens
}

// reportedTotal is codex's own running total in a `thread/tokenUsage/updated`; nil when it carries none.
func reportedTotal(params jsonx.Record) *oar.TokenTotals {
	total := jsonx.AsRecord(jsonx.AsRecord(params["tokenUsage"])["total"])
	input, inputOK := jsonx.Num(total, "inputTokens")
	output, outputOK := jsonx.Num(total, "outputTokens")
	if total == nil || !inputOK || !outputOK {
		return nil
	}
	// `inputTokens` already counts the cache reads and writes;
	// `cachedInputTokens` and `cacheWriteInputTokens` are those parts
	// (codex-api sse/responses.rs at 4f39251a fills them from the Responses
	// API's `input_tokens_details` `cached_tokens` / `cache_write_tokens`). A
	// build without the write field reports no `cacheWrite`.
	totals := oar.TokenTotals{Input: int64(input), Output: int64(output)}
	shared.CacheParts(&totals, total, "cachedInputTokens", "cacheWriteInputTokens")
	shared.ReasoningPart(&totals, total, "reasoningOutputTokens")
	return &totals
}

// nextTokenBaseline is the baseline after one root-thread notification:
// while a resume awaits it, the first root total is the re-report and
// becomes the baseline, and a root `turn/started` arriving first leaves it
// unknown. Unchanged otherwise.
func nextTokenBaseline(baseline codexTokenBaseline, method string, params jsonx.Record) codexTokenBaseline {
	if baseline.Kind != "awaiting" {
		return baseline
	}
	if method == "turn/started" {
		return codexTokenBaseline{Kind: "unknown"}
	}
	if method != "thread/tokenUsage/updated" {
		return baseline
	}
	reported := reportedTotal(params)
	if reported == nil {
		return baseline
	}
	return codexTokenBaseline{Kind: "known", Tokens: *reported}
}

func int64Of(value any) *int64 {
	number, ok := jsonx.AsNumber(value)
	if !ok {
		return nil
	}
	converted := int64(number)
	return &converted
}

// codexUsageViews reads a `thread/tokenUsage/updated`. `tokenUsage.total`
// accumulates over every model call of the thread's life (input 12.6k →
// 28.4k → 44.2k across three one-word turns, codex 0.154.0), so it is the
// running spend, not what the context holds; less baseline (the thread's
// total before this Session opened) it is this Session's `tokens`, so the
// re-report itself reads zero, and with no known baseline (nil) there are no
// `tokens`. `tokenUsage.last` is the most recent model call, and
// `modelContextWindow` the window it fit in; those two are the context
// reading, whatever the baseline. Codex's own occupancy figure is
// `last.total_tokens` (`TokenUsage::tokens_in_context_window`, protocol.rs at
// 4f39251a); oar reads the same field, `last.totalTokens`: the last call's
// input (cached tokens included) plus its output. When `last` is absent
// (older builds) the occupancy is unknown: the cumulative input stands in as
// `tokens` and the window and percent are null: the cumulative total is
// never read against the window.
func codexUsageViews(params jsonx.Record, baseline *oar.TokenTotals) []oar.EventBody {
	tokenUsage := jsonx.AsRecord(params["tokenUsage"])
	total := jsonx.AsRecord(tokenUsage["total"])
	if total == nil {
		return nil
	}
	report := oar.UsageReport{}
	if reported := reportedTotal(params); reported != nil && baseline != nil {
		tokens := observe.SubtractTokens(*reported, *baseline)
		report.Tokens = &tokens
	}
	last := jsonx.AsRecord(tokenUsage["last"])
	if last == nil {
		report.Context = &oar.ContextUsage{Tokens: int64Of(total["inputTokens"])}
		return []oar.EventBody{oar.Usage{Usage: report}}
	}
	contextTokens := int64Of(last["totalTokens"])
	contextWindow := int64Of(tokenUsage["modelContextWindow"])
	var percent *float64
	if contextTokens != nil && contextWindow != nil && *contextWindow > 0 {
		value := math.Floor(float64(*contextTokens)/float64(*contextWindow)*100 + 0.5)
		percent = &value
	}
	report.Context = &oar.ContextUsage{Tokens: contextTokens, ContextWindow: contextWindow, Percent: percent}
	return []oar.EventBody{oar.Usage{Usage: report}}
}
