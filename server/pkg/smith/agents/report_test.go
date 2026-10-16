package agents

import (
	"reflect"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ported from tests/subagent-report.test.ts.

var reportOutcomes = []oar.TurnOutcome{
	oar.Completed(),
	oar.AbortedOutcome(),
	oar.Failed(oar.FailureProvider, "bad request; session fake (details)\nsecond line [brackets]\n"),
}

var baseReport = SubagentReport{
	ID: "reviewer-1", Name: "reviewer", Runtime: "claude", SessionID: "session-1", Turn: 2,
	Outcome: oar.Completed(), Text: "  Findings\n\n[with brackets]\n; session body-text]\n", EndedAt: 0,
}

func TestParseReportReadsHeaderAndPreservesBody(t *testing.T) {
	got := ParseReport("[subagent reviewer-1 (reviewer) on claude, turn 2: completed; session session-1]\n  Findings\n\n[with brackets]\n")
	want := &ParsedReport{Body: "  Findings\n\n[with brackets]\n", ID: "reviewer-1", Name: "reviewer", Outcome: ReportOutcome{Kind: "completed"}, Runtime: "claude", SessionID: "session-1", Turn: 2}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestFormatParseRoundTrip(t *testing.T) {
	for _, outcome := range reportOutcomes {
		t.Run(outcome.Kind, func(t *testing.T) {
			original := baseReport
			original.Outcome = outcome
			formatted := FormatReport(original)
			parsed := ParseReport(formatted)
			if parsed == nil {
				t.Fatal(formatted)
			}
			wantOutcome := ReportOutcome{Kind: outcome.Kind}
			if outcome.Kind == "failed" {
				wantOutcome.Reason = outcome.Reason
			}
			want := ParsedReport{ID: original.ID, Name: original.Name, Runtime: original.Runtime, SessionID: original.SessionID, Turn: original.Turn, Body: original.Text, Outcome: wantOutcome}
			if !reflect.DeepEqual(*parsed, want) {
				t.Fatalf("got %+v\nwant %+v", *parsed, want)
			}
			restored := SubagentReport{ID: parsed.ID, Name: parsed.Name, Runtime: parsed.Runtime, SessionID: parsed.SessionID, Turn: parsed.Turn, Text: parsed.Body, Outcome: oar.TurnOutcome{Kind: parsed.Outcome.Kind}}
			if parsed.Outcome.Kind == "failed" {
				restored.Outcome = oar.Failed(oar.FailureUnknown, parsed.Outcome.Reason)
			}
			if got := FormatReport(restored); got != formatted {
				t.Fatalf("got %q\nwant %q", got, formatted)
			}
		})
	}
}

func TestEmptyReasonAndBodyPreserved(t *testing.T) {
	report := baseReport
	report.Name = report.ID
	report.Outcome = oar.Failed(oar.FailureAuth, "")
	report.Text = ""
	got := ParseReport(FormatReport(report))
	want := &ParsedReport{Body: "", ID: "reviewer-1", Outcome: ReportOutcome{Kind: "failed", Reason: ""}, Runtime: "claude", SessionID: "session-1", Turn: 2}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	if encoded, _ := got.Outcome.MarshalJSON(); string(encoded) != `{"kind":"failed","reason":""}` {
		t.Fatalf("outcome = %s", encoded)
	}
}

func TestQuotedReportInBodyIsNotTheHeader(t *testing.T) {
	failed := baseReport
	failed.Outcome = reportOutcomes[2]
	body := FormatReport(baseReport) + "\n" + FormatReport(failed)
	outer := baseReport
	outer.Text = body
	if got := ParseReport(FormatReport(outer)); got == nil || got.Body != body {
		t.Fatalf("got %+v", got)
	}
}

func TestNamesWithSpacesParenthesesUnicodeSurvive(t *testing.T) {
	named := baseReport
	named.Name = "Review (中文) with spaces"
	if got := ParseReport(FormatReport(named)); got == nil || got.Name != named.Name {
		t.Fatalf("got %+v", got)
	}
}

func TestAmbiguousParenthesizedIDFollowsLegacyConvention(t *testing.T) {
	unnamed := baseReport
	unnamed.Name = ""
	unnamed.ID = "x (y)"
	unnamed.Text = ""
	got := ParseReport(FormatReport(unnamed))
	want := &ParsedReport{Body: "", ID: "x", Name: "y", Outcome: ReportOutcome{Kind: "completed"}, Runtime: "claude", SessionID: "session-1", Turn: 2}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestNonReportIsRefused(t *testing.T) {
	for _, text := range []string{
		"ordinary text", "", "[subagent x on claude, turn 1: completed; session s]", "prefix\n[subagent x on claude, turn 1: completed; session s]\nbody",
		"[subagent x on claude, turn 0: completed; session s]\nbody", "[subagent x on claude, turn -1: completed; session s]\nbody",
		"[subagent x on claude, turn 01: completed; session s]\nbody", "[subagent x on claude, turn 9007199254740992: completed; session s]\nbody",
		"[subagent x on claude, turn 1: stopped; session s]\nbody", "[subagent x on claude, turn 1: failed; session s]\nbody",
		"[subagent x on claude, turn 1: completed extra; session s]\nbody", "[subagent x on claude, turn 1: completed; session has space]\nbody",
	} {
		if got := ParseReport(text); got != nil {
			t.Fatalf("ParseReport(%q) = %+v", text, got)
		}
	}
}

func TestReportOrigin(t *testing.T) {
	if got := ReportOrigin(baseReport); got != (oar.InputOrigin{Kind: "notification", Source: "subagent:reviewer-1"}) {
		t.Fatalf("got %+v", got)
	}
}
