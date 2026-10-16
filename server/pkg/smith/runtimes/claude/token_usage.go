package claude

import (
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// claude's token readings (token-usage.ts): the root agent's main loop
// (result.usage) and the session total, read off result.modelUsage (#282).
// claude's schema calls result.usage "MAIN AGENT LOOP ONLY" and modelUsage
// the per-model totals of every model call, cumulative across turns: each
// result carries the running total, so the latest is read, never summed.
//
// The total counts from when this Session opened. A new session's running
// total starts at zero. A resumed one continues the previous process's, so
// before the first turn the adapter asks claude get_usage, whose
// session.model_usage is that running total, and every later total is less
// that baseline, model by model. Without a baseline the share is unknown:
// don't know, don't report.

var noTokens = oar.TokenTotals{}

// cacheParts reads the optional cache counts of a usage record.
func cacheParts(usage jsonx.Record, read, write string) (cacheRead, cacheWrite *int64) {
	if value, ok := jsonx.Num(usage, read); ok {
		count := int64(value)
		cacheRead = &count
	}
	if value, ok := jsonx.Num(usage, write); ok {
		count := int64(value)
		cacheWrite = &count
	}
	return cacheRead, cacheWrite
}

func valueOr0(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

// withMainLoop is previous plus one result's main-loop tokens (result.usage,
// per turn), or nil when the frame carries no usage. input_tokens excludes
// the cache reads and writes, so input counts them back in; each also
// stands as its own part when the frame reports it.
func withMainLoop(previous *oar.TokenTotals, message jsonx.Record) *oar.TokenTotals {
	usage := jsonx.AsRecord(message["usage"])
	if usage == nil {
		return nil
	}
	cacheRead, cacheWrite := cacheParts(usage, "cache_read_input_tokens", "cache_creation_input_tokens")
	input, _ := jsonx.Num(usage, "input_tokens")
	output, _ := jsonx.Num(usage, "output_tokens")
	base := noTokens
	if previous != nil {
		base = *previous
	}
	total := observe.AddTokens(base, oar.TokenTotals{
		Input:      int64(input) + valueOr0(cacheRead) + valueOr0(cacheWrite),
		Output:     int64(output),
		CacheRead:  cacheRead,
		CacheWrite: cacheWrite,
	})
	return &total
}

// modelTotalsMap is claude's running totals, by model.
type modelTotalsMap map[string]oar.TokenTotals

// usageBaseline is where this Session's share of claude's running total
// starts: "awaiting" (a resume whose get_usage answer has not come yet),
// "known" (Models) or "unknown" (a resume whose get_usage timed out, failed
// or carried no session totals).
type usageBaseline struct {
	Kind   string
	Models modelTotalsMap
}

// modelUsage is the running-total fold state.
type modelUsage struct {
	Baseline usageBaseline
	// The running total claude last reported (the baseline before any): a lower one is a reset.
	Last modelTotalsMap
	// This Session's share counted before claude last reset its running total (a /clear).
	Carried oar.TokenTotals
}

// freshModelUsage: a new session's running total and this Session's share both start at zero.
var freshModelUsage = modelUsage{Baseline: usageBaseline{Kind: "known", Models: modelTotalsMap{}}, Last: modelTotalsMap{}, Carried: noTokens}

// resumedModelUsage: a resume counts nothing until the baseline is known.
var resumedModelUsage = modelUsage{Baseline: usageBaseline{Kind: "awaiting"}, Last: modelTotalsMap{}, Carried: noTokens}

// modelTokens is one model's entry: inputTokens excludes the cache reads
// and writes, so input counts them back in, and each stands as its own
// part. nil when the entry lacks a count.
func modelTokens(entry jsonx.Record) *oar.TokenTotals {
	input, inputOK := jsonx.Num(entry, "inputTokens")
	output, outputOK := jsonx.Num(entry, "outputTokens")
	if !inputOK || !outputOK {
		return nil
	}
	cacheRead, cacheWrite := cacheParts(entry, "cacheReadInputTokens", "cacheCreationInputTokens")
	return &oar.TokenTotals{Input: int64(input) + valueOr0(cacheRead) + valueOr0(cacheWrite), Output: int64(output), CacheRead: cacheRead, CacheWrite: cacheWrite}
}

// modelTotals reads a modelUsage (or get_usage model_usage) map per model;
// nil when it is not one or an entry lacks its counts.
func modelTotals(value any) modelTotalsMap {
	record := jsonx.AsRecord(value)
	if record == nil {
		return nil
	}
	models := modelTotalsMap{}
	for model, raw := range record {
		entry := jsonx.AsRecord(raw)
		if entry == nil {
			return nil
		}
		tokens := modelTokens(entry)
		if tokens == nil {
			return nil
		}
		models[model] = *tokens
	}
	return models
}

// claudeUsageBaseline is the baseline a get_usage control_response sets:
// its response.session.model_usage ({} for a session with nothing saved).
// Anything else (an error answer, a timeout or exit (answer nil), a reply
// without session totals) leaves it unknown.
func claudeUsageBaseline(answer jsonx.Record) usageBaseline {
	response := jsonx.AsRecord(answer["response"])
	if response == nil || response["subtype"] != "success" {
		return usageBaseline{Kind: "unknown"}
	}
	session := jsonx.AsRecord(jsonx.AsRecord(response["response"])["session"])
	if session == nil {
		return usageBaseline{Kind: "unknown"}
	}
	models := modelTotals(session["model_usage"])
	if models == nil {
		return usageBaseline{Kind: "unknown"}
	}
	return usageBaseline{Kind: "known", Models: models}
}

func withBaseline(usage modelUsage, baseline usageBaseline) modelUsage {
	usage.Baseline = baseline
	if baseline.Kind == "known" {
		usage.Last = baseline.Models
	}
	return usage
}

// shareOf is what models holds beyond baseline, summed over models.
func shareOf(models, baseline modelTotalsMap) oar.TokenTotals {
	share := noTokens
	for model, tokens := range models {
		if start, ok := baseline[model]; ok {
			share = observe.AddTokens(share, observe.SubtractTokens(tokens, start))
		} else {
			share = observe.AddTokens(share, tokens)
		}
	}
	return share
}

// wentBack: a running total below the last one, claude reset it (a mid-session /clear).
func wentBack(models, last modelTotalsMap) bool {
	for model, before := range last {
		now, ok := models[model]
		if !ok || now.Input < before.Input || now.Output < before.Output {
			return true
		}
	}
	return false
}

// foldModelUsage folds one result's modelUsage: this Session's total so
// far, or nil when it is not known (a resume without a baseline) or the
// frame says nothing (no modelUsage, or the zeroed one of a crash or
// startup-error result, which must not move the total back). A total below
// the last one is claude resetting its running total: the share counted so
// far is kept and counting restarts from zero.
func foldModelUsage(usage modelUsage, message jsonx.Record) (modelUsage, *oar.TokenTotals) {
	models := modelTotals(message["modelUsage"])
	if usage.Baseline.Kind != "known" || models == nil {
		return usage, nil
	}
	reported := shareOf(models, modelTotalsMap{})
	if reported.Input == 0 && reported.Output == 0 {
		return usage, nil
	}
	reset := wentBack(models, usage.Last)
	baseline := usage.Baseline.Models
	carried := usage.Carried
	if reset {
		baseline = modelTotalsMap{}
		carried = observe.AddTokens(usage.Carried, shareOf(usage.Last, usage.Baseline.Models))
	}
	total := observe.AddTokens(carried, shareOf(models, baseline))
	return modelUsage{Baseline: usageBaseline{Kind: "known", Models: baseline}, Last: models, Carried: carried}, &total
}
