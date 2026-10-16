package grok

// Ported from tests/grok/grok-spontaneous-usage.test.ts: recorded grok wake
// scenarios replayed by the fake agent through grok's real profile.

import (
	"context"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

func TestRecordedScenariosCountRootWakesOnceWithoutGuessingChildInclusion(t *testing.T) {
	for _, c := range []struct {
		scenario      string
		input, output int64
		wakes         int
	}{
		{"foreground", 2810, 31, 0},
		{"background-child-first", 2820, 32, 2},
		{"background-parent-first", 2120, 25, 2},
	} {
		t.Run(c.scenario, func(t *testing.T) {
			session := startOn(t, overFixture(Profile), "")
			promptAndWait(t, session, "grok-"+c.scenario)
			promptAndWait(t, session, "grok-"+c.scenario)
			usage := map[string]any{"total": map[string]any{"input": c.input, "output": c.output, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0}}
			jsonEqual(t, session.Usage().Value, usage)
			records := session.Records()
			wakes := 0
			wakeEvents := 0
			for _, record := range records {
				if record.Kind != oar.KindFrame {
					continue
				}
				promptID, _ := jsonx.Get(jsonx.ParseRecord(record.Frame.Native), "update", "prompt_id").(string)
				if strings.HasPrefix(promptID, "subagent-completed-") {
					wakes++
					wakeEvents += len(record.Frame.Events)
				}
			}
			if wakes != c.wakes || wakeEvents != c.wakes/2 {
				t.Fatalf("wake frames %d (events %d), want %d (%d)", wakes, wakeEvents, c.wakes, c.wakes/2)
			}
			restored := persisted(t, records)
			jsonEqual(t, observe.UsageOf(restored, session.ID(), nil), session.Usage())
			jsonEqual(t, observe.ViewOf(restored, "").Usage, usage)
		})
	}
}

func TestHistoricalWakeReplayDuringOpenStaysNativeOnly(t *testing.T) {
	for _, method := range []string{"load", "resume"} {
		t.Run(method, func(t *testing.T) {
			session := startOn(t, overFixture(Profile, fixture, "grok-usage-"+method), "fake-session")
			var opened, historical *oar.RawEvent
			records := session.Records()
			for index := range records {
				record := &records[index]
				if record.Kind != oar.KindFrame {
					continue
				}
				if opened == nil && record.Frame.Type == "session/"+method {
					opened = record
				}
				if historical == nil && record.Frame.Type == "_x.ai/session_notification" {
					historical = record
				}
			}
			if opened == nil || historical == nil {
				t.Fatalf("opened %v historical %v", opened, historical)
			}
			jsonEqual(t, session.Usage().Value, map[string]any{"total": nil})
			if len(historical.Frame.Events) != 0 {
				t.Fatalf("events %v", historical.Frame.Events)
			}
			promptAndWait(t, session, "grok-background-parent-first")
			promptAndWait(t, session, "grok-background-parent-first")
			jsonEqual(t, session.Usage().Value, map[string]any{"total": map[string]any{"input": 2120, "output": 25, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0}})
			_ = session.Dispose(context.Background())
		})
	}
}
