//go:build wip_b

package claude

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-token-usage.test.ts: claude's session total is
// its latest result.modelUsage, the root agent's entry its main loop
// (result.usage), and the rest unattributed (#282).

// b_replayUsage folds claude frames into a kernel the way the adapter does; the usage() answer after each result.
func b_replayUsage(lines []jsonx.Record, start projectionState) ([]oar.SessionUsage, *kernel.Kernel) {
	k := kernel.New("claude-session")
	var afterResults []oar.SessionUsage
	state := start
	for _, frame := range lines {
		var commands []projectionCommand
		state, commands = foldClaudeStdout(state, nativeOf(frame))
		for _, command := range commands {
			if command.Kind == "frame" {
				k.Frame(command.Body, kernel.RecordAt{AgentPath: command.AgentPath})
			}
		}
		if frame["type"] == "result" {
			graph := k.Graph()
			afterResults = append(afterResults, observe.UsageOf(k.Records(), k.SessionID(), &graph).Value)
		}
	}
	return afterResults, k
}

// b_resumedAfter is a resumed session's fold once its get_usage read-back
// has answered (nil answer: a timeout or an exit).
func b_resumedAfter(answered jsonx.Record) projectionState {
	return claudeUsageBaselined(resumedClaudeProjection(), claudeUsageBaseline(answered))
}

func b_baselineFrom(modelUsage any) usageBaseline {
	return claudeUsageBaseline(b_parse(b_getUsageAnswer("oar-usage-1", modelUsage)))
}

// b_parse is a Go-built record through JSON, as claude would send it.
func b_parse(record jsonx.Record) jsonx.Record { return jsonx.ParseRecord([]byte(jsonText(record))) }

func b_usageEvents(state projectionState, frame jsonx.Record) []oar.EventBody {
	_, commands := foldClaudeStdout(state, nativeOf(frame))
	events := []oar.EventBody{}
	for _, command := range commands {
		for _, event := range command.Body.Events {
			if _, ok := event.(oar.Usage); ok && command.Kind == "frame" {
				events = append(events, event)
			}
		}
	}
	return events
}

func b_root(tokens string) string { return `[{"agentPath":[],"tokens":` + tokens + `}]` }

func TestNewSessionTotalIsTheLatestModelUsageAndTheSubagentSpendIsUnattributed(t *testing.T) {
	afterResults, _ := b_replayUsage(b_claudeFrames(t, "usage-subagent-compact"), claudePrompted(initialClaudeProjection(), "", true))
	// Turn 1 ran a Task subagent: modelUsage exceeds the main loop's result.usage by the subagent's calls.
	assertJSON(t, afterResults[0], `{
		"total":{"input":69147,"output":1011,"cacheRead":47627,"cacheWrite":21484},
		"byAgent":`+b_root(`{"input":43876,"output":834,"cacheRead":35315,"cacheWrite":8543}`)+`,
		"unattributed":{"input":25271,"output":177,"cacheRead":12312,"cacheWrite":12941}}`)
	// Turn 2 is plain: modelUsage carries the running total (read, not added).
	assertJSON(t, afterResults[1], `{
		"total":{"input":91710,"output":1040,"cacheRead":70069,"cacheWrite":21595},
		"byAgent":`+b_root(`{"input":66439,"output":863,"cacheRead":57757,"cacheWrite":8654}`)+`,
		"unattributed":{"input":25271,"output":177,"cacheRead":12312,"cacheWrite":12941}}`)
}

func TestSessionViewReadsTheSameUsageAsUsage(t *testing.T) {
	afterResults, k := b_replayUsage(b_claudeFrames(t, "usage-subagent-compact"), claudePrompted(initialClaudeProjection(), "", true))
	view := observe.InitialSessionView()
	for _, record := range k.Records() {
		view = observe.ReduceSessionView(view, record, k.SessionID())
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(jsonText(view)), &parsed); err != nil {
		t.Fatal(err)
	}
	assertJSON(t, jsonx.ParseRecord(parsed["usage"]), jsonText(afterResults[len(afterResults)-1]))
}

func TestSubagentGetsNoEntryOfItsOwn(t *testing.T) {
	afterResults, k := b_replayUsage(b_claudeFrames(t, "usage-subagent-compact"), claudePrompted(initialClaudeProjection(), "", true))
	var assistant []any
	for _, record := range k.Records() {
		if len(record.AgentPath) > 0 && record.Kind == oar.KindFrame && record.Frame.Type == "assistant" {
			assistant = append(assistant, jsonx.AsRecord(jsonx.ParseRecord(record.Frame.Native)["message"])["usage"])
		}
	}
	// Only the subagent's first assistant frame carries parent_tool_use_id; its output_tokens is the stream's start.
	if len(assistant) != 1 {
		t.Fatalf("attributed assistant frames = %d", len(assistant))
	}
	usage := jsonx.AsRecord(assistant[0])
	if usage["input_tokens"] != float64(10) || usage["output_tokens"] != float64(3) {
		t.Fatalf("usage = %v", usage)
	}
	for _, result := range afterResults {
		for _, entry := range result.ByAgent {
			if len(entry.AgentPath) != 0 {
				t.Fatalf("an agent entry: %v", entry.AgentPath)
			}
		}
	}
}

func TestCompactGrowsTheTotalWhileTheMainLoopReportsNothing(t *testing.T) {
	frames := b_claudeFrames(t, "usage-subagent-compact")
	afterResults, _ := b_replayUsage(frames, claudePrompted(initialClaudeProjection(), "", true))
	results := b_resultsOf(frames)
	usage := jsonx.AsRecord(results[len(results)-1]["usage"])
	if usage["input_tokens"] != float64(0) || usage["output_tokens"] != float64(0) {
		t.Fatalf("compact usage = %v", usage)
	}
	assertJSON(t, afterResults[len(afterResults)-1], `{
		"total":{"input":115697,"output":2213,"cacheRead":92511,"cacheWrite":21669},
		"byAgent":`+b_root(`{"input":66439,"output":863,"cacheRead":57757,"cacheWrite":8654}`)+`,
		"unattributed":{"input":49258,"output":1350,"cacheRead":34754,"cacheWrite":13015}}`)
}

func TestResumedSessionCountsFromItsGetUsageBaseline(t *testing.T) {
	resumed := b_claudeFrames(t, "usage-resume")
	model := jsonx.AsRecord(jsonx.AsRecord(b_resultsOf(resumed)[0]["modelUsage"])["claude-haiku-4-5-20251001"])
	for key, want := range map[string]float64{"inputTokens": 1527, "outputTokens": 2249, "cacheReadInputTokens": 110477, "cacheCreationInputTokens": 25780} {
		if model[key] != want {
			t.Fatalf("%s = %v", key, model[key])
		}
	}
	answered := b_parse(b_getUsageAnswer("oar-usage-1", b_savedModelUsage(t)))
	afterResults, _ := b_replayUsage(resumed, claudePrompted(b_resumedAfter(answered), "", true))
	assertJSON(t, afterResults, `[{"total":{"input":22087,"output":36,"cacheRead":17966,"cacheWrite":4111}}]`)
	// That is exactly this Session's main loop: 10 + 17966 + 4111 in, 36 out.
	usage := jsonx.AsRecord(b_resultsOf(resumed)[0]["usage"])
	if usage["input_tokens"] != float64(10) || usage["cache_read_input_tokens"] != float64(17966) || usage["cache_creation_input_tokens"] != float64(4111) || usage["output_tokens"] != float64(36) {
		t.Fatalf("usage = %v", usage)
	}
}

func TestResumeWithoutABaselineReportsContextOnly(t *testing.T) {
	resumed := b_claudeFrames(t, "usage-resume")
	for name, start := range map[string]projectionState{
		"no answer yet":   resumedClaudeProjection(),
		"an error answer": b_resumedAfter(jsonx.ParseRecord([]byte(`{"type":"control_response","response":{"subtype":"error","request_id":"oar-usage-1","error":"Unsupported control request subtype: get_usage"}}`))),
		// TS: an Error answer; Go: no answer (nil).
		"a timeout":                        b_resumedAfter(nil),
		"an answer without session totals": b_resumedAfter(b_parse(b_getUsageAnswer("oar-usage-1", nil))),
	} {
		t.Run(name, func(t *testing.T) {
			assertJSON(t, b_usageEvents(start, b_resultsOf(resumed)[0]), `[{"kind":"usage","usage":{"context":{"tokens":22087,"contextWindow":200000,"percent":11}}}]`)
			afterResults, _ := b_replayUsage(resumed, start)
			assertJSON(t, afterResults, `[{"total":null}]`)
		})
	}
}

func TestGetUsageSetsABaselineOnlyFromSessionModelUsageWhole(t *testing.T) {
	empty := b_baselineFrom(map[string]any{})
	if empty.Kind != "known" || len(empty.Models) != 0 {
		t.Fatalf("baseline = %+v", empty)
	}
	saved := b_baselineFrom(b_savedModelUsage(t))
	if saved.Kind != "known" || len(saved.Models) != 1 {
		t.Fatalf("baseline = %+v", saved)
	}
	assertJSON(t, saved.Models["claude-haiku-4-5-20251001"], `{"input":115697,"output":2213,"cacheRead":92511,"cacheWrite":21669}`)
	// An entry without its counts makes the whole baseline unknown, never a partial one.
	if partial := b_baselineFrom(map[string]any{"claude-haiku-4-5": map[string]any{"inputTokens": 1}}); partial.Kind != "unknown" {
		t.Fatalf("baseline = %+v", partial)
	}
}

func TestZeroedStartupErrorResultNeverMovesTheTotalBack(t *testing.T) {
	zeroed := b_missingResume(t)
	if !b_sameJSON(zeroed["modelUsage"], map[string]any{}) {
		t.Fatalf("modelUsage = %v", zeroed["modelUsage"])
	}
	afterResults, _ := b_replayUsage(append(b_claudeFrames(t, "usage-subagent-compact"), zeroed), claudePrompted(initialClaudeProjection(), "", true))
	if jsonText(afterResults[len(afterResults)-1]) != jsonText(afterResults[len(afterResults)-2]) {
		t.Fatal("the zeroed result moved the total")
	}
}

func TestClaudeResettingItsRunningTotalKeepsWhatThisSessionCountedBeforeIt(t *testing.T) {
	// SYNTHETIC: claude 2.1.289's schema says "a mid-session /clear resets the running total".
	afterClear := jsonx.ParseRecord([]byte(`{"type":"result","subtype":"success","is_error":false,
		"usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":100},
		"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":5,"outputTokens":7,"cacheReadInputTokens":0,"cacheCreationInputTokens":100,"webSearchRequests":0,"costUSD":0.0002,"contextWindow":200000,"maxOutputTokens":32000}}}`))
	afterResults, _ := b_replayUsage(append(b_claudeFrames(t, "usage-subagent-compact"), afterClear), claudePrompted(initialClaudeProjection(), "", true))
	assertJSON(t, afterResults[len(afterResults)-1], `{
		"total":{"input":115802,"output":2220,"cacheRead":92511,"cacheWrite":21769},
		"byAgent":`+b_root(`{"input":66544,"output":870,"cacheRead":57757,"cacheWrite":8754}`)+`,
		"unattributed":{"input":49258,"output":1350,"cacheRead":34754,"cacheWrite":13015}}`)
}
