package morph

import (
	"encoding/json"
	"reflect"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ported from tests/community/morph/morph-projection.test.ts.

const task = "console_1_6"

func entry(seq int, event string) string {
	return `{"seq":` + itoa(seq) + `,"at":"2026-10-04T08:40:12+09:00","event":{"run_id":"` + task + `",` + event + `}}`
}

func itoa(n int) string { encoded, _ := json.Marshal(n); return string(encoded) }

var (
	turnStart  = entry(1, `"kind":"turn_start","model":"gpt-5.6-luna","activity_id":"turn","status":"running"`)
	llmStart   = entry(2, `"kind":"llm_start","model":"gpt-5.6-luna","status":"running"`)
	llmDone    = entry(3, `"kind":"llm_done","model":"gpt-5.6-luna","status":"done"`)
	toolStart  = entry(4, `"kind":"tool_start","activity_id":"call_Iddq","tool_name":"bash","status":"running","args":{"cmd":"echo oar-probe"}`)
	toolOutput = entry(5, `"kind":"tool_output","tool_name":"bash","status":"running","profile":"long_shell","stream":"stdout","text":"oar-probe\n"`)
	toolDone   = entry(6, `"kind":"tool_done","activity_id":"call_Iddq","tool_name":"bash","status":"done","text":"exit_code: 0\nstdout_truncated: false\nstderr_truncated: false\nstdout:\noar-probe\n\n\nstderr:\n","args":{"cmd":"echo oar-probe"}`)
	turnDone   = entry(9, `"kind":"turn_done","activity_id":"turn","status":"done","text":"done"`)
)

func frame(fields string, entries ...string) json.RawMessage {
	text := `{"task_id":"` + task + `"` + fields
	if len(entries) > 0 {
		text += `,"trace":{"entries":[`
		for i, e := range entries {
			if i > 0 {
				text += ","
			}
			text += e
		}
		text += `]}`
	}
	return json.RawMessage(text + "}")
}

func replay(frames ...json.RawMessage) (Projection, []oar.EventBody) {
	state := Projection{}
	var events []oar.EventBody
	for _, f := range frames {
		var next []oar.EventBody
		state, next = FoldStream(state, f)
		events = append(events, next...)
	}
	return state, events
}

func expectEvents(t *testing.T, events []oar.EventBody, want string) {
	t.Helper()
	if events == nil {
		events = []oar.EventBody{}
	}
	encoded, _ := json.Marshal(events)
	var got, expected any
	_ = json.Unmarshal(encoded, &got)
	if err := json.Unmarshal([]byte(want), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("events = %s\nwant     %s", encoded, want)
	}
}

func TestAToolTurnReadsEachTraceEntryOnce(t *testing.T) {
	state, events := replay(
		frame(`,"seq":61,"status":"running"`),
		frame(`,"seq":62,"status":"running"`, turnStart),
		frame(`,"seq":63,"status":"running"`, turnStart, llmStart),
		frame(`,"seq":64,"status":"running","reasoning":"**Executing bash**"`, turnStart, llmStart),
		frame(`,"seq":66,"status":"running","reasoning":"**Executing bash**"`, llmStart, llmDone, toolStart),
		frame(`,"seq":70,"status":"running","text":"[bash] running\n\nstdout:\noar-probe","preview":true,"reasoning":"**Executing bash**"`, llmDone, toolStart, toolOutput),
		frame(`,"seq":71,"status":"running","text":"[bash] done\n\nstdout:\noar-probe","preview":true,"reasoning":"**Executing bash**"`, toolStart, toolOutput, toolDone),
		frame(`,"seq":75,"status":"running","text":"do","reasoning":"**Executing bash**\n\n**Confirming**"`, toolOutput, toolDone),
		frame(`,"seq":79,"status":"done","text":"done","done":true`, toolDone, turnDone),
	)
	expectEvents(t, events, `[
		{"kind":"model","model":"gpt-5.6-luna"},
		{"kind":"reasoning","content":{"kind":"text","text":"**Executing bash**"}},
		{"kind":"tool_call_started","callId":"call_Iddq","tool":"bash","input":"echo oar-probe"},
		{"kind":"tool_call_progress","callId":"call_Iddq","output":"oar-probe\n"},
		{"kind":"tool_call_ended","callId":"call_Iddq","content":[{"type":"text","text":"exit_code: 0\nstdout_truncated: false\nstderr_truncated: false\nstdout:\noar-probe\n\n\nstderr:\n"}],"exitCode":0,"result":"ok"},
		{"kind":"reasoning","content":{"kind":"text","text":"\n\n**Confirming**"}},
		{"kind":"text_delta","text":"do","messageId":"console_1_6:0"},
		{"kind":"text_delta","text":"ne","messageId":"console_1_6:0"}
	]`)
	if state.Tasks[task].TraceSeq != 9 {
		t.Fatal(state.Tasks[task].TraceSeq)
	}
}

func TestTerminalAnswerFillsWhatTheStreamMissed(t *testing.T) {
	streamed, _ := replay(frame(`,"seq":62,"status":"running","text":"do"`, turnStart, llmStart))
	final, events := FoldTask(streamed, json.RawMessage(`{"id":"`+task+`","status":"done","model":"gpt-5.6-luna","result":{"final":{"output":"done"},"metrics":{"total_tokens":9666},"trace":{"entries":[`+turnStart+`,`+llmStart+`,`+llmDone+`,`+toolStart+`,`+toolDone+`,`+turnDone+`]}}}`))
	var kinds []string
	for _, event := range events {
		kinds = append(kinds, event.EventKind())
	}
	if !reflect.DeepEqual(kinds, []string{"tool_call_started", "tool_call_ended", "text_delta", "turn_ended"}) {
		t.Fatal(kinds)
	}
	expectEvents(t, events[2:3], `[{"kind":"text_delta","text":"ne","messageId":"console_1_6:0"}]`)
	if _, ok := final.Tasks[task]; ok {
		t.Fatal("the task is forgotten once it ended")
	}
}

func TestTurnOutcomesAndErrorText(t *testing.T) {
	end := func(info string) []oar.EventBody {
		_, events := FoldTask(Projection{}, json.RawMessage(`{"id":"`+task+`",`+info+`}`))
		return events
	}
	expectEvents(t, end(`"status":"canceled","error":"stopped by user"`), `[{"kind":"turn_ended","outcome":{"kind":"aborted"}}]`)
	// The TS test expects "quota", but TS's own classifyFailure answers
	// rate_limited for this text (a 429): that TS test fails on TS too (smith/GAPS.md).
	expectEvents(t, end(`"status":"failed","error":"llm call failed at step 0: 429 rate limit"`), `[{"kind":"turn_ended","outcome":{"kind":"failed","reason":"llm call failed at step 0: 429 rate limit","failure":"rate_limited"}}]`)
	expectEvents(t, end(`"status":"running"`), `[]`)
	expectEvents(t, end(`"status":"pending"`), `[]`)
	streamed, events := replay(frame(`,"seq":7,"status":"failed","text":"stopped by user","error":"stopped by user","done":true`), frame(`,"seq":8,"status":"canceled","text":"stopped by user"`))
	expectEvents(t, events, `[]`)
	_, ended := FoldTask(streamed, json.RawMessage(`{"id":"`+task+`","status":"canceled","error":"stopped by user","result":{"final":{"output":"stopped by user"}}}`))
	expectEvents(t, ended, `[{"kind":"turn_ended","outcome":{"kind":"aborted"}}]`)
	expectEvents(t, end(`"status":"failed","error":"llm call failed","result":{"final":{"output":"llm call failed"}}`)[:0], `[]`)
	if failed := end(`"status":"failed","error":"llm call failed","result":{"final":{"output":"llm call failed"}}`); len(failed) != 1 {
		t.Fatal(failed)
	}
}

func TestSteerRetryAndCompactionEntries(t *testing.T) {
	_, events := replay(frame(`,"seq":1,"status":"running"`,
		entry(1, `"kind":"steer_queued","text":"Also append steered."`),
		entry(2, `"kind":"llm_retry","text":"Request failed: Network connection failed. Retrying in 1.0s (1/5)."`),
		entry(3, `"kind":"steer_applied","activity_id":"steer","status":"applied","text":"Also append steered.","args":{"count":1}`),
		entry(4, `"kind":"context_compaction_start"`),
		entry(5, `"kind":"context_compaction_failed","error":"summary too long"`),
	))
	expectEvents(t, events, `[
		{"kind":"retry","attempt":1,"maxAttempts":5,"delayMs":1000,"reason":"Request failed: Network connection failed. Retrying in 1.0s (1/5)."},
		{"kind":"user_message","input":"Also append steered.","evidence":"conversation"},
		{"kind":"compaction_started"},
		{"kind":"compaction_ended","outcome":"failed","reason":"summary too long"}
	]`)
}

func TestRewrittenTextStartsANewMessage(t *testing.T) {
	_, events := replay(frame(`,"seq":1,"text":"Let me check."`), frame(`,"seq":2,"text":"The answer is 4."`))
	expectEvents(t, events, `[{"kind":"text_delta","text":"Let me check.","messageId":"console_1_6:0"},{"kind":"text_delta","text":"The answer is 4.","messageId":"console_1_6:1"}]`)
}

func TestContextAndProfiles(t *testing.T) {
	expectEvents(t, ContextEvents(json.RawMessage(`{"context":{"available":false}}`)), `[]`)
	expectEvents(t, ContextEvents(json.RawMessage(`{"context":{"available":true,"used_input_tokens":262500,"context_window_tokens":1050000,"usage_ratio":0.25}}`)),
		`[{"kind":"usage","usage":{"context":{"tokens":262500,"contextWindow":1050000,"percent":25}}}]`)
	models, _ := json.Marshal(ProjectModels(json.RawMessage(`{"default":{"name":"default","inference_provider":"openai_response_compatible","model":"copilot/claude-sonnet-5.5"},"items":[{"name":"codex","inference_provider":"openai_codex","model":"gpt-5.6-luna"},{"name":"default"},{"name":""}]}`)))
	if string(models) != `[{"id":"default","resolvedId":"copilot/claude-sonnet-5.5"},{"id":"codex","resolvedId":"gpt-5.6-luna"}]` {
		t.Fatal(string(models))
	}
}
