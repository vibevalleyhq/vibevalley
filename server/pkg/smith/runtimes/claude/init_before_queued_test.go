//go:build wip_a

package claude

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-init-before-queued.test.ts: Lookout's
// 2026-10-10 Claude 2.1.292 + aimock recordings (issue #326). The second
// write followed task_notification by 20 ms (init first) or 0 ms (queued first).

const firstInputID = "6f1c2d3e-0001-4a5b-8c7d-000000000001"
const secondInputID = "6f1c2d3e-0002-4a5b-8c7d-000000000002"

func turnText(turn observe.ViewMessage) string {
	var text strings.Builder
	for _, section := range turn.Sections {
		for _, part := range section.Parts {
			if part.Kind == "text" {
				text.WriteString(part.Text)
			}
		}
	}
	return text.String()
}

// stepRecorded emits one recorded frame and checks the session recorded what
// the pure fold reads, the live view and the status folds agree.
func stepRecorded(t *testing.T, session oar.Session, sync *lineSync, live *liveView, frame map[string]any, want []oar.EventBody) oar.RawEvent {
	t.Helper()
	sync.emit(t, frame)
	records := session.Records()
	record := records[len(records)-1]
	if record.Kind != oar.KindFrame {
		t.Fatalf("last record is a %s", record.Kind)
	}
	sameJSON(t, nonNilEvents(record.Frame.Events), nonNilEvents(want))
	sameJSON(t, live.current(t, session), observe.ViewOf(session.Records(), ""))
	sameJSON(t, session.Status(), observe.StatusOf(session.Records(), session.ID()))
	return record
}

func TestRecordedNotificationAndPromptHaveSeparateTurns(t *testing.T) {
	for _, tc := range []struct {
		order      string
		writeAfter int
	}{{"init-first", 31}, {"queued-first", 31}, {"queued-first", 29}} {
		t.Run(fmt.Sprintf("%s/%d", tc.order, tc.writeAfter), func(t *testing.T) {
			fake := newFakeProcess(nil)
			session, sync := openScripted(t, fake, oar.SessionOptions{})
			live := watchView(session)
			projection := claudePrompted(initialClaudeProjection(), firstInputID, true)
			var run *promptRun
			promptSeq := int64(-1)
			prompt(t, session, "START-BG: start the background command", firstInputID)
			frames := replayFixture(t, "prompt-after-bg-task-"+tc.order, "raw")
			for index, message := range frames {
				var commands []projectionCommand
				projection, commands = foldClaudeStdout(projection, nativeOf(message))
				record := stepRecorded(t, session, sync, live, message, commandEvents(commands))
				if index == tc.writeAfter {
					projection = claudePrompted(projection, secondInputID, true)
					run = startPromptAndWait(t, session, "What is 2+2?", observe.PromptRunOptions{InputID: secondInputID})
					eventually(t, "the prompt answered", func() bool { return lastKind(session) == oar.KindResponse })
					request, ok := lastPromptRequest(session.Records())
					if !ok {
						t.Fatal("no prompt request")
					}
					promptSeq = request.Seq
				}
				if message["command_uuid"] == secondInputID && message["state"] == "queued" && tc.order == "init-first" {
					assertJSON(t, record.Frame.Events, `[{"kind":"input_queued","inputId":"`+secondInputID+`"},{"kind":"turn_active"}]`)
					assertJSON(t, pendingInputIDs(live.current(t, session)), `["`+secondInputID+`"]`)
					status := session.Status().Value
					if status.Kind != "running" || status.InputID != "" {
						t.Fatalf("status = %+v", status)
					}
				}
				if index == 45 {
					if end := observe.TurnEndAfter(session.Records(), promptSeq, session.ID(), secondInputID); end != nil {
						t.Fatalf("turn end = %v", *end)
					}
					matchJSON(t, session.Status().Value, `{"kind":"running","inputId":"`+secondInputID+`","phase":"waiting_model"}`)
					assertJSON(t, pendingInputIDs(live.current(t, session)), `["`+secondInputID+`"]`)
				}
			}
			if run == nil {
				t.Fatal("never prompted")
			}
			result := run.wait(t)
			if result.Kind != "ended" || result.Text != "4" || result.Outcome.Kind != "completed" {
				t.Fatalf("run = %+v", result)
			}
			assertJSON(t, turnEnd(t, session, promptSeq, secondInputID), `{"kind":"completed"}`)
			if session.Status().Value.Kind != "idle" {
				t.Fatal("not idle")
			}
			view := live.current(t, session)
			if len(view.PendingInputs) != 0 {
				t.Fatal("pending inputs remain")
			}
			turns := viewTurns(view)
			if len(turns) != 3 || turns[1].OpenedBy != "" || turns[2].OpenedBy == "" {
				t.Fatalf("turns = %d", len(turns))
			}
			assertJSON(t, []string{turnText(turns[1]), turnText(turns[2])}, `["The background command finished: bg-done.","4"]`)
			_, inputIndex := viewInput(view, secondInputID)
			if inputIndex <= messageIndex(view, turns[1].ID) || inputIndex >= messageIndex(view, turns[2].ID) {
				t.Fatalf("input at %d, turns at %d and %d", inputIndex, messageIndex(view, turns[1].ID), messageIndex(view, turns[2].ID))
			}
			assertJSON(t, eventsOfKind(recordEvents(session.Records()), "turn_active"),
				`[{"kind":"turn_active","inputId":"`+firstInputID+`"},{"kind":"turn_active"},{"kind":"turn_active","inputId":"`+secondInputID+`"}]`)
			saved, err := json.Marshal(session.Records())
			if err != nil {
				t.Fatal(err)
			}
			var restored []oar.RawEvent
			if err := json.Unmarshal(saved, &restored); err != nil {
				t.Fatal(err)
			}
			sameJSON(t, observe.ViewOf(restored, ""), view)
			sameJSON(t, frameNatives(session.Records()), recordsAsAny(frames))
			sameJSON(t, recordsAsAny(fake.writtenRecords()), recordsAsAny(replayFixture(t, "prompt-after-bg-task-"+tc.order, "stdin")))
		})
	}
}

func TestRepeatedFramesDoNotInventOrRepeatSpontaneousActivity(t *testing.T) {
	init := map[string]any{"type": "system", "subtype": "init"}
	queued := map[string]any{"type": "command_lifecycle", "command_uuid": firstInputID, "state": "queued"}
	started := withField(queued, "state", "started")
	result := map[string]any{"type": "result", "is_error": false}
	for _, tc := range []struct {
		name     string
		before   []map[string]any
		after    []map[string]any
		prompted bool
		active   string
	}{
		{"repeated init and queued", nil, []map[string]any{init, init, queued, queued, init}, true, `[{"kind":"turn_active"}]`},
		{"started already owns the init", nil, []map[string]any{started, init, queued}, true, `[{"kind":"turn_active","inputId":"` + firstInputID + `"}]`},
		{"started claims the init before queued", nil, []map[string]any{init, started, queued}, true, `[{"kind":"turn_active","inputId":"` + firstInputID + `"}]`},
		{"a child init is not root activity", nil, []map[string]any{withField(init, "parent_tool_use_id", "child"), queued}, true, `[]`},
		{"a child result does not end the root init", nil, []map[string]any{init, withField(result, "parent_tool_use_id", "child"), queued}, true, `[{"kind":"turn_active"}]`},
		{"unrelated queue receipts do not consume the init", nil, []map[string]any{init, withField(queued, "command_uuid", secondInputID), queued}, true, `[{"kind":"turn_active"}]`},
		{"the init predates this write", []map[string]any{init}, []map[string]any{queued, init}, true, `[]`},
		{"the init's turn already ended", nil, []map[string]any{init, result, queued}, true, `[]`},
		{"an idle queue already reported a spontaneous turn", nil, []map[string]any{init, queued, init}, false, `[{"kind":"turn_active"}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := initialClaudeProjection()
			for _, message := range tc.before {
				state, _ = fold(state, message)
			}
			state = claudePrompted(state, firstInputID, tc.prompted)
			events := []oar.EventBody{}
			for _, message := range tc.after {
				var commands []projectionCommand
				state, commands = fold(state, message)
				events = append(events, commandEvents(commands)...)
			}
			assertJSON(t, eventsOfKind(events, "turn_active"), tc.active)
		})
	}
}

func TestCancellingThePendingPromptLeavesTheRecoveredNotificationTurnBusy(t *testing.T) {
	fake := newFakeProcess(nil)
	session, sync := openScripted(t, fake, oar.SessionOptions{})
	started := prompt(t, session, "What is 2+2?", firstInputID)
	queued := map[string]any{"type": "command_lifecycle", "command_uuid": firstInputID, "state": "queued"}
	sync.emit(t, map[string]any{"type": "system", "subtype": "init"}, queued, withField(queued, "state", "cancelled"))
	assertJSON(t, turnEnd(t, session, started.Seq, firstInputID), `{"kind":"aborted"}`)
	if status := session.Status().Value; status.Kind != "running" || status.InputID != "" {
		t.Fatalf("status = %+v", status)
	}
	matchJSON(t, prompt(t, session, "too soon", ""), `{"Kind":"rejected","Code":"busy"}`)
	sync.emit(t, map[string]any{"type": "result", "is_error": false})
	if session.Status().Value.Kind != "idle" {
		t.Fatal("not idle")
	}
	if next := prompt(t, session, "next", ""); !next.IsAccepted() {
		t.Fatalf("next = %v", next.Code)
	}
}
