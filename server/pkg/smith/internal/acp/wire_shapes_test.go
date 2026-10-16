package acp_test

// Frames as grok and kimi sent them on the live wire: ported from
// tests/acp/acp-grok-wire-shapes.test.ts and tests/acp/acp-kimi-wire-shapes.test.ts.

import (
	"context"
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/runtimes/grok"
)

// ─── acp-grok-wire-shapes.test.ts ──────────────────────────────────────────

// Frames as grok 1.0.25 (f7e67d6988e2) sent them on 2026-09-11, tapped below
// the ACP SDK and recorded in live voyages; ids shortened, signatures dropped.
const (
	grokParent = "01a08f46-34e0-7480-a07c-c11300ff7f7f"
	grokChild  = "01a08f46-deb8-7fb1-85aa-73d96c437da7"
)

func record(t *testing.T, text string) jsonx.Record {
	t.Helper()
	parsed := jsonx.ParseRecord([]byte(text))
	if parsed == nil {
		t.Fatalf("not an object: %s", text)
	}
	return parsed
}

func lineage(value *acp.Lineage) any {
	if value == nil {
		return nil
	}
	return map[string]any{"parent": value.Parent, "child": value.Child}
}

func TestGrokLineageSubagentSpawnedAndProgressNameThePairSnakeCaseUnderUpdate(t *testing.T) {
	spawned := record(t, `{"sessionId": "`+grokParent+`", "update": {
		"sessionUpdate": "subagent_spawned", "subagent_id": "`+grokChild+`", "attempt_id": "at1.a3ea6e36f3bf4a0aa6825795cc27794a",
		"parent_session_id": "`+grokParent+`", "parent_prompt_id": "c088ff51-053d-4e9a-a801-ba1ae504ba2a", "child_session_id": "`+grokChild+`",
		"subagent_type": "general-purpose", "description": "Echo CHILD-OK-7731", "effective_context_source": "new", "model": "grok-4.6"}}`)
	jsonEqual(t, lineage(acp.LineageOf(spawned)), map[string]any{"parent": grokParent, "child": grokChild})
	progress := record(t, `{"sessionId": "`+grokParent+`", "update": {"sessionUpdate": "subagent_progress", "subagent_id": "`+grokChild+`", "parent_session_id": "`+grokParent+`", "child_session_id": "`+grokChild+`", "turn_count": 1}}`)
	jsonEqual(t, lineage(acp.LineageOf(progress)), map[string]any{"parent": grokParent, "child": grokChild})
}

func TestGrokLineageSubagentFinishedNamesOnlyTheChildTheParentIsTheEnvelopesSession(t *testing.T) {
	finished := record(t, `{"sessionId": "`+grokParent+`",
		"update": {"sessionUpdate": "subagent_finished", "subagent_id": "`+grokChild+`", "child_session_id": "`+grokChild+`", "status": "completed", "output": "CHILD-OK-7731", "will_wake": false},
		"_meta": {"eventId": "`+grokParent+`-100", "agentTimestampMs": 1789110195312}}`)
	jsonEqual(t, lineage(acp.LineageOf(finished)), map[string]any{"parent": grokParent, "child": grokChild})
}

func TestLineageIsNeverFabricated(t *testing.T) {
	for _, text := range []string{
		`{"sessionId": "` + grokParent + `", "update": {"sessionUpdate": "model_changed", "model_id": "grok-4.6"}}`,
		`{"sessionId": "` + grokParent + `", "update": {"sessionUpdate": "turn_completed", "prompt_id": "p", "stop_reason": "end_turn"}}`,
		`{"sessionId": "` + grokParent + `", "update": {"child_session_id": "` + grokParent + `"}}`,
		`{"upserted": [{"sessionId": "` + grokParent + `"}], "removed": []}`,
	} {
		if got := acp.LineageOf(record(t, text)); got != nil {
			t.Fatalf("%s: %+v", text, got)
		}
	}
	// The flat camelCase spelling (fixture / earlier assumption) still links.
	jsonEqual(t, lineage(acp.LineageOf(record(t, `{"parentSessionId": "p", "sessionId": "c", "kind": "spawned"}`))), map[string]any{"parent": "p", "child": "c"})
}

func TestGrokPromptAnswerMetaUsageIsThePromptsLedgerTotalTokensTheContextCount(t *testing.T) {
	answer := record(t, `{"stopReason": "end_turn", "_meta": {
		"sessionId": "`+grokParent+`", "promptId": "bc31f0cd-83fd-44e1-a24f-e48ad481647c", "totalTokens": 16825, "modelId": "grok-4.6",
		"inputTokens": 16791, "outputTokens": 34, "cachedReadTokens": 1280, "reasoningTokens": 28,
		"usage": {"inputTokens": 16791, "outputTokens": 34, "totalTokens": 16825, "cachedReadTokens": 1280, "cacheCreationTokens": 0, "reasoningTokens": 28, "modelCalls": 1}}}`)
	// #161: the ledger's cachedReadTokens / cacheCreationTokens are the cache parts of its input.
	jsonEqual(t, grok.PromptTokens(answer), map[string]any{"input": 16791, "output": 34, "cacheRead": 1280, "cacheWrite": 0, "reasoning": 28})
	jsonEqual(t, grok.ContextUsage(answer), map[string]any{"tokens": 16825, "contextWindow": nil, "percent": nil})
	for _, text := range []string{
		`{"stopReason": "end_turn"}`,
		`{"stopReason": "cancelled", "_meta": {"totalTokens": 5}}`,
		// A half ledger is no ledger: the missing side is never invented as 0.
		`{"stopReason": "end_turn", "_meta": {"usage": {"inputTokens": 12}}}`,
		`{"stopReason": "end_turn", "_meta": {"usage": {"outputTokens": 3, "modelCalls": 1}}}`,
	} {
		if got := grok.PromptTokens(record(t, text)); got != nil {
			t.Fatalf("%s: %+v", text, got)
		}
	}
	// A ledger without a cache field has no such part, never a 0 for it.
	jsonEqual(t, grok.PromptTokens(record(t, `{"stopReason": "end_turn", "_meta": {"usage": {"inputTokens": 12, "outputTokens": 3, "cachedReadTokens": 8}}}`)), map[string]any{"input": 12, "output": 3, "cacheRead": 8})
	jsonEqual(t, grok.PromptTokens(record(t, `{"stopReason": "end_turn", "_meta": {"usage": {"inputTokens": 12, "outputTokens": 3}}}`)), map[string]any{"input": 12, "output": 3})
}

func project(state *acp.ProjectionState, update string) []oar.EventBody {
	return acp.ProjectUpdate(state, json.RawMessage(update))
}

// The closing `tool_call_update` of a run_terminal_command as grok 1.0.25
// sent it on 2026-09-22: the readable output is the ACP `content` block,
// `rawOutput.output` is a byte array, and the exit status lives only on `rawOutput`.
func TestGrokBashEndOutputIsTheContentBlocksTextAndExitCodeBecomesExitCode(t *testing.T) {
	state := acp.NewProjectionState()
	project(state, `{"toolCallId": "call-bash", "title": "run_terminal_command", "rawInput": {"command": "node --test"}, "sessionUpdate": "tool_call"}`)
	ended := project(state, `{"toolCallId": "call-bash", "status": "completed",
		"content": [{"type": "content", "content": {"type": "text", "text": "✔ add (0.27ms)\n✔ mul (0.06ms)\n"}}],
		"rawOutput": {"type": "Bash", "output": [226, 156, 148, 32, 97, 100, 100], "output_for_prompt": "exit: 0\n✔ add (0.27ms)\n", "exit_code": 0, "signal": null, "timed_out": false, "command": "node --test"},
		"sessionUpdate": "tool_call_update"}`)
	jsonEqual(t, ended, `[{"kind": "tool_call_ended", "callId": "call-bash", "content": [{"type": "text", "text": "✔ add (0.27ms)\n✔ mul (0.06ms)\n"}], "result": "ok", "exitCode": 0}]`)
	// A signal exit is grok's `exit_code: null`; a rawOutput without the key says nothing.
	project(state, `{"toolCallId": "call-killed", "title": "run_terminal_command", "sessionUpdate": "tool_call"}`)
	killed := project(state, `{"toolCallId": "call-killed", "status": "failed", "rawOutput": {"type": "Bash", "exit_code": null, "signal": "SIGKILL"}, "sessionUpdate": "tool_call_update"}`)
	jsonEqual(t, killed, `[{"kind": "tool_call_ended", "callId": "call-killed", "content": [{"type": "other", "value": {"type": "Bash", "exit_code": null, "signal": "SIGKILL"}}], "result": "failed", "exitCode": null}]`)
	project(state, `{"toolCallId": "call-read", "title": "read_file", "sessionUpdate": "tool_call"}`)
	read := project(state, `{"toolCallId": "call-read", "status": "completed", "rawOutput": {"type": "ReadFile", "FileContent": {"content": "x"}}, "sessionUpdate": "tool_call_update"}`)
	jsonEqual(t, read, `[{"kind": "tool_call_ended", "callId": "call-read", "content": [{"type": "other", "value": {"type": "ReadFile", "FileContent": {"content": "x"}}}], "result": "ok"}]`)
}

// grokOnFixture is the fake profile with grok's extension list and prompt usage readers.
func grokOnFixture(profile *acp.Profile) {
	profile.ExtensionNotifications = grok.ExtensionNotifications
	profile.PromptContextUsage = grok.ContextUsage
	profile.PromptTokenUsage = grok.PromptTokens
}

func persistedRecords(t *testing.T, records []oar.RawEvent) []oar.RawEvent {
	t.Helper()
	encoded, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	var restored []oar.RawEvent
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	return restored
}

func TestAGrokChildSessionGetsItsGraphEdgeFromTheVendorSessionNotification(t *testing.T) {
	session := start(t, grokOnFixture)
	if run := promptAndWait(t, session, "spawn-child-grok", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	jsonEqual(t, session.Graph(), `{"nodes": [{"id": "fake-session"}, {"id": "fake-child-grok"}], "edges": [{"parent": "fake-session", "child": "fake-child-grok", "via": "tool_call"}]}`)
	var vendor, lifecycle []oar.RawEvent
	for _, record := range session.Records() {
		if record.Kind == oar.KindFrame && record.Frame.Type == "_x.ai/session_notification" {
			vendor = append(vendor, record)
			if record.SessionID == "fake-session" {
				lifecycle = append(lifecycle, record)
			}
		}
	}
	if len(vendor) != 5 {
		t.Fatalf("spawned, progress, the child's response_completed + turn_completed, finished: each recorded verbatim; got %d", len(vendor))
	}
	var kinds []string
	for _, record := range lifecycle {
		kind, _ := jsonx.Get(jsonx.ParseRecord(record.Frame.Native), "update", "sessionUpdate").(string)
		kinds = append(kinds, kind)
	}
	// A frame that names a child but carries the parent's envelope is the parent's.
	equalStrings(t, kinds, []string{"subagent_spawned", "subagent_progress", "subagent_finished"})
	for _, record := range vendor {
		if record.Seq == lifecycle[0].Seq {
			jsonEqual(t, record.Frame.Events, `[{"kind": "session_linked", "parent": "fake-session", "child": "fake-child-grok", "via": "tool_call"}]`)
		} else if len(record.Frame.Events) != 0 {
			t.Fatalf("events %v", record.Frame.Events)
		}
	}
	jsonEqual(t, lifecycle[0].Frame.Native, `{"sessionId": "fake-session", "update": {"sessionUpdate": "subagent_spawned", "subagent_id": "fake-child-grok", "parent_session_id": "fake-session", "child_session_id": "fake-child-grok", "subagent_type": "general-purpose", "description": "Echo", "model": "fixture-model-x"}}`)
	// The child's own frames (standard updates AND the vendor ledgers whose
	// envelope names the child) carry the child's id.
	var child []oar.RawEvent
	for _, record := range session.Records() {
		if record.SessionID == "fake-child-grok" {
			child = append(child, record)
		}
	}
	equalStrings(t, describeAll(child), []string{
		"event user_message_chunk",
		"event agent_message_chunk → text:child-says-hi",
		"event _x.ai/session_notification",
		"event _x.ai/session_notification",
	})
	jsonEqual(t, []json.RawMessage{child[2].Frame.Native, child[3].Frame.Native}, `[
		{"sessionId": "fake-child-grok", "update": {"sessionUpdate": "response_completed", "usage": {"input_tokens": 80, "output_tokens": 8, "cache_read_input_tokens": 0}}},
		{"sessionId": "fake-child-grok", "update": {"sessionUpdate": "turn_completed", "prompt_id": "child-prompt", "stop_reason": "end_turn", "usage": {"inputTokens": 80, "outputTokens": 8, "totalTokens": 88, "modelCalls": 1}}}]`)
	for _, record := range child {
		if len(record.AgentPath) != 0 {
			t.Fatalf("agentPath %v", record.AgentPath)
		}
	}
	// The root's prompt ledger already sums the child's calls; the child's own
	// ledgers are native-only and never folded a second time.
	jsonEqual(t, session.Usage().Value, map[string]any{"total": map[string]any{"input": 200, "output": 20}})
	persisted := persistedRecords(t, session.Records())
	jsonEqual(t, observe.GraphOf(persisted), session.Graph())
	jsonEqual(t, observe.UsageOf(persisted, session.ID(), nil), session.Usage())
	jsonEqual(t, observe.ViewOf(persisted, "").Usage, session.Usage().Value)
	jsonEqual(t, session.ContextUsage().Value, map[string]any{"tokens": 300, "contextWindow": nil, "percent": nil})
}

func promptAnswers(session oar.Session) [][]oar.EventBody {
	var out [][]oar.EventBody
	for _, frame := range frames(session) {
		if frame.Type == "session/prompt" {
			out = append(out, frame.Events)
		}
	}
	return out
}

func TestGrokPerPromptLedgersAccumulateIntoTheSessionTotalStampedCumulativeOnEachAnswer(t *testing.T) {
	session := start(t, grokOnFixture)
	if run := promptAndWait(t, session, "grok-usage", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	jsonEqual(t, session.Usage().Value, map[string]any{"total": map[string]any{"input": 100, "output": 7, "cacheRead": 64, "cacheWrite": 0}})
	if run := promptAndWait(t, session, "grok-usage", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	jsonEqual(t, session.Usage().Value, map[string]any{"total": map[string]any{"input": 200, "output": 14, "cacheRead": 128, "cacheWrite": 0}})
	jsonEqual(t, session.ContextUsage().Value, map[string]any{"tokens": 1002, "contextWindow": nil, "percent": nil})
	jsonEqual(t, promptAnswers(session), `[
		[{"kind": "turn_ended", "outcome": {"kind": "completed"}}, {"kind": "usage", "usage": {"context": {"tokens": 1001, "contextWindow": null, "percent": null}, "tokens": {"input": 100, "output": 7, "cacheRead": 64, "cacheWrite": 0}}}],
		[{"kind": "turn_ended", "outcome": {"kind": "completed"}}, {"kind": "usage", "usage": {"context": {"tokens": 1002, "contextWindow": null, "percent": null}, "tokens": {"input": 200, "output": 14, "cacheRead": 128, "cacheWrite": 0}}}]]`)
}

func queueChangedRecords(t *testing.T, edit func(*acp.Profile)) []oar.RawEvent {
	session := start(t, edit)
	if run := promptAndWait(t, session, "grok-usage", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	if err := session.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	var out []oar.RawEvent
	for _, record := range session.Records() {
		if record.Kind == oar.KindFrame && record.Frame.Type == "_x.ai/queue/changed" {
			out = append(out, record)
		}
	}
	return out
}

func TestAListedVendorMethodReachesTheStreamVerbatimUnderTheRoot(t *testing.T) {
	queue := queueChangedRecords(t, grokOnFixture)
	if len(queue) != 1 {
		t.Fatalf("%d records", len(queue))
	}
	jsonEqual(t, queue[0].Frame, `{"type": "_x.ai/queue/changed", "native": {"sessionId": "fake-session", "entries": [{"id": "queue-1", "version": 0, "kind": "prompt", "text": "grok-usage", "position": 0}]}, "events": []}`)
	if queue[0].SessionID != "fake-session" {
		t.Fatal(queue[0].SessionID)
	}
}

func TestTheSamePushOnAnUnlistedMethodIsAFrameOARNeverSees(t *testing.T) {
	if queue := queueChangedRecords(t, func(profile *acp.Profile) {
		profile.PromptContextUsage = grok.ContextUsage
		profile.PromptTokenUsage = grok.PromptTokens
	}); len(queue) != 0 {
		t.Fatalf("%d records", len(queue))
	}
}

// live-grok-b/steer.voyage.jsonl: the cancelled answer bills its one model
// call (16776/222), the closing answer ITS OWN two calls (34420/279,
// `modelCalls: 2`): two per-prompt ledgers, so the session sum is
// 51196/501 and neither call is counted twice. Their cache reads (640,
// 19968) sum the same way; neither ledger names a cache write, so the total
// has no `cacheWrite`.
func TestASendNowSteersTwoAnswersAreTwoPerPromptLedgersSummedOnceStampedCumulative(t *testing.T) {
	session := start(t, func(profile *acp.Profile) {
		grokOnFixture(profile)
		sendNow(profile)
	})
	base := control(t)(session.Prompt(context.Background(), "grok-steer-base", oar.InputOptions{}))
	if base.Kind != oar.ResponseAccepted {
		t.Fatal(base.Kind)
	}
	if steered := mustSteer(t, session, "grok-steer-new", oar.InputOptions{}); steered.Kind != oar.ResponseAccepted {
		t.Fatal(steered.Kind)
	}
	jsonEqual(t, awaitTurnEnd(t, session, base.Seq), map[string]any{"kind": "completed"})
	jsonEqual(t, promptAnswers(session), `[
		[{"kind": "usage", "usage": {"context": {"tokens": 16998, "contextWindow": null, "percent": null}, "tokens": {"input": 16776, "output": 222, "cacheRead": 640}}}],
		[{"kind": "turn_ended", "outcome": {"kind": "completed"}}, {"kind": "usage", "usage": {"context": {"tokens": 17405, "contextWindow": null, "percent": null}, "tokens": {"input": 51196, "output": 501, "cacheRead": 20608}}}]]`)
	jsonEqual(t, session.Usage().Value, map[string]any{"total": map[string]any{"input": 51196, "output": 501, "cacheRead": 20608}})
}

// ─── acp-kimi-wire-shapes.test.ts ──────────────────────────────────────────

// Frames as kimi 0.42.0 sent them on 2026-09-11; session id, terminal id
// and the Agent report shortened.
const (
	kimiBashID  = "0:tool_xRsGw1smHmgUciSAgVqpGdac"
	kimiAgentID = "0:tool_XDTuEZqRATUtpXLvx4Vu30C1"
	agentReport = "agent_id: agent-0\nactual_subagent_type: coder\nstatus: completed"
)

func textContent(text string) []any {
	return []any{map[string]any{"content": map[string]any{"text": text, "type": "text"}, "type": "content"}}
}

func projectValue(t *testing.T, state *acp.ProjectionState, update map[string]any) []oar.EventBody {
	t.Helper()
	encoded, err := json.Marshal(update)
	if err != nil {
		t.Fatal(err)
	}
	return acp.ProjectUpdate(state, encoded)
}

// opening: the opening `tool_call` carries the tool's name only as `title`, and no `rawInput`.
func openingCall(t *testing.T, state *acp.ProjectionState, toolCallID, title, kind string) []oar.EventBody {
	return projectValue(t, state, map[string]any{"toolCallId": toolCallID, "title": title, "kind": kind, "status": "pending", "content": textContent(""), "sessionUpdate": "tool_call"})
}

func TestKimiToolFramesTheLabelIsTheOpeningTitleAndTheInputArrivesOnALaterUpdate(t *testing.T) {
	state := acp.NewProjectionState()
	jsonEqual(t, openingCall(t, state, kimiBashID, "Bash", "execute"), `[{"kind": "tool_call_started", "callId": "`+kimiBashID+`", "tool": "Bash"}]`)
	// The arguments stream as `content` text and land as `rawInput` on a later update.
	later := project(state, `{"toolCallId": "`+kimiBashID+`", "kind": "execute", "status": "in_progress", "title": "Running: echo TOOL-MARK-4412",
		"content": [{"content": {"text": "{\"command\":\"echo TOOL-MARK-4412\"}", "type": "text"}, "type": "content"}],
		"rawInput": {"command": "echo TOOL-MARK-4412"}, "sessionUpdate": "tool_call_update"}`)
	jsonEqual(t, later, `[{"kind": "tool_call_input", "callId": "`+kimiBashID+`", "input": "{\"command\":\"echo TOOL-MARK-4412\"}"}]`)
	jsonEqual(t, openingCall(t, state, kimiAgentID, "Agent", "other"), `[{"kind": "tool_call_started", "callId": "`+kimiAgentID+`", "tool": "Agent"}]`)
}

func TestKimiToolEndsTerminalReferenceAndAgentReport(t *testing.T) {
	state := acp.NewProjectionState()
	openingCall(t, state, kimiBashID, "Bash", "execute")
	openingCall(t, state, kimiAgentID, "Agent", "other")
	terminal := projectValue(t, state, map[string]any{"toolCallId": kimiBashID, "status": "completed", "content": []any{map[string]any{"terminalId": "bb80f18f", "type": "terminal"}}, "sessionUpdate": "tool_call_update"})
	jsonEqual(t, terminal, `[{"kind": "tool_call_ended", "callId": "`+kimiBashID+`", "content": [{"type": "other", "value": {"terminalId": "bb80f18f", "type": "terminal"}}], "result": "ok"}]`)
	agent := projectValue(t, state, map[string]any{"toolCallId": kimiAgentID, "status": "completed", "content": textContent(agentReport), "rawOutput": agentReport, "sessionUpdate": "tool_call_update"})
	jsonEqual(t, agent, []any{map[string]any{"kind": "tool_call_ended", "callId": kimiAgentID, "content": []any{map[string]any{"type": "text", "text": agentReport}}, "result": "ok"}})
}

func TestToolCallUpdateMapsFailedStatusAndOmitsResultWhenStatusIsAbsent(t *testing.T) {
	failed := project(acp.NewProjectionState(), `{"toolCallId": "failed", "status": "failed", "rawOutput": "boom", "sessionUpdate": "tool_call_update"}`)
	jsonEqual(t, failed, `[{"kind": "tool_call_started", "callId": "failed", "tool": "tool"}, {"kind": "tool_call_ended", "callId": "failed", "content": [{"type": "text", "text": "boom"}], "result": "failed"}]`)
	unknown := project(acp.NewProjectionState(), `{"toolCallId": "unknown", "rawOutput": "?", "sessionUpdate": "tool_call_update"}`)
	jsonEqual(t, unknown, `[{"kind": "tool_call_started", "callId": "unknown", "tool": "tool"}]`)
}

func TestANonTerminalToolCallUpdateWithRawOutputIsProgressOneWithContentOnlyIsNot(t *testing.T) {
	state := acp.NewProjectionState()
	openingCall(t, state, kimiBashID, "Bash", "execute")
	argumentsOnly := projectValue(t, state, map[string]any{"toolCallId": kimiBashID, "status": "in_progress", "content": textContent(`{"command":"ls"}`), "sessionUpdate": "tool_call_update"})
	if len(argumentsOnly) != 0 {
		t.Fatalf("streamed arguments are input, not progress output: %v", argumentsOnly)
	}
	streamed := project(state, `{"toolCallId": "`+kimiBashID+`", "status": "in_progress", "rawOutput": "partial", "sessionUpdate": "tool_call_update"}`)
	jsonEqual(t, streamed, `[{"kind": "tool_call_progress", "callId": "`+kimiBashID+`", "output": "partial"}]`)
	done := project(state, `{"toolCallId": "`+kimiBashID+`", "status": "completed", "rawOutput": "partial and rest", "sessionUpdate": "tool_call_update"}`)
	jsonEqual(t, done, `[{"kind": "tool_call_ended", "callId": "`+kimiBashID+`", "content": [{"type": "text", "text": "partial and rest"}], "result": "ok"}]`)
}

func TestANameBearingFrameStillLabelsTheToolByNameAndAKindOnlyFrameByKind(t *testing.T) {
	state := acp.NewProjectionState()
	jsonEqual(t, project(state, `{"toolCallId": "a", "name": "Read", "kind": "read", "title": "Read input.txt", "sessionUpdate": "tool_call"}`), `[{"kind": "tool_call_started", "callId": "a", "tool": "Read"}]`)
	jsonEqual(t, project(state, `{"toolCallId": "b", "kind": "search", "sessionUpdate": "tool_call"}`), `[{"kind": "tool_call_started", "callId": "b", "tool": "search"}]`)
	// Precedence: name > toolName > title (opening frame only) > kind.
	jsonEqual(t, project(state, `{"toolCallId": "c", "toolName": "Bash", "kind": "execute", "title": "Running: echo hi", "sessionUpdate": "tool_call"}`), `[{"kind": "tool_call_started", "callId": "c", "tool": "Bash"}]`)
}

func TestACallFirstSeenOnAToolCallUpdateIsNotLabelledByThatFramesProgressTitle(t *testing.T) {
	state := acp.NewProjectionState()
	// The opening frame was missed: the update's `title` is progress text, so the label is the kind.
	jsonEqual(t, project(state, `{"toolCallId": "`+kimiBashID+`", "kind": "execute", "status": "in_progress", "title": "Running: echo TOOL-MARK-4412", "rawInput": {"command": "echo TOOL-MARK-4412"}, "sessionUpdate": "tool_call_update"}`),
		`[{"kind": "tool_call_started", "callId": "`+kimiBashID+`", "tool": "execute", "input": "{\"command\":\"echo TOOL-MARK-4412\"}"}]`)
	// With a name on the update, the name still wins.
	jsonEqual(t, project(state, `{"toolCallId": "d", "toolName": "Bash", "title": "Running: ls", "sessionUpdate": "tool_call_update"}`), `[{"kind": "tool_call_started", "callId": "d", "tool": "Bash"}]`)
}

// kimi 0.42.0 kill-runtime run: after SIGKILL the `exited` response points
// at no request and the later dispose request had no answer at all.
func TestADisposeAfterAnUnrequestedExitIsAnsweredAcceptedTheExitStayingUnrequested(t *testing.T) {
	session := start(t, nil)
	if run := promptAndWait(t, session, "exit", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	var exit *oar.RawEvent
	for _, record := range session.Records() {
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
			copied := record
			exit = &copied
			break
		}
	}
	if exit == nil || exit.RequestID != "" {
		t.Fatalf("the exit points at no request: %+v", exit)
	}
	if err := session.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	records := session.Records()
	last := records[len(records)-2:]
	equalStrings(t, describeAll(last), []string{"request dispose", "response accepted"})
	if last[1].RequestID != last[0].ID {
		t.Fatalf("%+v", last)
	}
	after := control(t)(session.Prompt(context.Background(), "after dispose", oar.InputOptions{}))
	if after.Kind != oar.ResponseRejected {
		t.Fatal(after.Kind)
	}
	if err := session.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
}
