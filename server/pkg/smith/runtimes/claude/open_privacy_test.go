//go:build wip_a

package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-open-privacy.test.ts.

// Native 2.1.295 shape from an isolated config home; account identity is synthetic.
func initializedFixture(t *testing.T) jsonx.Record {
	t.Helper()
	data, err := os.ReadFile("../../testdata/fixtures/claude-initialize-private.json")
	if err != nil {
		t.Fatal(err)
	}
	return jsonx.ParseRecord(data)
}

// Account data the SYNTHETIC get_usage answer carries beside the session totals (tests/fixtures/claude-usage.ts).
var privateUsageValues = []string{"oar-private-plan", "2026-10-09T20:00:00Z", "777777", "123456", "oar-private-agent"}

// savedModelUsage is the previous process's last running total: what get_usage answers on the resume.
func savedModelUsage(t *testing.T) any {
	t.Helper()
	var last any
	for _, frame := range readRecords(t, replayFixtures+"/claude-usage-subagent-compact.raw.jsonl") {
		if frame["type"] == "result" {
			last = frame["modelUsage"]
		}
	}
	return last
}

// getUsageAnswer is the SYNTHETIC get_usage control_response (schema 2.1.289).
func getUsageAnswer(requestID, modelUsage any) map[string]any {
	return map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response": map[string]any{
				"session":               map[string]any{"total_cost_usd": 0.055, "total_api_duration_ms": 1, "total_duration_ms": 1, "total_lines_added": 0, "total_lines_removed": 0, "model_usage": modelUsage},
				"subscription_type":     "oar-private-plan",
				"rate_limits_available": true,
				"rate_limits":           map[string]any{"five_hour": map[string]any{"utilization": 41, "resets_at": "2026-10-09T20:00:00Z"}, "extra_usage": map[string]any{"is_enabled": true, "monthly_limit": 777_777, "used_credits": 123_456, "utilization": 16}},
				"behaviors":             map[string]any{"day": map[string]any{"request_count": 3, "session_count": 1, "behaviors": []any{}, "agents": []any{map[string]any{"name": "oar-private-agent", "pct": 100}}, "skills": []any{}, "plugins": []any{}, "mcp_servers": []any{}}, "week": nil},
			},
		},
	}
}

func privateValues() []string {
	return append([]string{"oar-private-account@example.test", "oar-private-organization", "oar-private-plan", "oar-private-user", "654321"}, privateUsageValues...)
}

func privacyScript(t *testing.T, fastMode, effort string) *fakeProcess {
	initialized := initializedFixture(t)
	usage := savedModelUsage(t)
	fake := newFakeProcess(func(text string, child *fakeProcess) {
		request := jsonx.ParseRecord([]byte(text))
		method := jsonx.AsRecord(request["request"])["subtype"]
		if method == "get_usage" {
			child.emitJSON(getUsageAnswer(request["request_id"], usage))
			return
		}
		var response any = map[string]any{"applied": map[string]any{"effort": effort}}
		if method == "initialize" {
			copied := jsonx.Record{}
			for key, value := range initialized {
				copied[key] = value
			}
			copied["fast_mode_state"] = fastMode
			response = copied
		}
		child.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": request["request_id"], "response": response}})
	})
	useFakeSpawner(t, fake)
	return fake
}

func TestOpeningKeepsAccountDetailsOutOfRecordsAndReplay(t *testing.T) {
	for index, option := range []oar.SessionOptions{
		{Cwd: "/work", Resume: "old-id"},
		{Cwd: "/work", ServiceTier: "fast"},
		{Cwd: "/work", Resume: "old-id", ServiceTier: "fast", Effort: "low"},
	} {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			fake := privacyScript(t, "on", "low")
			ctx := testContext(t)
			session, err := Session(ctx, oar.AvailableInstallation{Via: "executable", Command: "claude"}, option)
			if err != nil {
				t.Fatal(err)
			}
			var mu sync.Mutex
			observed := []oar.RawEvent{}
			session.RawEvents(func(record oar.RawEvent) {
				mu.Lock()
				observed = append(observed, record)
				mu.Unlock()
			}, nil)
			sync := attachSync(fake)
			// A duplicate answer after opening must remain private, too.
			request := jsonx.ParseRecord([]byte(fake.writes()[0]))
			fake.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": request["request_id"], "response": initializedFixture(t)}})
			sync.wait(t)
			if len(session.Records()) != 0 {
				t.Fatalf("records = %d", len(session.Records()))
			}
			mu.Lock()
			if len(observed) != 0 {
				t.Fatalf("observed = %d", len(observed))
			}
			mu.Unlock()
			if session.ServiceTier().Value != nil {
				t.Fatalf("serviceTier = %v", *session.ServiceTier().Value)
			}
			if err := session.Dispose(ctx); err != nil {
				t.Fatal(err)
			}
			records, _ := json.Marshal(session.Records())
			eventually(t, "the exit observed", func() bool {
				mu.Lock()
				defer mu.Unlock()
				return len(observed) == len(session.Records())
			})
			mu.Lock()
			seen, _ := json.Marshal(observed)
			mu.Unlock()
			for _, value := range privateValues() {
				if strings.Contains(string(records), value) || strings.Contains(string(seen), value) {
					t.Fatalf("%s reached a record", value)
				}
			}
		})
	}
}

func TestAnOpeningMismatchNeverExposesPrivateInitializationInItsError(t *testing.T) {
	for index, option := range []oar.SessionOptions{
		{Cwd: "/work", ServiceTier: "fast"},
		{Cwd: "/work", Resume: "old-id", ServiceTier: "fast"},
		{Cwd: "/work", Resume: "old-id", Effort: "low"},
	} {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			fake := privacyScript(t, "off", "high")
			_, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: "claude"}, option)
			if err == nil {
				t.Fatal("the open succeeded")
			}
			encoded, _ := json.Marshal(err)
			for _, value := range privateValues() {
				if strings.Contains(fmt.Sprintf("%+v %#v", err, err), value) || strings.Contains(string(encoded), value) {
					t.Fatalf("%s reached the error: %v", value, err)
				}
			}
			if !fake.killed() {
				t.Fatal("claude was not stopped")
			}
		})
	}
}
