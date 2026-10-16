package grok

// Ported from tests/grok/grok-spontaneous-usage-edges.test.ts: grok's
// independent root wake ledgers through the ACP recorder, token usage and a
// bare kernel.

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

const wakeMethod = "_x.ai/session_notification"

// wake is a root wake report, its update fields replaced by update's.
func wake(update map[string]any) map[string]any {
	fields := map[string]any{
		"sessionUpdate": "turn_completed", "prompt_id": "subagent-completed-child",
		"usage": map[string]any{"inputTokens": 10, "outputTokens": 1},
	}
	for key, value := range update {
		fields[key] = value
	}
	return map[string]any{"sessionId": "root", "_meta": map[string]any{"eventId": "root-20"}, "update": fields}
}

func with(base map[string]any, key string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	out[key] = value
	return out
}

func raw(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

type wakeRecording struct {
	kernel   *kernel.Kernel
	usage    *acp.TokenUsage
	recorder *acp.Recorder
}

func recording(opened bool) wakeRecording {
	usage := acp.NewTokenUsage(Profile)
	recorder := acp.NewRecorder(acp.NewUsageGate(), nil, usage)
	if opened {
		recorder.Step("session/new", json.RawMessage(`{}`))
	}
	return wakeRecording{kernel: kernel.New("root"), usage: usage, recorder: recorder}
}

func usageValue(records []oar.RawEvent) oar.SessionUsage {
	return observe.UsageOf(records, "root", nil).Value
}

func TestWakesThatStayNativeOnly(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]any
		method string
	}{
		{"ordinary prompt terminal (already billed by RPC)", wake(map[string]any{"prompt_id": "ordinary-prompt"}), ""},
		{"incomplete wake id", wake(map[string]any{"prompt_id": "subagent-completed-"}), ""},
		{"response instead of terminal", wake(map[string]any{"sessionUpdate": "response_completed"}), ""},
		{"input-only ledger", wake(map[string]any{"usage": map[string]any{"inputTokens": 10}}), ""},
		{"output-only ledger", wake(map[string]any{"usage": map[string]any{"outputTokens": 1}}), ""},
		{"explicit historical replay", with(wake(nil), "_meta", map[string]any{"eventId": "root-20", "isReplay": true}), ""},
		{"no ledger", wake(map[string]any{"usage": nil}), ""},
		{"no native report identity", with(wake(nil), "_meta", map[string]any{}), ""},
		{"empty native report identity", with(wake(nil), "_meta", map[string]any{"eventId": ""}), ""},
		{"child wake", with(wake(nil), "sessionId", "child"), ""},
		{"unknown owner", with(wake(nil), "sessionId", nil), ""},
		{"different vendor method", wake(nil), "_x.ai/queue/changed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := recording(true)
			r.recorder.Bind(r.kernel)
			method := c.method
			if method == "" {
				method = wakeMethod
			}
			r.recorder.Extension(method, raw(t, c.params), true)
			records := r.kernel.Records()
			if len(records) != 2 {
				t.Fatalf("%d records", len(records))
			}
			last := records[len(records)-1]
			jsonEqual(t, last.Frame.Native, c.params)
			if len(last.Frame.Events) != 0 {
				t.Fatalf("events %v", last.Frame.Events)
			}
			jsonEqual(t, usageValue(records), map[string]any{"total": nil})
		})
	}
}

func TestQueuedRootWakeBillsOnceChildCannotConsumeItsIdentityLaterRPCRetainsIt(t *testing.T) {
	r := recording(true)
	r.recorder.Extension(wakeMethod, raw(t, with(wake(nil), "sessionId", "child")), true)
	r.recorder.Extension(wakeMethod, raw(t, wake(nil)), true)
	r.recorder.Extension(wakeMethod, raw(t, wake(nil)), true)
	r.recorder.Bind(r.kernel)
	r.recorder.Extension(wakeMethod, raw(t, wake(nil)), true)
	jsonEqual(t, usageValue(r.kernel.Records()), map[string]any{"total": map[string]any{"input": 10, "output": 1}})
	event := r.usage.Prompt(jsonx.ParseRecord(raw(t, map[string]any{"_meta": map[string]any{"usage": map[string]any{"inputTokens": 100, "outputTokens": 2, "cachedReadTokens": 30, "cacheCreationTokens": 0}}})))
	var events []oar.EventBody
	if event != nil {
		events = append(events, event)
	}
	r.kernel.Frame(oar.FrameBody{Type: "session/prompt", Native: json.RawMessage("null"), Events: events}, kernel.RecordAt{})
	jsonEqual(t, usageValue(r.kernel.Records()), map[string]any{"total": map[string]any{"input": 110, "output": 3, "cacheRead": 30, "cacheWrite": 0}})
	if n := len(r.kernel.Records()); n != 6 {
		t.Fatalf("%d records", n)
	}
}

func TestANewNativeReportForAReusedWakePromptIDIsANewBillIncludingCacheParts(t *testing.T) {
	r := recording(true)
	r.recorder.Bind(r.kernel)
	r.recorder.Extension(wakeMethod, raw(t, wake(nil)), true)
	second := with(wake(map[string]any{"usage": map[string]any{"inputTokens": 20, "outputTokens": 2, "cachedReadTokens": 8, "cacheCreationTokens": 4}}), "_meta", map[string]any{"eventId": "root-40"})
	r.recorder.Extension(wakeMethod, raw(t, second), true)
	jsonEqual(t, usageValue(r.kernel.Records()), map[string]any{"total": map[string]any{"input": 30, "output": 3, "cacheRead": 8, "cacheWrite": 4}})
}

func TestAZeroLedgerIsAReportAndDuplicateTrackingIsScopedToTheOpenedSession(t *testing.T) {
	for range 2 {
		r := recording(true)
		r.recorder.Bind(r.kernel)
		r.recorder.Extension(wakeMethod, raw(t, wake(map[string]any{"usage": map[string]any{"inputTokens": 0, "outputTokens": 0, "cachedReadTokens": 0}})), true)
		jsonEqual(t, usageValue(r.kernel.Records()), map[string]any{"total": map[string]any{"input": 0, "output": 0, "cacheRead": 0}})
	}
}

func TestAMarkedReplayAfterOpeningCannotBecomeANewBillThroughAnUnmarkedDuplicate(t *testing.T) {
	r := recording(true)
	r.recorder.Bind(r.kernel)
	r.recorder.Extension(wakeMethod, raw(t, with(wake(nil), "_meta", map[string]any{"eventId": "root-20", "isReplay": true})), true)
	r.recorder.Extension(wakeMethod, raw(t, wake(nil)), true)
	jsonEqual(t, usageValue(r.kernel.Records()), map[string]any{"total": nil})
	for _, record := range r.kernel.Records()[1:] {
		if len(record.Frame.Events) != 0 {
			t.Fatalf("events %v", record.Frame.Events)
		}
	}
}

// TS drives createAcpOpening with whole wire messages and replays the SDK's
// delayed routing; the Go Opening answers each notification in wire order
// (opening.go), so the same wire is read through Outgoing / Response /
// Notification and the older notification is recorded after the answer step.
func TestTheOpenAnswerSeparatesOldAndNewBillsDespiteDelayedRouting(t *testing.T) {
	for _, openMethod := range []string{"session/new", "session/resume", "session/load"} {
		t.Run(openMethod, func(t *testing.T) {
			r := recording(false)
			opening := acp.NewOpening()
			history := wake(nil)
			fresh := with(wake(nil), "_meta", map[string]any{"eventId": "root-40"})
			opening.Outgoing("1", openMethod)
			historyAfterOpen := opening.Notification()
			opening.Response("1", true)
			freshAfterOpen := opening.Notification()
			// Routing can deliver the older notification after the answer callback.
			r.recorder.Step(openMethod, json.RawMessage(`{}`))
			r.recorder.Extension(wakeMethod, raw(t, history), historyAfterOpen)
			r.recorder.Extension(wakeMethod, raw(t, fresh), freshAfterOpen)
			r.recorder.Bind(r.kernel)
			records := r.kernel.Records()
			if records[1].Kind != oar.KindFrame || len(records[1].Frame.Events) != 0 {
				t.Fatalf("%+v", records[1])
			}
			jsonEqual(t, records[1].Frame.Native, history)
			jsonEqual(t, usageValue(records), map[string]any{"total": map[string]any{"input": 10, "output": 1}})
			r.recorder.Extension(wakeMethod, raw(t, wake(nil)), true)
			records = r.kernel.Records()
			last := records[len(records)-1]
			jsonEqual(t, last.Frame.Native, wake(nil))
			if len(last.Frame.Events) != 0 {
				t.Fatalf("events %v", last.Frame.Events)
			}
			jsonEqual(t, usageValue(records), map[string]any{"total": map[string]any{"input": 10, "output": 1}})
		})
	}
}
