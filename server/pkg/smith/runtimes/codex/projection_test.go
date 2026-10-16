package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/replay/codex-projection.test.ts, codex-resume.test.ts,
// codex-steer-order.test.ts, tests/codex/codex-input-dropped.test.ts,
// codex-item-detail.test.ts, codex-reasoning.test.ts,
// codex-token-usage.test.ts, and the codex parts of
// tests/app-request-cancelled.test.ts, native-turn-active.test.ts and
// tool-output-delta.test.ts.

const replayFixtures = "../../testdata/replay/fixtures"
const root = "thread-root"

func fixtureLines(t *testing.T, name string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(replayFixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func describeCommand(command projectionCommand) string {
	if command.Kind == "link" {
		return "link " + command.Edge.Parent + " → " + command.Edge.Child + " (" + command.Edge.Via + ")"
	}
	where := ""
	if command.SessionID != "" {
		where = " @thread:" + command.SessionID
	}
	var events []string
	for _, event := range command.Body.Events {
		switch typed := event.(type) {
		case oar.ToolCallStarted:
			events = append(events, "tool_call_started "+typed.Tool)
		case oar.Reasoning:
			events = append(events, "reasoning "+typed.Content.Kind)
		case oar.TurnEnded:
			events = append(events, "turn_ended "+typed.Outcome.Kind)
		default:
			events = append(events, event.EventKind())
		}
	}
	if len(events) == 0 {
		return "event" + where
	}
	return "event" + where + " → " + strings.Join(events, ", ")
}

func foldFixture(lines []string) string {
	state := initialCodexProjection(root, methodThreadStart)
	var rows []string
	for _, line := range lines {
		method, ok := jsonx.ParseRecord([]byte(line))["method"].(string)
		if !ok {
			continue
		}
		next, commands := foldCodexNotification(state, method, json.RawMessage(line))
		state = next
		produced := []string{}
		for _, command := range commands {
			produced = append(produced, describeCommand(command))
		}
		text := strings.Join(produced, ", ")
		if text == "" {
			text = "-"
		}
		rows = append(rows, method+strings.Repeat(" ", max(28-len(method), 0))+" │ "+text)
	}
	return strings.Join(rows, "\n") + "\n"
}

func TestRecordedNotificationsFoldToTheExpectedRecords(t *testing.T) {
	for _, scenario := range []string{"tool-round", "subagent", "file-change", "mcp-echo"} {
		t.Run(scenario, func(t *testing.T) {
			want, err := os.ReadFile(filepath.Join(replayFixtures, "codex-"+scenario+".projected.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if got := foldFixture(fixtureLines(t, "codex-"+scenario+".raw.jsonl")); got != string(want) {
				t.Fatalf("projection differs:\n%s", got)
			}
		})
	}
}

type frame struct {
	method string
	params jsonx.Record
}

func foldFrames(t *testing.T, frames []frame) []string {
	state := initialCodexProjection(root, methodThreadStart)
	var rows []string
	for _, item := range frames {
		next, commands := fold(t, state, item.method, item.params)
		state = next
		var described []string
		for _, command := range commands {
			described = append(described, describeCommand(command))
		}
		rows = append(rows, strings.Join(described, ", "))
	}
	return rows
}

func TestNotificationsOfAnotherThreadAreChildSessionRecordsCollabItemsLinkThem(t *testing.T) {
	rows := foldFrames(t, []frame{
		{"item/started", jsonx.Record{"threadId": root, "turnId": "t1", "item": jsonx.Record{"type": "collabAgentToolCall", "id": "c1", "senderThreadId": root, "receiverThreadIds": []any{"thread-child"}}}},
		{"turn/started", jsonx.Record{"threadId": "thread-child", "turn": jsonx.Record{"id": "t-child"}}},
		{"item/agentMessage/delta", jsonx.Record{"threadId": "thread-child", "turnId": "t-child", "delta": "hi"}},
		{"item/completed", jsonx.Record{"threadId": root, "turnId": "t1", "item": jsonx.Record{"type": "subAgentActivity", "id": "s1", "agentThreadId": "thread-child"}}},
	})
	sameJSON(t, rows, `["event, link thread-root → thread-child (tool_call)","event @thread:thread-child → turn_active","event @thread:thread-child → text_delta","event, link thread-root → thread-child (tool_call)"]`)
	_, commands := fold(t, initialCodexProjection(root, methodThreadStart), "item/agentMessage/delta", jsonx.Record{"threadId": "thread-child", "turnId": "t-child", "delta": "x"})
	if commands[0].SpanID != "t-child" {
		t.Fatalf("spanId %q", commands[0].SpanID)
	}
}

// tasksAndEdges is the task events (`reporting thread: kind taskId`) and distinct edges lines fold to.
func tasksAndEdges(lines []string) (tasks, edges []string) {
	state := initialCodexProjection(root, methodThreadStart)
	seen := map[string]bool{}
	tasks, edges = []string{}, []string{}
	for _, line := range lines {
		method, _ := jsonx.ParseRecord([]byte(line))["method"].(string)
		next, commands := foldCodexNotification(state, method, json.RawMessage(line))
		state = next
		for _, command := range commands {
			if command.Kind == "link" {
				edge := command.Edge.Parent + " → " + command.Edge.Child
				if !seen[edge] {
					seen[edge] = true
					edges = append(edges, edge)
				}
				continue
			}
			reporter := root
			if command.SessionID != "" {
				reporter = command.SessionID
			}
			for _, event := range command.Body.Events {
				switch typed := event.(type) {
				case oar.TaskStarted:
					tasks = append(tasks, reporter+": task_started "+typed.TaskID)
				case oar.TaskUpdated:
					tasks = append(tasks, reporter+": task_updated "+typed.TaskID)
				case oar.TaskEnded:
					tasks = append(tasks, reporter+": task_ended "+typed.TaskID)
				}
			}
		}
	}
	return tasks, edges
}

func TestPeersSubAgentActivityChangesOnlyOwnChildrensTasksAndEdges(t *testing.T) {
	// Recorded on 0.158.0: root starts alpha and beta, alpha messages beta and
	// starts gamma, gamma messages the root. Each reports on its own thread.
	tasks, edges := tasksAndEdges(fixtureLines(t, "codex-peers.raw.jsonl"))
	sameJSON(t, tasks, `["thread-root: task_started thread-alpha","thread-root: task_started thread-beta","thread-alpha: task_started thread-gamma","thread-root: task_ended thread-beta","thread-alpha: task_ended thread-gamma","thread-root: task_ended thread-alpha"]`)
	sameJSON(t, edges, `["thread-root → thread-alpha","thread-root → thread-beta","thread-alpha → thread-gamma"]`)
}

func activity(thread, kind, agentThreadID, agentPath string) string {
	return jsonText(jsonx.Record{"method": "item/completed", "threadId": thread, "item": jsonx.Record{"type": "subAgentActivity", "id": thread + "-" + kind, "kind": kind, "agentThreadId": agentThreadID, "agentPath": agentPath}})
}

func TestPeersAfterAResumeTheAgentPathDecidesWhoseChildAnUnstartedThreadIs(t *testing.T) {
	// alpha, beta and gamma were started before the resume, so no `started`
	// item names them; the parent path says beta is the root's, gamma alpha's.
	tasks, edges := tasksAndEdges([]string{
		activity("thread-alpha", "interacted", "thread-beta", "/root/beta"),
		activity("thread-alpha", "completed", "thread-gamma", "/root/alpha/gamma"),
		activity(root, "completed", "thread-beta", "/root/beta"),
		activity(root, "interacted", "thread-gamma", "/root/alpha/gamma"),
	})
	sameJSON(t, tasks, `["thread-alpha: task_ended thread-gamma","thread-root: task_ended thread-beta"]`)
	sameJSON(t, edges, `["thread-alpha → thread-gamma","thread-root → thread-beta"]`)
}

func TestErrorDetailFoldsIntoTheFailedTurnEndedAndUsageIsTheCumulativeTotal(t *testing.T) {
	state, _ := fold(t, initialCodexProjection(root, methodThreadStart), "error", jsonx.Record{"threadId": root, "error": jsonx.Record{"message": "boom", "additionalDetails": "quota"}})
	// The class is the turn's own codexErrorInfo, not the words.
	completed, commands := fold(t, state, "turn/completed", jsonx.Record{"threadId": root, "turn": jsonx.Record{"id": "t1", "status": "failed", "error": jsonx.Record{"message": "boom", "codexErrorInfo": "usageLimitExceeded"}}})
	sameJSON(t, commands[0].Body.Events, `[{"kind":"turn_ended","outcome":{"kind":"failed","reason":"failed: boom: quota","failure":"quota"}}]`)
	if completed.LastErrorDetail != nil {
		t.Fatal("lastErrorDetail kept")
	}
	_, usage := fold(t, state, "thread/tokenUsage/updated", jsonx.Record{"threadId": root, "tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 120, "outputTokens": 30}}})
	sameJSON(t, usage[0].Body.Events, `[{"kind":"usage","usage":{"context":{"tokens":120,"contextWindow":null,"percent":null},"tokens":{"input":120,"output":30}}}]`)
}

func TestToolCompletionMapsAnExplicitItemStatusAndOtherwiseLeavesResultAbsent(t *testing.T) {
	_, failed := fold(t, initialCodexProjection(root, methodThreadStart), "item/completed", jsonx.Record{"threadId": root, "item": jsonx.Record{"type": "commandExecution", "id": "exec-fail", "status": "failed", "aggregatedOutput": "boom"}})
	sameJSON(t, failed[0].Body.Events, `[{"kind":"tool_call_ended","callId":"exec-fail","content":[{"type":"text","text":"boom"}],"result":"failed"}]`)
	_, unknown := fold(t, initialCodexProjection(root, methodThreadStart), "item/completed", jsonx.Record{"threadId": root, "item": jsonx.Record{"type": "commandExecution", "id": "exec-unknown", "aggregatedOutput": "?"}})
	sameJSON(t, unknown[0].Body.Events, `[{"kind":"tool_call_ended","callId":"exec-unknown","content":[{"type":"text","text":"?"}]}]`)
}

// Live, codex 0.154.0: `total.inputTokens` grew 12661 → 28404 → 44166 over
// three one-word turns while `last.totalTokens` stayed near 15.7k and
// `modelContextWindow` was 121600.
func TestContextFullnessIsTheLastModelCallsTotalAgainstModelContextWindow(t *testing.T) {
	state := initialCodexProjection(root, methodThreadStart)
	_, commands := fold(t, state, "thread/tokenUsage/updated", jsonx.Record{"threadId": root, "turnId": "t3", "tokenUsage": jsonx.Record{
		"total":              jsonx.Record{"totalTokens": 44_201, "inputTokens": 44_166, "cachedInputTokens": 32_512, "outputTokens": 35, "reasoningOutputTokens": 0},
		"last":               jsonx.Record{"totalTokens": 15_774, "inputTokens": 15_762, "cachedInputTokens": 15_616, "outputTokens": 12, "reasoningOutputTokens": 0},
		"modelContextWindow": 121_600,
	}})
	sameJSON(t, commands[0].Body.Events, `[{"kind":"usage","usage":{"context":{"tokens":15774,"contextWindow":121600,"percent":13},"tokens":{"input":44166,"output":35,"cacheRead":32512,"reasoning":0}}}]`)
	_, nullWindow := fold(t, state, "thread/tokenUsage/updated", jsonx.Record{"threadId": root, "tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 200, "outputTokens": 5}, "last": jsonx.Record{"totalTokens": 85, "inputTokens": 80, "outputTokens": 5}, "modelContextWindow": nil}})
	sameJSON(t, nullWindow[0].Body.Events, `[{"kind":"usage","usage":{"context":{"tokens":85,"contextWindow":null,"percent":null},"tokens":{"input":200,"output":5}}}]`)
	// No `last` (older builds): occupancy is unknown, so the window is null
	// and no percent is computed even when the notification names a window.
	_, noLast := fold(t, state, "thread/tokenUsage/updated", jsonx.Record{"threadId": root, "tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 200, "outputTokens": 5}, "modelContextWindow": 121_600}})
	sameJSON(t, noLast[0].Body.Events, `[{"kind":"usage","usage":{"context":{"tokens":200,"contextWindow":null,"percent":null},"tokens":{"input":200,"output":5}}}]`)
}

func TestCompactionIsTheContextCompactionItemAndThreadCompactedClosesNothingTwice(t *testing.T) {
	rows := foldFrames(t, []frame{
		{"item/started", jsonx.Record{"threadId": root, "turnId": "t1", "item": jsonx.Record{"id": "cc_1", "type": "contextCompaction"}}},
		{"item/completed", jsonx.Record{"threadId": root, "turnId": "t1", "item": jsonx.Record{"id": "cc_1", "type": "contextCompaction"}}},
		{"thread/compacted", jsonx.Record{"threadId": root, "turnId": "t1"}},
		{"item/commandExecution/outputDelta", jsonx.Record{"threadId": root, "turnId": "t1", "itemId": "call_9", "delta": "hello\n"}},
	})
	sameJSON(t, rows, `["event → compaction_started","event → compaction_ended","event","event → tool_call_progress"]`)
}

func TestThreadCompactedAloneEndsAnOpenCompactionOnce(t *testing.T) {
	started, _ := fold(t, initialCodexProjection(root, methodThreadStart), "item/started", jsonx.Record{"threadId": root, "item": jsonx.Record{"id": "cc_2", "type": "contextCompaction"}})
	compacted, first := fold(t, started, "thread/compacted", jsonx.Record{"threadId": root, "turnId": "t2"})
	_, again := fold(t, compacted, "thread/compacted", jsonx.Record{"threadId": root, "turnId": "t2"})
	sameJSON(t, []any{frameEvents(first), frameEvents(again)}, `[[{"kind":"compaction_ended","outcome":"completed"}],[]]`)
}

// ─── tests/replay/codex-resume.test.ts ──────────────────────────────────────

func TestResumeTheTotalReReportedBeforeTheFirstTurnIsTheSessionsBaseline(t *testing.T) {
	type session struct {
		state   codexProjectionState
		records []oar.RawEvent
	}
	var opened []*session
	for _, line := range fixtureLines(t, "codex-resume.raw.jsonl") {
		method, _ := jsonx.ParseRecord([]byte(line))["method"].(string)
		if method == methodThreadStart || method == methodThreadResume {
			opened = append(opened, &session{state: initialCodexProjection(root, method)})
			continue
		}
		if len(opened) == 0 {
			continue
		}
		current := opened[len(opened)-1]
		next, commands := foldCodexNotification(current.state, method, json.RawMessage(line))
		current.state = next
		for _, command := range commands {
			if command.Kind == "frame" {
				current.records = append(current.records, oar.RawEvent{Envelope: oar.Envelope{SessionID: root, Seq: int64(len(current.records)), SpanID: command.SpanID}, Kind: oar.KindFrame, Frame: command.Body})
			}
		}
	}
	turns := map[string]string{}
	for index, name := range []string{"opened", "resumed"} {
		for _, record := range opened[index].records {
			if record.Frame.Type == "turn/started" && record.SpanID != "" {
				turns[record.SpanID] = name + "'s turn"
			}
		}
	}
	usageLines := func(records []oar.RawEvent) []string {
		lines := []string{}
		for _, record := range records {
			for _, event := range record.Frame.Events {
				usage, ok := event.(oar.Usage)
				if !ok {
					continue
				}
				turn, ok := turns[record.SpanID]
				if !ok {
					turn = "?"
				}
				tokens := usage.Usage.Tokens
				lines = append(lines, turn+": "+jsString(float64(tokens.Input))+"/"+jsString(float64(tokens.Output))+" ("+jsString(float64(*tokens.CacheRead))+"/"+jsString(float64(*tokens.CacheWrite))+"), context "+jsString(float64(*usage.Usage.Context.Tokens)))
			}
		}
		return lines
	}
	sameJSON(t, map[string]any{"opened": usageLines(opened[0].records), "resumed": usageLines(opened[1].records)}, `{
		"opened": ["opened's turn: 1000/5 (0/0), context 1005"],
		"resumed": ["opened's turn: 0/0 (0/0), context 1005", "resumed's turn: 1200/7 (0/0), context 1207"]
	}`)
	own := `{"total":{"input":1200,"output":7,"cacheRead":0,"cacheWrite":0,"reasoning":0}}`
	sameJSON(t, observe.UsageOf(opened[0].records, "", nil).Value, `{"total":{"input":1000,"output":5,"cacheRead":0,"cacheWrite":0,"reasoning":0}}`)
	sameJSON(t, observe.UsageOf(opened[1].records, "", nil).Value, own)
	sameJSON(t, observe.ViewOf(opened[1].records, "").Usage, own)
}

// ─── tests/replay/codex-steer-order.test.ts ─────────────────────────────────

// reread is the recorded steer-order stream with every notification frame
// re-read by the codex projection; one whose native the scrub emptied keeps
// its recorded events.
func reread(t *testing.T) (original, records []oar.RawEvent) {
	for _, line := range fixtureLines(t, "codex-steer-order.records.jsonl") {
		fields := jsonx.ParseRecord([]byte(line))
		if _, ok := fields["kind"].(string); !ok {
			continue
		}
		if _, ok := fields["seq"].(float64); !ok {
			continue
		}
		if _, ok := fields["sessionId"].(string); !ok {
			continue
		}
		var record oar.RawEvent
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		original = append(original, record)
	}
	state := initialCodexProjection(original[0].SessionID, methodThreadStart)
	for _, record := range original {
		params := jsonx.ParseRecord(record.Frame.Native)
		if record.Kind != oar.KindFrame || len(params) == 0 {
			records = append(records, record)
			continue
		}
		next, commands := foldCodexNotification(state, record.Frame.Type, record.Frame.Native)
		state = next
		copied := record
		copied.Frame = commands[0].Body
		records = append(records, copied)
	}
	return original, records
}

func outline(view observe.SessionView) []string {
	lines := []string{}
	for _, message := range view.Messages {
		switch message.Kind {
		case "input":
			lines = append(lines, "input "+message.Input.Input)
		case "turn":
			line := "turn"
			if message.Outcome != nil {
				line += " (" + message.Outcome.Kind + ")"
			}
			lines = append(lines, line)
			for _, section := range message.Sections {
				for _, part := range section.Parts {
					switch part.Kind {
					case "text":
						lines = append(lines, "  text "+part.Text)
					case "tool":
						input := ""
						if part.Input != nil {
							input = *part.Input
						}
						lines = append(lines, "  "+strings.TrimSpace("tool "+part.Tool+" "+input))
					default:
						lines = append(lines, "  "+part.Kind)
					}
				}
			}
		case "notice":
			lines = append(lines, "notice "+message.Notice.Cause)
		}
	}
	pending := []string{}
	for _, input := range view.PendingInputs {
		pending = append(pending, input.Input)
	}
	return append(lines, "pending ["+strings.Join(pending, ", ")+"]")
}

func TestSteersEnterWhereCodexTookThemAndEachAgentMessageIsItsOwnTextPart(t *testing.T) {
	_, records := reread(t)
	sameJSON(t, outline(observe.ViewOf(records, "")), `[
		"input sleep 100", "turn", "  text 好，我等 100 秒。", "  tool sleep {\"durationMs\":50000}",
		"input test 1", "turn", "  text 收到“test 1”。刚才的等待被新消息打断了，我会继续等满剩余时间。", "  tool sleep {\"durationMs\":50000}",
		"input test 2", "input test 3", "turn (completed)", "  text 收到“test 2”和“test 3”。我继续按最初的要求等待。",
		"  tool sleep {\"durationMs\":50000}", "  tool sleep {\"durationMs\":42500}", "  text 已等待约 100 秒，也收到了你的三条测试消息。",
		"pending []"]`)
}

func TestSteersCodexHasNotTakenYetWaitInPendingInputs(t *testing.T) {
	_, records := reread(t)
	upTo := -1
	for index, record := range records {
		if record.Kind == oar.KindResponse && record.Seq == 37 {
			upTo = index
		}
	}
	sameJSON(t, outline(observe.ViewOf(records[:upTo+1], "")), `[
		"input sleep 100", "turn", "  text 好，我等 100 秒。", "  tool sleep {\"durationMs\":50000}",
		"input test 1", "pending [test 2, test 3]"]`)
}

func textsOf(records []oar.RawEvent) []oar.TextDelta {
	texts := []oar.TextDelta{}
	for _, event := range recordEvents(records) {
		if text, ok := event.(oar.TextDelta); ok {
			texts = append(texts, text)
		}
	}
	return texts
}

func TestRereadingGivesTheRecordedTextEachItsAgentMessageIDFoldingTwiceChangesNothing(t *testing.T) {
	original, records := reread(t)
	texts := textsOf(records)
	ids := map[string]bool{}
	stripped := []oar.TextDelta{}
	for _, text := range texts {
		id := text.MessageID
		if id == "" {
			id = "none"
		}
		ids[id] = true
		text.MessageID = ""
		stripped = append(stripped, text)
	}
	sameJSON(t, stripped, jsonOf(t, textsOf(original)))
	if len(ids) != 4 {
		t.Fatalf("message ids %v", ids)
	}
	once := observe.ViewOf(records, "")
	twice := observe.ViewOf(append(append([]oar.RawEvent{}, records...), records...), "")
	sameJSON(t, twice.Messages, jsonOf(t, once.Messages))
	sameJSON(t, twice.PendingInputs, jsonOf(t, once.PendingInputs))
}

func TestAgentMessageDeltasNameTheirItemAsTheTextsMessageID(t *testing.T) {
	_, named := fold(t, initialCodexProjection(root, methodThreadStart), "item/agentMessage/delta", jsonx.Record{"threadId": root, "turnId": "t1", "itemId": "msg_1", "delta": "hi"})
	sameJSON(t, named[0].Body.Events, `[{"kind":"text_delta","text":"hi","messageId":"msg_1"}]`)
	_, bare := fold(t, initialCodexProjection(root, methodThreadStart), "item/agentMessage/delta", jsonx.Record{"threadId": root, "turnId": "t1", "delta": "hi"})
	sameJSON(t, bare[0].Body.Events, `[{"kind":"text_delta","text":"hi"}]`)
}

// ─── tests/codex/codex-input-dropped.test.ts ────────────────────────────────

func acceptedSteer(state codexProjectionState, inputID, turnID string) codexProjectionState {
	state.Inputs = acceptCodexSteer(state.Inputs, turnID, inputID)
	return state
}

func echo(t *testing.T, state codexProjectionState, inputID string) codexProjectionState {
	next, _ := fold(t, state, "item/started", jsonx.Record{"threadId": "root", "turnId": "turn-1", "item": jsonx.Record{"type": "userMessage", "id": "item-" + inputID, "clientId": inputID, "content": []any{jsonx.Record{"type": "text", "text": inputID}}}})
	return next
}

func end(t *testing.T, state codexProjectionState, status, threadID string) (codexProjectionState, []projectionCommand) {
	return fold(t, state, "turn/completed", jsonx.Record{"threadId": threadID, "turn": jsonx.Record{"id": "turn-1", "status": status}})
}

func TestAnInterruptedRootTurnDropsOnlyItsAcceptedUnechoedSteersBeforeItsEnd(t *testing.T) {
	state := initialCodexProjection("root", methodThreadStart)
	state = acceptedSteer(acceptedSteer(acceptedSteer(state, "read", "turn-1"), "unread", "turn-1"), "other-turn", "turn-2")
	state = echo(t, state, "read")
	next, commands := end(t, state, "interrupted", "root")
	if len(commands) != 1 || commands[0].SpanID != "turn-1" || commands[0].SessionID != "" {
		t.Fatalf("commands %+v", commands)
	}
	sameJSON(t, commands[0].Body, `{"type":"turn/completed","native":{"threadId":"root","turn":{"id":"turn-1","status":"interrupted"}},"events":[{"kind":"input_dropped","inputId":"unread","reason":"turn_interrupted"},{"kind":"turn_ended","outcome":{"kind":"aborted"}}]}`)
	if _, ok := next.Inputs["turn-2"]; !ok || len(next.Inputs) != 1 {
		t.Fatalf("inputs %v", next.Inputs)
	}
	if _, again := end(t, next, "interrupted", "root"); len(eventsOfKind(frameEvents(again), "input_dropped")) != 0 {
		t.Fatal("dropped twice")
	}
}

func TestACompletedOrFailedTurnMakesNoDiscardClaim(t *testing.T) {
	for _, status := range []string{"completed", "failed"} {
		state := acceptedSteer(initialCodexProjection("root", methodThreadStart), "input", "turn-1")
		next, commands := end(t, state, status, "root")
		if len(eventsOfKind(frameEvents(commands), "input_dropped")) != 0 || len(next.Inputs) != 0 {
			t.Fatalf("%s: %v %v", status, frameEvents(commands), next.Inputs)
		}
	}
}

func TestAnEchoBeforeTheSteerReplyPreventsAFalseDrop(t *testing.T) {
	state := acceptedSteer(echo(t, initialCodexProjection("root", methodThreadStart), "early-echo"), "early-echo", "turn-1")
	_, commands := end(t, state, "interrupted", "root")
	sameJSON(t, kindsOf(frameEvents(commands)), `["turn_ended"]`)
}

func kindsOf(events []oar.EventBody) []string {
	kinds := []string{}
	for _, event := range events {
		kinds = append(kinds, event.EventKind())
	}
	return kinds
}

func TestAChildCompletionCannotDiscardRootSteeringEvenWithTheSameTurnID(t *testing.T) {
	state := acceptedSteer(initialCodexProjection("root", methodThreadStart), "root-input", "turn-1")
	child, commands := end(t, state, "interrupted", "child")
	if !reflect.DeepEqual(child.Inputs, state.Inputs) || len(eventsOfKind(frameEvents(commands), "input_dropped")) != 0 {
		t.Fatal("a child completion changed root steering")
	}
	_, rootEnd := end(t, child, "interrupted", "root")
	sameJSON(t, eventsOfKind(frameEvents(rootEnd), "input_dropped"), `[{"kind":"input_dropped","inputId":"root-input","reason":"turn_interrupted"}]`)
}

// ─── tests/codex/codex-item-detail.test.ts ──────────────────────────────────

func itemOutput(t *testing.T, item jsonx.Record) any {
	text, ok := oar.ToolResultText(codexToolContent(raw(t, item)))
	if !ok {
		return nil
	}
	return text
}

// commandExecution item as codex 0.154.0 completed it: the exit status is
// its own field, the output is the command's, not prefixed with the status.
func TestACompletedCommandExecutionCarriesItsExitStatusAsExitCodeAndItsOutputVerbatim(t *testing.T) {
	item := jsonx.Record{"type": "commandExecution", "id": "exec-d2567803", "command": "/bin/zsh -lc 'node --test; git status --short'", "status": "completed", "aggregatedOutput": "TAP version 13\n# Subtest: add\nok 1 - add\n", "exitCode": 0, "durationMs": 120}
	sameJSON(t, codexItemExitCode(raw(t, item)), `0`)
	sameJSON(t, itemOutput(t, item), `"TAP version 13\n# Subtest: add\nok 1 - add\n"`)
	_, commands := fold(t, initialCodexProjection("thread-1", methodThreadStart), "item/completed", jsonx.Record{"threadId": "thread-1", "item": item})
	sameJSON(t, commands[0].Body.Events, `[{"kind":"tool_call_ended","callId":"exec-d2567803","content":[{"type":"text","text":"TAP version 13\n# Subtest: add\nok 1 - add\n"}],"result":"ok","exitCode":0}]`)
}

func TestExitCodeIsAbsentWhenTheItemCarriesNoneNullWhenCodexReportsASignalExit(t *testing.T) {
	if codexItemExitCode(raw(t, jsonx.Record{"type": "commandExecution", "status": "declined"})) != nil {
		t.Fatal("declined has an exit code")
	}
	sameJSON(t, codexItemExitCode(raw(t, jsonx.Record{"type": "commandExecution", "status": "failed", "exitCode": nil})), `null`)
	if codexItemExitCode(raw(t, jsonx.Record{"type": "fileChange", "status": "completed", "exitCode": 0})) != nil {
		t.Fatal("a file change has an exit code")
	}
	// No output at all: the status is the only detail left.
	sameJSON(t, itemOutput(t, jsonx.Record{"type": "commandExecution", "status": "declined"}), `"declined"`)
}

func TestProjectsCommandAndMcpInvocationDetails(t *testing.T) {
	sameJSON(t, map[string]any{
		"command": map[string]any{
			"input":  codexItemInput(raw(t, jsonx.Record{"type": "commandExecution", "command": "/tmp/coxswain-say hello"})),
			"output": itemOutput(t, jsonx.Record{"type": "commandExecution", "exitCode": 0, "aggregatedOutput": "delivered\n"}),
		},
		"mcp": map[string]any{
			"input":  codexItemInput(raw(t, jsonx.Record{"type": "mcpToolCall", "arguments": jsonx.Record{"issue": 42}})),
			"output": itemOutput(t, jsonx.Record{"type": "mcpToolCall", "result": jsonx.Record{"content": []any{jsonx.Record{"type": "text", "text": "done"}}}, "error": nil}),
		},
	}, `{"command":{"input":"/tmp/coxswain-say hello","output":"delivered\n"},"mcp":{"input":"{\"issue\":42}","output":"done"}}`)
}

func TestMcpArgumentsKeepTheirWireKeyOrder(t *testing.T) {
	input := codexItemInput(json.RawMessage(`{"type":"mcpToolCall","arguments":{"zeta":1,"alpha":{"b":2,"a":1}}}`))
	if input == nil || *input != `{"zeta":1,"alpha":{"b":2,"a":1}}` {
		t.Fatalf("input %v", input)
	}
	changes := codexItemInput(json.RawMessage(`{"type":"fileChange","changes":[{"path":"b","kind":"add"}]}`))
	if changes == nil || *changes != `[{"path":"b","kind":"add"}]` {
		t.Fatalf("changes %v", changes)
	}
}

func TestAnMcpResultsBlocksAreItsContentInOrderTheWholeResultWithoutBlocksAndAnErrorItsMessage(t *testing.T) {
	image := jsonx.Record{"type": "image", "data": "iVBOR", "mimeType": "image/png"}
	sameJSON(t, codexToolContent(raw(t, jsonx.Record{"type": "mcpToolCall", "result": jsonx.Record{"content": []any{jsonx.Record{"type": "text", "text": "shot"}, image}}})), `[{"type":"text","text":"shot"},{"type":"image","mediaType":"image/png","data":"iVBOR"}]`)
	bare := jsonx.Record{"content": []any{}, "structuredContent": jsonx.Record{"n": 1}}
	sameJSON(t, codexToolContent(raw(t, jsonx.Record{"type": "mcpToolCall", "result": bare})), `[{"type":"other","value":{"content":[],"structuredContent":{"n":1}}}]`)
	sameJSON(t, codexToolContent(raw(t, jsonx.Record{"type": "mcpToolCall", "result": nil, "error": jsonx.Record{"message": "boom"}})), `[{"type":"text","text":"error: boom"}]`)
	sameJSON(t, codexToolContent(raw(t, jsonx.Record{"type": "webSearch", "results": []any{jsonx.Record{"url": "u"}}})), `[{"type":"other","value":[{"url":"u"}]}]`)
}

// A `sleep` item as codex emitted it after "sleep 100" (#83): it ended after 7.5 s of its 50 s when a steer arrived.
func TestASleepItemIsASleepToolCallWithItsRequestedDurationAsInputAndNoReportedResult(t *testing.T) {
	item := jsonx.Record{"type": "sleep", "id": "call_rorJ", "durationMs": 50_000}
	started, commands := fold(t, initialCodexProjection("thread-1", methodThreadStart), "item/started", jsonx.Record{"threadId": "thread-1", "item": item, "startedAtMs": 1_791_015_508_662})
	sameJSON(t, commands[0].Body.Events, `[{"kind":"tool_call_started","callId":"call_rorJ","tool":"sleep","input":"{\"durationMs\":50000}"}]`)
	_, ended := fold(t, started, "item/completed", jsonx.Record{"threadId": "thread-1", "item": item, "completedAtMs": 1_791_015_516_209})
	sameJSON(t, ended[0].Body.Events, `[{"kind":"tool_call_ended","callId":"call_rorJ"}]`)
}

// ─── tests/codex/codex-reasoning.test.ts ────────────────────────────────────

func TestReasoningDistinguishesReadableEncryptedEmptyAndUnrelatedItems(t *testing.T) {
	sameJSON(t, map[string]any{
		"readable":  codexReasoningContent(jsonx.Record{"type": "reasoning", "summary": []any{jsonx.Record{"type": "summary_text", "text": "Checked the bridge path."}}, "content": []any{}, "encrypted_content": "opaque-ciphertext"}),
		"redacted":  codexReasoningContent(jsonx.Record{"type": "reasoning", "summary": []any{}, "encrypted_content": "opaque-ciphertext"}),
		"empty":     codexReasoningContent(jsonx.Record{"type": "reasoning", "summary": []any{}, "content": []any{}, "encrypted_content": nil}),
		"unrelated": codexReasoningContent(jsonx.Record{"type": "message"}),
	}, `{"empty":{"kind":"empty"},"readable":{"kind":"text","text":"Checked the bridge path."},"redacted":{"kind":"redacted"},"unrelated":null}`)
}

// ─── codex parts of tests/*.test.ts ─────────────────────────────────────────

// app-request-cancelled.test.ts
func TestServerRequestResolvedReadsAsAppRequestCancelledItsNumericIDAsTheRecordedString(t *testing.T) {
	_, commands := fold(t, initialCodexProjection("thread-1", methodThreadStart), "serverRequest/resolved", jsonx.Record{"threadId": "thread-1", "requestId": 7})
	sameJSON(t, frameEvents(commands), `[{"kind":"app_request_cancelled","requestId":"7"}]`)
}

// native-turn-active.test.ts
func TestNativeActivityAdoptsATurnWithoutFabricatingAControlRequest(t *testing.T) {
	_, commands := fold(t, initialCodexProjection("root", methodThreadStart), "turn/started", jsonx.Record{"threadId": "root", "turn": jsonx.Record{"id": "native-turn"}})
	k := kernel.New("root")
	record := k.Frame(commands[0].Body, kernel.RecordAt{})
	status := observe.StatusOf(k.Records(), "root").Value
	if status.Kind != "running" || status.SinceSeq != record.Seq || status.RequestID != "" {
		t.Fatalf("status %+v", status)
	}
	view := observe.ViewOf(k.Records(), "")
	if len(view.Messages) != 1 || view.Messages[0].Kind != "turn" || view.Messages[0].OpenedBy != "" {
		t.Fatalf("messages %s", jsonOf(t, view.Messages))
	}
	for _, event := range observe.EventsOf(record, nil) {
		if event.Kind() == "turn_started" {
			t.Fatal("a native start fabricated turn_started")
		}
	}
}

func TestNativeActivityPreservesAnExistingPromptPhaseAndTurnSegment(t *testing.T) {
	k := kernel.New("root")
	request := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "hi", InputID: "00000000-0000-4000-8000-000000000001"}, kernel.RecordAt{})
	k.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
	k.Frame(oar.FrameBody{Type: "item/started", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.ToolCallStarted{CallID: "call", Tool: "commandExecution"}}}, kernel.RecordAt{})
	before := observe.StatusOf(k.Records(), "root").Value
	_, commands := fold(t, initialCodexProjection("root", methodThreadStart), "turn/started", jsonx.Record{"threadId": "root", "turn": jsonx.Record{"id": "native-turn"}})
	k.Frame(commands[0].Body, kernel.RecordAt{})
	after := observe.StatusOf(k.Records(), "root").Value
	if after.SinceSeq != before.SinceSeq || after.RequestID != request.ID || after.Phase != before.Phase {
		t.Fatalf("before %+v after %+v", before, after)
	}
	turns := 0
	for _, message := range observe.ViewOf(k.Records(), "").Messages {
		if message.Kind == "turn" {
			turns++
		}
	}
	if turns != 1 {
		t.Fatalf("%d turns", turns)
	}
}

// tool-output-delta.test.ts (its codex half)
func TestSuccessiveNativeChunksAccumulateInLiveAndReplayViews(t *testing.T) {
	k := kernel.New("root")
	state := initialCodexProjection("root", methodThreadStart)
	push := func(method string, params jsonx.Record) {
		params["threadId"] = "root"
		next, commands := fold(t, state, method, params)
		state = next
		for _, command := range commands {
			if command.Kind == "frame" {
				k.Frame(command.Body, kernel.RecordAt{SessionID: command.SessionID, SpanID: command.SpanID})
			}
		}
	}
	push("item/started", jsonx.Record{"item": jsonx.Record{"id": "call", "type": "commandExecution", "command": "printf chunks"}})
	push("item/commandExecution/outputDelta", jsonx.Record{"itemId": "call", "delta": "first\n"})
	push("item/commandExecution/outputDelta", jsonx.Record{"itemId": "call", "delta": "second\n"})
	view := observe.ViewOf(k.Records(), "")
	var output *string
	for _, message := range view.Messages {
		for _, section := range message.Sections {
			for _, part := range section.Parts {
				if part.Kind == "tool" {
					output = part.Output
				}
			}
		}
	}
	if output == nil || *output != "first\nsecond\n" {
		t.Fatalf("output %v", output)
	}
	sameJSON(t, eventsOfKind(recordEvents(k.Records()), "tool_call_progress"), `[{"kind":"tool_call_progress","callId":"call","outputDelta":"first\n"},{"kind":"tool_call_progress","callId":"call","outputDelta":"second\n"}]`)
	// Replaying the last record twice must not append its output twice.
	records := k.Records()
	sameJSON(t, observe.ReduceSessionView(view, records[len(records)-1], "").Messages, jsonOf(t, view.Messages))
}

// ─── tests/replay/tool-activity.test.ts (its codex snapshots) ───────────────

// padEnd and slice in UTF-16 units, as JS strings measure them.
func padEnd16(text string, n int) string {
	if length := utf16Len(text); length < n {
		return text + strings.Repeat(" ", n-length)
	}
	return text
}

func slice16(text string, n int) string {
	units := 0
	for index, r := range text {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width > n {
			return text[:index]
		}
		units += width
	}
	return text
}

// The tool calls of the recorded fixtures as the codex projection hands them
// on, through ClassifyTool + ToolActionLabel, match the *.activity.txt
// snapshots (observe's own replay test reads the fixtures without the projection).
func TestRecordedToolCallsReadAsTheirFriendlyActivity(t *testing.T) {
	for _, scenario := range []string{"tool-round", "file-change", "mcp-echo"} {
		t.Run(scenario, func(t *testing.T) {
			state := initialCodexProjection(root, methodThreadStart)
			var rows []string
			for _, line := range fixtureLines(t, "codex-"+scenario+".raw.jsonl") {
				method, _ := jsonx.ParseRecord([]byte(line))["method"].(string)
				next, commands := foldCodexNotification(state, method, json.RawMessage(line))
				state = next
				if method != "item/started" {
					continue
				}
				for _, event := range frameEvents(commands) {
					started, ok := event.(oar.ToolCallStarted)
					if !ok {
						continue
					}
					action := observe.ClassifyTool("codex", started.Tool, started.Input)
					row := padEnd16(started.Tool, 20) + " │ " + observe.ToolActionLabel(action.Kind, "running")
					if action.Detail != "" {
						row += ": " + slice16(action.Detail, 40)
					}
					rows = append(rows, row)
				}
			}
			want, err := os.ReadFile(filepath.Join(replayFixtures, "codex-"+scenario+".activity.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(rows, "\n") + "\n"; got != string(want) {
				t.Fatalf("activity differs:\n%s", got)
			}
		})
	}
}
