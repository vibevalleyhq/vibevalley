//go:build wip_a

package claude

import (
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-duplicate-input.test.ts.

const duplicateInputID = "00000000-0000-4000-8000-000000000101"
const duplicateMessage = "claude ignored the input: its inputId was already used in this session"
const ignoredJSON = `{"kind":"failed","failure":"invalid_request","reason":"` + duplicateMessage + `"}`

func duplicateFrames() map[string]map[string]any {
	return map[string]map[string]any{
		"user":              {"type": "user", "uuid": duplicateInputID, "isReplay": true, "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "again"}}}},
		"command_lifecycle": {"type": "command_lifecycle", "command_uuid": duplicateInputID, "state": "completed"},
	}
}

var startedDuplicate = map[string]any{"type": "command_lifecycle", "command_uuid": duplicateInputID, "state": "started"}

func withField(frame map[string]any, key string, value any) map[string]any {
	copied := map[string]any{}
	for name, field := range frame {
		copied[name] = field
	}
	copied[key] = value
	return copied
}

func TestAnUnstartedRegisteredInputIgnoredByClaudeIsDropped(t *testing.T) {
	for name, native := range duplicateFrames() {
		t.Run(name, func(t *testing.T) {
			next, commands := fold(claudePrompted(initialClaudeProjection(), duplicateInputID, true), native)
			found := false
			for _, event := range commandEvents(commands) {
				if dropped, ok := event.(oar.InputDropped); ok && dropped == (oar.InputDropped{InputID: duplicateInputID, Reason: "runtime_refused", Failure: oar.FailureInvalidRequest, Message: duplicateMessage}) {
					found = true
				}
			}
			if !found {
				t.Fatalf("events = %v", commandEvents(commands))
			}
			if next.PromptInputs[duplicateInputID] || next.UnstartedInputs[duplicateInputID] || next.PromptInputID != "" || next.PendingInputID != "" || next.TurnActive {
				t.Fatalf("state = %+v", next)
			}
		})
	}
}

func TestUnregisteredChildQueuedAndStartedFramesNeverImplyADuplicate(t *testing.T) {
	for name, native := range duplicateFrames() {
		t.Run(name, func(t *testing.T) {
			registered := claudePrompted(initialClaudeProjection(), duplicateInputID, true)
			active, _ := fold(registered, startedDuplicate)
			queued, _ := fold(registered, withField(startedDuplicate, "state", "queued"))
			for _, pair := range []struct {
				state projectionState
				frame map[string]any
			}{{initialClaudeProjection(), native}, {queued, native}, {active, native}, {registered, withField(native, "parent_tool_use_id", "child")}} {
				_, commands := fold(pair.state, pair.frame)
				assertJSON(t, eventsOfKind(commandEvents(commands), "input_dropped"), `[]`)
			}
		})
	}
}

func TestAnIgnoredDuplicateResolvesBothWaitsAndFreesTheNextPrompt(t *testing.T) {
	for name, native := range duplicateFrames() {
		t.Run(name, func(t *testing.T) {
			// TS advances fake timers 20 s; Go shortens the abort fallback, the only timer that could kill.
			previous := abortFallbackTimeout
			abortFallbackTimeout = 100 * time.Millisecond
			t.Cleanup(func() { abortFallbackTimeout = previous })
			fake := newFakeProcess(nil)
			session, sync := openScripted(t, fake, oar.SessionOptions{})
			run := startPromptAndWait(t, session, "again", observe.PromptRunOptions{InputID: duplicateInputID, Timeout: time.Second})
			var seq int64 = -1
			eventually(t, "the prompt recorded", func() bool {
				request, ok := lastPromptRequest(session.Records())
				seq = request.Seq
				return ok
			})
			wait := startAwaitTurnEnd(t, session, seq, duplicateInputID)
			sync.emit(t, native)
			result := run.wait(t)
			if result.Kind != "ended" || result.Text != "" {
				t.Fatalf("run = %+v", result)
			}
			assertJSON(t, result.Outcome, ignoredJSON)
			assertJSON(t, wait.wait(t), ignoredJSON)
			if session.Status().Value.Kind != "idle" {
				t.Fatal("not idle")
			}
			for _, message := range observe.ViewOf(session.Records(), "").Messages {
				if message.Kind == "input" {
					matchJSON(t, message, `{"input":{"state":"dropped","reason":"runtime_refused"}}`)
					break
				}
			}
			time.Sleep(1300 * time.Millisecond)
			if fake.killed() {
				t.Fatal("claude was killed")
			}
			var kinds []any
			for _, write := range fake.writtenRecords() {
				kinds = append(kinds, write["type"])
			}
			assertJSON(t, kinds, `["user"]`)
			if next := prompt(t, session, "new id", ""); !next.IsAccepted() {
				t.Fatalf("next = %v", next.Code)
			}
		})
	}
}
