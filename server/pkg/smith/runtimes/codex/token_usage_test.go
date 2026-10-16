package codex

import (
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/codex/codex-token-usage.test.ts.

// breakdown is a `TokenUsageBreakdown` (app-server v2 thread.rs at
// 4f39251a, camelCase): `inputTokens` holds the cache reads and writes.
func breakdown(input, read, write, output int) jsonx.Record {
	return jsonx.Record{"totalTokens": input + output, "inputTokens": input, "cachedInputTokens": read, "cacheWriteInputTokens": write, "outputTokens": output, "reasoningOutputTokens": 0}
}

func usageTokens(commands []projectionCommand) []any {
	tokens := []any{}
	for _, event := range frameEvents(commands) {
		if usage, ok := event.(oar.Usage); ok && usage.Usage.Tokens != nil {
			tokens = append(tokens, *usage.Usage.Tokens)
		}
	}
	return tokens
}

func tokenUsage(t *testing.T, state codexProjectionState, params jsonx.Record) (codexProjectionState, []any) {
	params["threadId"] = root
	next, commands := fold(t, state, "thread/tokenUsage/updated", params)
	return next, usageTokens(commands)
}

// #161: codex's `total` is its own running sum, so two turns read as two snapshots.
func TestCacheReadsAndWritesAreTheCumulativeTotalsCachedInputTokensAndCacheWriteInputTokens(t *testing.T) {
	first, firstTokens := tokenUsage(t, initialCodexProjection(root, methodThreadStart), jsonx.Record{"turnId": "t1", "tokenUsage": jsonx.Record{"total": breakdown(10_000, 0, 9600, 20), "last": breakdown(10_000, 0, 9600, 20), "modelContextWindow": 121_600}})
	_, secondTokens := tokenUsage(t, first, jsonx.Record{"turnId": "t2", "tokenUsage": jsonx.Record{"total": breakdown(22_000, 9600, 11_900, 50), "last": breakdown(12_000, 9600, 2300, 30), "modelContextWindow": 121_600}})
	sameJSON(t, append(firstTokens, secondTokens...), `[{"input":10000,"output":20,"cacheRead":0,"cacheWrite":9600,"reasoning":0},{"input":22000,"output":50,"cacheRead":9600,"cacheWrite":11900,"reasoning":0}]`)
}

// The field names as codex-cli 0.160.0 sent them: a reported 0 stays 0.
func TestCodexsOwnZerosStayZeros(t *testing.T) {
	zero := jsonx.Record{"totalTokens": 0, "inputTokens": 0, "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0}
	_, tokens := tokenUsage(t, initialCodexProjection(root, methodThreadStart), jsonx.Record{"turnId": "t-1", "tokenUsage": jsonx.Record{"total": zero, "last": zero, "modelContextWindow": 258_400}})
	sameJSON(t, tokens, `[{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"reasoning":0}]`)
}

// A codex built before `cacheWriteInputTokens` has no write field.
func TestAnOlderTotalWithoutCacheWriteInputTokensYieldsOnlyCacheRead(t *testing.T) {
	_, older := tokenUsage(t, initialCodexProjection(root, methodThreadStart), jsonx.Record{"tokenUsage": jsonx.Record{"total": jsonx.Record{"totalTokens": 44_201, "inputTokens": 44_166, "cachedInputTokens": 32_512, "outputTokens": 35, "reasoningOutputTokens": 0}}})
	sameJSON(t, older, `[{"input":44166,"output":35,"cacheRead":32512,"reasoning":0}]`)
	_, bare := tokenUsage(t, initialCodexProjection(root, methodThreadStart), jsonx.Record{"tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 200, "outputTokens": 5}}})
	sameJSON(t, bare, `[{"input":200,"output":5}]`)
}

type notification struct {
	method string
	params jsonx.Record
}

// sessionTokens is the root token totals a Session's projection reads out of frames, opened by opened.
func sessionTokens(t *testing.T, opened string, frames []notification) []any {
	state := initialCodexProjection(root, opened)
	tokens := []any{}
	for _, item := range frames {
		item.params["threadId"] = root
		next, commands := fold(t, state, item.method, item.params)
		state = next
		tokens = append(tokens, usageTokens(commands)...)
	}
	return tokens
}

func total(input, output int) jsonx.Record {
	return jsonx.Record{"tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": input, "outputTokens": output}}}
}

func totalWithCache(input, output, read, write int) jsonx.Record {
	return jsonx.Record{"tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": input, "outputTokens": output, "cachedInputTokens": read, "cacheWriteInputTokens": write}}}
}

func withTurn(record jsonx.Record, turnID string) jsonx.Record {
	record["turnId"] = turnID
	return record
}

func turnStarted(id string) jsonx.Record { return jsonx.Record{"turn": jsonx.Record{"id": id}} }

func TestReasoningIsAnOutputSubsetAndResumeSubtractsItsOwnReportedBaseline(t *testing.T) {
	sameJSON(t, sessionTokens(t, methodThreadResume, []notification{
		{"thread/tokenUsage/updated", jsonx.Record{"tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 100, "outputTokens": 50, "reasoningOutputTokens": 30}}}},
		{"turn/started", turnStarted("next")},
		{"thread/tokenUsage/updated", jsonx.Record{"tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 300, "outputTokens": 90, "reasoningOutputTokens": 55}}}},
	}), `[{"input":0,"output":0,"reasoning":0},{"input":200,"output":40,"reasoning":25}]`)
	_, tokens := tokenUsage(t, initialCodexProjection(root, methodThreadStart), jsonx.Record{"tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 10, "outputTokens": 5, "reasoningOutputTokens": "unknown"}}})
	sameJSON(t, tokens, `[{"input":10,"output":5}]`)
}

// #169, from a real codex-cli 0.155.1 login: run 1 ended at 18,185 / 5. The
// resumed run re-reported 18,185 / 5 under run 1's turn id right after the
// prompt, before turn/started, then 38,557 / 10.
func TestAResumedSessionCountsItsTokensFromTheTotalReReportedBeforeItsFirstTurn(t *testing.T) {
	sameJSON(t, sessionTokens(t, methodThreadResume, []notification{
		{"thread/tokenUsage/updated", withTurn(total(18_185, 5), "run-1-turn")},
		{"turn/started", turnStarted("run-2-turn")},
		{"thread/tokenUsage/updated", withTurn(total(38_557, 10), "run-2-turn")},
	}), `[{"input":0,"output":0},{"input":20372,"output":5}]`)
}

func TestTheResumeBaselineIsSubtractedFromCacheReadAndCacheWriteToo(t *testing.T) {
	sameJSON(t, sessionTokens(t, methodThreadResume, []notification{
		{"thread/tokenUsage/updated", totalWithCache(30_000, 40, 20_000, 9000)},
		{"turn/started", turnStarted("t2")},
		{"thread/tokenUsage/updated", totalWithCache(42_000, 70, 31_000, 9500)},
	}), `[{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},{"input":12000,"output":30,"cacheRead":11000,"cacheWrite":500}]`)
}

func report(input, output, lastTotal int) jsonx.Record {
	return jsonx.Record{"turnId": "t2", "tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": input, "outputTokens": output}, "last": jsonx.Record{"totalTokens": lastTotal}, "modelContextWindow": 258_400}}
}

// Don't know, don't report: a resumed Session whose first turn starts
// without a re-report has no known start.
func TestAResumedSessionWithoutAReReportBeforeItsFirstTurnReportsNoTokens(t *testing.T) {
	state := initialCodexProjection(root, methodThreadResume)
	events := []oar.EventBody{}
	for _, item := range []notification{
		{"turn/started", turnStarted("t2")},
		{"thread/tokenUsage/updated", report(1000, 5, 1005)},
		{"thread/tokenUsage/updated", report(2200, 12, 1207)},
	} {
		item.params["threadId"] = root
		next, commands := fold(t, state, item.method, item.params)
		state = next
		events = append(events, frameEvents(commands)...)
	}
	sameJSON(t, events, `[{"kind":"turn_active"},{"kind":"usage","usage":{"context":{"contextWindow":258400,"percent":0,"tokens":1005}}},{"kind":"usage","usage":{"context":{"contextWindow":258400,"percent":0,"tokens":1207}}}]`)
}

// A new thread counts from zero whatever arrives before its first turn.
func TestANewThreadIsNeverBaselined(t *testing.T) {
	sameJSON(t, sessionTokens(t, methodThreadStart, []notification{
		{"thread/tokenUsage/updated", total(0, 0)},
		{"turn/started", turnStarted("t1")},
		{"thread/tokenUsage/updated", total(1000, 5)},
	}), `[{"input":0,"output":0},{"input":1000,"output":5}]`)
}

// Only the root thread is baselined.
func TestAChildThreadsTotalBeforeTheRootsFirstTurnIsNotTheRootsBaseline(t *testing.T) {
	state := initialCodexProjection(root, methodThreadResume)
	foldOn := func(threadID, method string, params jsonx.Record) []any {
		params["threadId"] = threadID
		next, commands := fold(t, state, method, params)
		state = next
		return usageTokens(commands)
	}
	var tokens []any
	tokens = append(tokens, foldOn("thread-child", "thread/tokenUsage/updated", total(500, 2))...)
	tokens = append(tokens, foldOn(root, "thread/tokenUsage/updated", total(1000, 5))...)
	tokens = append(tokens, foldOn(root, "turn/started", turnStarted("t2"))...)
	tokens = append(tokens, foldOn("thread-child", "thread/tokenUsage/updated", total(900, 4))...)
	tokens = append(tokens, foldOn(root, "thread/tokenUsage/updated", total(2200, 12))...)
	sameJSON(t, tokens, `[{"input":500,"output":2},{"input":0,"output":0},{"input":900,"output":4},{"input":1200,"output":7}]`)
}
