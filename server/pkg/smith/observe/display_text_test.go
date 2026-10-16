package observe

import (
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ported from tests/display-text.test.ts and the failureAdvice table of tests/failure-class.test.ts.

func dtInt(value int) *int       { return &value }
func dtInt64(value int64) *int64 { return &value }

func TestNoticeTextAndTone(t *testing.T) {
	for _, c := range []struct {
		notice ViewNotice
		text   string
		tone   NoticeTone
	}{
		{ViewNotice{Cause: "compaction_started"}, "Compacting context", "quiet"},
		{ViewNotice{Cause: "compaction_ended", CompactionOutcome: "completed"}, "Context compaction completed", "quiet"},
		{ViewNotice{Cause: "retry", Attempt: 1}, "Retrying (attempt 1)", "warning"},
		{ViewNotice{Cause: "retry", Attempt: 2, MaxAttempts: dtInt(5), DelayMs: dtInt64(1500), Reason: "overloaded"}, "Retrying (attempt 2 of 5, in 1.5s): overloaded", "warning"},
		{ViewNotice{Cause: "retry", Attempt: 1, DelayMs: dtInt64(0), Reason: ""}, "Retrying (attempt 1, in 0s)", "warning"},
		{ViewNotice{Cause: "control_rejected", Action: oar.ActionAbort, Reason: "No active turn"}, "Abort rejected: No active turn", "warning"},
		{ViewNotice{Cause: "child_turn_ended", Outcome: oar.Completed()}, "Subagent turn completed", "quiet"},
		{ViewNotice{Cause: "exited", Code: dtInt(0)}, "Runtime exited (code 0)", "quiet"},
		{ViewNotice{Cause: "exited", Code: dtInt(1)}, "Runtime exited (code 1)", "danger"},
		{ViewNotice{Cause: "exited"}, "Runtime exited", "warning"},
	} {
		if got := NoticeText(c.notice); got != c.text {
			t.Fatalf("%+v: text %q, want %q", c.notice, got, c.text)
		}
		if got := NoticeToneOf(c.notice); got != c.tone {
			t.Fatalf("%+v: tone %q, want %q", c.notice, got, c.tone)
		}
	}
}

var dtOutcomes = []struct {
	outcome oar.TurnOutcome
	text    string
	tone    NoticeTone
}{
	{oar.Completed(), "Subagent turn completed", "quiet"},
	{oar.AbortedOutcome(), "Subagent turn aborted", "warning"},
	{oar.Failed(oar.FailureProvider, "native failure\nwith details"), "Subagent turn failed: native failure\nwith details", "danger"},
}

func TestChildOutcomeNotice(t *testing.T) {
	for _, c := range dtOutcomes {
		notice := ViewNotice{Cause: "child_turn_ended", Outcome: c.outcome}
		if NoticeText(notice) != c.text || NoticeToneOf(notice) != c.tone {
			t.Fatalf("%s: %q %q", c.outcome.Kind, NoticeText(notice), NoticeToneOf(notice))
		}
	}
}

func TestCompactionOutcomeKeepsTriggerAndReason(t *testing.T) {
	want := map[string]struct {
		text string
		tone NoticeTone
	}{
		"completed": {"Context compaction completed (auto): native detail", "quiet"},
		"aborted":   {"Context compaction aborted (auto): native detail", "warning"},
		"failed":    {"Context compaction failed (auto): native detail", "danger"},
	}
	for _, c := range dtOutcomes {
		notice := ViewNotice{Cause: "compaction_ended", CompactionOutcome: c.outcome.Kind, Trigger: "auto", Reason: "native detail"}
		if NoticeText(notice) != want[c.outcome.Kind].text || NoticeToneOf(notice) != want[c.outcome.Kind].tone {
			t.Fatalf("%s: %q %q", c.outcome.Kind, NoticeText(notice), NoticeToneOf(notice))
		}
	}
}

func TestOptionalNoticeDetailsAddNoPunctuation(t *testing.T) {
	for notice, want := range map[*ViewNotice]string{
		{Cause: "compaction_started", Trigger: "manual"}:                                   "Compacting context: manual",
		{Cause: "compaction_started", Trigger: ""}:                                         "Compacting context",
		{Cause: "compaction_ended", CompactionOutcome: "aborted", Trigger: "", Reason: ""}: "Context compaction aborted",
	} {
		if got := NoticeText(*notice); got != want {
			t.Fatalf("%+v: %q", *notice, got)
		}
	}
}

func TestRejectedActionIsNamed(t *testing.T) {
	for action, want := range map[oar.ControlAction]string{
		oar.ActionPrompt: "Prompt rejected: native refusal", oar.ActionSteer: "Steer rejected: native refusal",
		oar.ActionQueue: "Queue rejected: native refusal", oar.ActionWithdraw: "Withdraw rejected: native refusal",
		oar.ActionAbort: "Abort rejected: native refusal", oar.ActionDispose: "Dispose rejected: native refusal",
	} {
		if got := NoticeText(ViewNotice{Cause: "control_rejected", Action: action, Reason: "native refusal"}); got != want {
			t.Fatalf("%s: %q", action, got)
		}
	}
}

func TestPhaseLabels(t *testing.T) {
	for phase, want := range map[oar.RunningPhase]string{
		oar.PhaseWaitingModel: "Waiting for model", oar.PhaseThinking: "Thinking", oar.PhaseResponding: "Responding", oar.PhaseCompacting: "Compacting context",
	} {
		if got := PhaseLabel(phase, ""); got != want {
			t.Fatalf("%s: %q", phase.Name, got)
		}
	}
	if got := PhaseLabel(oar.ToolPhase("mcp__server__lookup", "1"), ""); got != "Running mcp__server__lookup" {
		t.Fatal(got)
	}
}

// #314.
func TestPhaseLabelWithRuntime(t *testing.T) {
	writing := func(tool string) oar.RunningPhase {
		return oar.RunningPhase{Tool: tool, CallID: "1", Writing: true}
	}
	for _, c := range []struct {
		phase   oar.RunningPhase
		runtime string
		want    string
	}{
		{oar.ToolPhase("Edit", "1"), "claude", "Editing file"},
		{oar.ToolPhase("Bash", "1"), "claude", "Running command"},
		{oar.ToolPhase("mcp__ferry__show_widget", "1"), "claude", "Running show_widget"},
		{oar.ToolPhase("SomethingNew", "1"), "claude", "Running SomethingNew"},
		{writing("Write"), "claude", "Preparing file edit"},
		{writing("Bash"), "claude", "Preparing command"},
		{writing("mcp__ferry__show_widget"), "claude", "Writing show_widget arguments"},
		{writing("mcp__ferry__show_widget"), "", "Writing mcp__ferry__show_widget arguments"},
	} {
		if got := PhaseLabel(c.phase, c.runtime); got != c.want {
			t.Fatalf("%+v %s: %q, want %q", c.phase, c.runtime, got, c.want)
		}
	}
}

func TestFailureText(t *testing.T) {
	for failure, want := range map[oar.FailureClass]string{
		oar.FailureAuth:             "Claude Code could not authenticate.",
		oar.FailureQuota:            "Claude Code reported that its usage limit was reached.",
		oar.FailureRateLimited:      "Claude Code was rate limited by its provider.",
		oar.FailureBilling:          "Claude Code reported a billing or credit problem.",
		oar.FailureModelUnavailable: "Claude Code cannot use the selected model.",
		oar.FailureInputTooLarge:    "Claude Code reported that the input is too large for the model.",
		oar.FailureInvalidRequest:   "Claude Code rejected the request as invalid.",
		oar.FailureOverloaded:       "Claude Code reported that its provider is overloaded.",
		oar.FailureProvider:         "Claude Code reported a provider error.",
		oar.FailureRuntimeExited:    "Claude Code exited before the turn finished.",
		oar.FailureLimitReached:     "Claude Code stopped at the turn or budget limit set for it.",
		oar.FailureOutputSchema:     "Claude Code could not produce output matching the output schema.",
		oar.FailureUnknown:          "The turn failed.",
	} {
		if got := FailureText(failure, "Claude Code", ""); got != want {
			t.Fatalf("%s: %q", failure, got)
		}
	}
	if got := FailureText(oar.FailureAuth, "Pi", ""); got != "Pi could not authenticate." {
		t.Fatal(got)
	}
	// A rejected key is not a missing login (oar#227).
	if got := FailureText(oar.FailureAuth, "Pi", "missing"); got != "Pi is not signed in." {
		t.Fatal(got)
	}
	if got := FailureText(oar.FailureAuth, "Pi", "rejected"); got != "Pi's credentials were rejected." {
		t.Fatal(got)
	}
}

func TestTaskStatusLabel(t *testing.T) {
	for status, want := range map[string]string{"pending": "Pending", "running": "Running", "paused": "Paused", "completed": "Completed", "failed": "Failed", "stopped": "Stopped"} {
		if got := TaskStatusLabel(status); got != want {
			t.Fatalf("%s: %q", status, got)
		}
	}
}

func TestFailureAdviceOnePolicyPerClass(t *testing.T) {
	no, now, later := "no", "now", "later"
	for failure, want := range map[oar.FailureClass]FailureAdvice{
		oar.FailureAuth: {no, true}, oar.FailureBilling: {no, true}, oar.FailureModelUnavailable: {no, true}, oar.FailureInputTooLarge: {no, true},
		oar.FailureRateLimited: {now, false}, oar.FailureOverloaded: {now, false}, oar.FailureProvider: {now, false}, oar.FailureRuntimeExited: {now, false},
		oar.FailureQuota: {later, false}, oar.FailureInvalidRequest: {no, false}, oar.FailureLimitReached: {no, false},
		oar.FailureOutputSchema: {no, false}, oar.FailureUnknown: {no, false},
	} {
		got, ok := FailureAdviceOf(failure)
		if !ok || got != want {
			t.Fatalf("%s: %+v %v", failure, got, ok)
		}
	}
	if len(failureAdvice) != 13 {
		t.Fatalf("every failure class has exactly one policy: %d", len(failureAdvice))
	}
}
