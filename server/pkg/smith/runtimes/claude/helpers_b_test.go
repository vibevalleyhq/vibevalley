//go:build wip_b

package claude

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Go port of tests/fixtures/claude-usage.ts: claude's token frames for #282,
// real frames from claude 2.1.292 (haiku), with a SYNTHETIC get_usage answer.

func b_claudeFrames(t *testing.T, name string) []jsonx.Record {
	t.Helper()
	return readRecords(t, filepath.Join(replayFixtures, "claude-"+name+".raw.jsonl"))
}

func b_resultsOf(lines []jsonx.Record) []jsonx.Record {
	var out []jsonx.Record
	for _, frame := range lines {
		if frame["type"] == "result" {
			out = append(out, frame)
		}
	}
	return out
}

// b_savedModelUsage is the previous process's last running total: what get_usage answers on the resume.
func b_savedModelUsage(t *testing.T) any {
	results := b_resultsOf(b_claudeFrames(t, "usage-subagent-compact"))
	return results[len(results)-1]["modelUsage"]
}

// b_privateUsageValues is account data the SYNTHETIC get_usage answer carries beside the session totals.
var b_privateUsageValues = []string{"oar-private-plan", "2026-10-09T20:00:00Z", "777777", "123456", "oar-private-agent"}

// b_getUsageAnswer is the SYNTHETIC get_usage control_response (schema 2.1.289).
// modelUsage nil leaves model_usage out (TS undefined).
func b_getUsageAnswer(requestID any, modelUsage any) jsonx.Record {
	session := jsonx.Record{"total_cost_usd": 0.055, "total_api_duration_ms": 1, "total_duration_ms": 1, "total_lines_added": 0, "total_lines_removed": 0}
	if modelUsage != nil {
		session["model_usage"] = modelUsage
	}
	return jsonx.Record{
		"type": "control_response",
		"response": jsonx.Record{
			"subtype":    "success",
			"request_id": requestID,
			"response": jsonx.Record{
				"session":               session,
				"subscription_type":     "oar-private-plan",
				"rate_limits_available": true,
				"rate_limits": jsonx.Record{
					"five_hour":   jsonx.Record{"utilization": 41, "resets_at": "2026-10-09T20:00:00Z"},
					"extra_usage": jsonx.Record{"is_enabled": true, "monthly_limit": 777777, "used_credits": 123456, "utilization": 16},
				},
				"behaviors": jsonx.Record{"day": jsonx.Record{"request_count": 3, "session_count": 1, "behaviors": []any{}, "agents": []any{jsonx.Record{"name": "oar-private-agent", "pct": 100}}, "skills": []any{}, "plugins": []any{}, "mcp_servers": []any{}}, "week": nil},
			},
		},
	}
}

// b_normalized is a value through JSON, so records built in Go compare with parsed ones.
func b_normalized(value any) any {
	var out any
	_ = json.Unmarshal([]byte(jsonText(value)), &out)
	return out
}

func b_sameJSON(left, right any) bool {
	return reflect.DeepEqual(b_normalized(left), b_normalized(right))
}

// b_requestOf is a stdin write parsed.
func b_requestOf(text string) jsonx.Record { return jsonx.ParseRecord([]byte(strings.TrimSpace(text))) }

func b_subtypeOf(text string) any { return jsonx.AsRecord(b_requestOf(text)["request"])["subtype"] }

func b_controlSuccess(requestID any, response any) jsonx.Record {
	return jsonx.Record{"type": "control_response", "response": jsonx.Record{"subtype": "success", "request_id": requestID, "response": response}}
}

// b_lateLine delivers a stdout line after the exit (Node's exit event can
// precede the last data event): the registered line handlers, called directly.
func b_lateLine(f *fakeProcess, line string) {
	f.mu.Lock()
	handlers := append([]func(string){}, f.lineHandlers...)
	f.mu.Unlock()
	for _, handler := range handlers {
		handler(line)
	}
}

// b_shorten sets a package timer var for the test.
func b_shorten(t *testing.T, target *time.Duration, value time.Duration) {
	t.Helper()
	previous := *target
	*target = value
	t.Cleanup(func() { *target = previous })
}

func b_asReadbackError(t *testing.T, err error) *readbackError {
	t.Helper()
	var readback *readbackError
	if !errors.As(err, &readback) {
		t.Fatalf("error %T %v carries no native cause", err, err)
	}
	return readback
}

func b_readJSONFile(t *testing.T, file string) jsonx.Record {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return jsonx.ParseRecord(data)
}

func b_lastFrame(records []oar.RawEvent) *oar.RawEvent {
	for index := len(records) - 1; index >= 0; index-- {
		if records[index].Kind == oar.KindFrame {
			return &records[index]
		}
	}
	return nil
}
