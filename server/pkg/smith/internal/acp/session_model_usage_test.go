package acp_test

// Ported from tests/acp/acp-session-model-usage.test.ts.

import (
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

func modelOf(session oar.Session) string {
	if model := session.Model().Value; model != nil {
		return *model
	}
	return "<nil>"
}

// The read-back must be the runtime's word, never the request parameter.
func TestModelReadBackReportsTheEffectiveModel(t *testing.T) {
	requested := startSession(t, baseProfile(), startOptions{model: "requested-y"})
	if got := modelOf(requested); got != "fixture-model-x" {
		t.Fatal(got)
	}
	resumed := startSession(t, baseProfile(), startOptions{resume: "fake-session", model: "requested-y"})
	if got := modelOf(resumed); got != "fixture-model-x" {
		t.Fatal(got)
	}
}

func TestModelReadBackTakesGrokSetModelMeta(t *testing.T) {
	if got := modelOf(startSession(t, baseProfile(), startOptions{model: "grok-meta"})); got != "grok-applied" {
		t.Fatal(got)
	}
}

func TestModelReadBackSeesKimiUpdatePushedBeforeSetModelAnswers(t *testing.T) {
	session := startSession(t, baseProfile(), startOptions{model: "kimi-push"})
	if got := modelOf(session); got != "kimi-pushed" {
		t.Fatal(got)
	}
	opening := describeAll(session.Records())
	for _, line := range []string{"event session/new → model:fixture-model-x, effort:medium", "event config_option_update → model:kimi-pushed", "event session/set_model"} {
		if !contains(opening, line) {
			t.Fatalf("%q not in %q", line, opening)
		}
	}
	if indexOf(opening, "event config_option_update → model:kimi-pushed") < indexOf(opening, "event session/new → model:fixture-model-x, effort:medium") {
		t.Fatal("order")
	}
}

func TestModelReadBackFollowsConfigOptionUpdateDuringATurn(t *testing.T) {
	session := start(t, nil)
	if got := modelOf(session); got != "fixture-model-x" {
		t.Fatal(got)
	}
	if run := promptAndWait(t, session, "switch-model", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	if got := modelOf(session); got != "fixture-model-z" {
		t.Fatal(got)
	}
}

// tokensAtTurnEnded records contextUsage().tokens as read inside each
// turn_ended record. TS reads it in a synchronous observer; Go observers run
// on a delivery goroutine, so the fold is read off the records up to the
// turn-ended record instead.
func tokensAtTurnEnded(session oar.Session) func() []*int64 {
	var mu sync.Mutex
	var seen []*int64
	session.RawEvents(func(record oar.RawEvent) {
		if record.Kind != oar.KindFrame {
			return
		}
		for _, event := range record.Frame.Events {
			if _, ok := event.(oar.TurnEnded); ok {
				records := session.Records()
				usage := observe.ContextUsageOf(records[:record.Seq+1], session.ID()).Value
				mu.Lock()
				if usage == nil {
					seen = append(seen, nil)
				} else {
					seen = append(seen, usage.Tokens)
				}
				mu.Unlock()
			}
		}
	}, nil)
	return func() []*int64 {
		mu.Lock()
		defer mu.Unlock()
		return append([]*int64(nil), seen...)
	}
}

func completedTurn(t *testing.T, session oar.Session, input string) {
	run := promptAndWait(t, session, input, observe.PromptRunOptions{})
	if run.Kind != "ended" || run.Outcome.Kind != "completed" {
		t.Fatalf("run %+v", run)
	}
}

func ints(values []*int64) []any {
	out := []any{}
	for _, value := range values {
		if value == nil {
			out = append(out, nil)
		} else {
			out = append(out, *value)
		}
	}
	return out
}

func TestUsageUpdateAfterPromptRecordsThePostResponseUpdateBeforeTheTurnEnd(t *testing.T) {
	session := start(t, func(profile *acp.Profile) {
		profile.Args = acp.StaticArgs(fixture, "usage-after-response")
		profile.UsageUpdateAfterPrompt = true
	})
	atEnd := tokensAtTurnEnded(session)
	completedTurn(t, session, "one")
	completedTurn(t, session, "two")
	eventually(func() bool { return len(atEnd()) == 2 }, time.Second)
	jsonEqual(t, ints(atEnd()), []any{100, 200})
	jsonEqual(t, session.ContextUsage().Value, map[string]any{"tokens": 200, "contextWindow": 1000, "percent": 20})
}

func TestUsageUpdateAfterPromptRecordsTheAnswerOnceTheBoundPasses(t *testing.T) {
	session := start(t, func(profile *acp.Profile) {
		profile.Args = acp.StaticArgs(fixture, "usage-never")
		profile.UsageUpdateAfterPrompt = true
		profile.UsageUpdateTimeout = 100 * time.Millisecond
	})
	started := time.Now()
	if run := promptAndWait(t, session, "one", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	if elapsed := time.Since(started); elapsed < 90*time.Millisecond {
		t.Fatalf("the turn end should have waited for the bound, %v", elapsed)
	}
	if usage := session.ContextUsage().Value; usage != nil {
		t.Fatalf("usage %+v", usage)
	}
}

func TestProfilesWithoutUsageUpdateAfterPromptEndTheTurnOnTheAnswer(t *testing.T) {
	session := start(t, func(profile *acp.Profile) { profile.Args = acp.StaticArgs(fixture, "usage-after-response") })
	atEnd := tokensAtTurnEnded(session)
	if run := promptAndWait(t, session, "one", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	if usage := session.ContextUsage().Value; usage != nil {
		t.Fatalf("usage %+v", usage)
	}
	time.Sleep(150 * time.Millisecond)
	jsonEqual(t, session.ContextUsage().Value, map[string]any{"tokens": 100, "contextWindow": 1000, "percent": 10})
	if run := promptAndWait(t, session, "two", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	eventually(func() bool { return len(atEnd()) == 2 }, time.Second)
	jsonEqual(t, ints(atEnd()), []any{nil, 100})
}
