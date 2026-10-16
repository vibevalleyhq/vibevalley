package agents

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"vibevalley/pkg/smith/oar"
)

// Turning a subagent's report into input for a parent session
// (agents/report.ts). Pure: a host that only forwards reports can use it
// without loading a runtime.

// ReportOutcome is only the outcome information a report header encodes:
// Kind "completed" | "aborted" | "failed" (Reason); failure classes are not written there.
type ReportOutcome struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason,omitempty"`
}

func (o ReportOutcome) MarshalJSON() ([]byte, error) {
	if o.Kind == "failed" {
		return fmt.Appendf(nil, `{"kind":"failed","reason":%s}`, strconv.Quote(o.Reason)), nil
	}
	return fmt.Appendf(nil, `{"kind":%s}`, strconv.Quote(o.Kind)), nil
}

// ParsedReport is the fields FormatReport actually writes, without inventing
// a timestamp, log path or failure classification.
type ParsedReport struct {
	ID string `json:"id"`
	// "" when the header named none (an omitted name, including name == id, cannot be recovered).
	Name      string        `json:"name,omitempty"`
	Runtime   string        `json:"runtime"`
	Turn      int           `json:"turn"`
	Outcome   ReportOutcome `json:"outcome"`
	SessionID string        `json:"sessionId"`
	Body      string        `json:"body"`
}

func formatOutcome(outcome oar.TurnOutcome) string {
	switch outcome.Kind {
	case "completed":
		return "completed"
	case "aborted":
		return "aborted"
	case "failed":
		return "failed: " + outcome.Reason
	}
	panic(fmt.Sprintf("Unknown report outcome: %s", outcome.Kind))
}

// ReportOrigin is the origin to deliver a report with: a notification from that subagent.
func ReportOrigin(report SubagentReport) oar.InputOrigin {
	return oar.InputOrigin{Kind: "notification", Source: "subagent:" + report.ID}
}

// FormatReport is the report as parent input: a one-line header, then the text.
func FormatReport(report SubagentReport) string {
	outcome := formatOutcome(report.Outcome)
	who := report.ID
	if report.Name != "" && report.Name != report.ID {
		who = fmt.Sprintf("%s (%s)", report.ID, report.Name)
	}
	return fmt.Sprintf("[subagent %s on %s, turn %d: %s; session %s]\n%s", who, report.Runtime, report.Turn, outcome, report.SessionID, report.Text)
}

// jsSpace is JS's \s under the u flag; Go's \s is ASCII only.
const jsSpace = `\t\n\x0B\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

var (
	envelopePattern = regexp.MustCompile(`(?s)^\[subagent (.*?; session [^` + jsSpace + `\]]+)\]\n(.*)$`)
	fieldsPattern   = regexp.MustCompile(`(?s)^(.+?) on ([^` + jsSpace + `,]+), turn ([1-9][0-9]*): (.*)$`)
	namedPattern    = regexp.MustCompile(`(?s)^(.+?) \((.*)\)$`)
)

const maxSafeInteger = 1<<53 - 1

func parseOutcome(text string) (ReportOutcome, bool) {
	switch {
	case text == "completed":
		return ReportOutcome{Kind: "completed"}, true
	case text == "aborted":
		return ReportOutcome{Kind: "aborted"}, true
	case strings.HasPrefix(text, "failed: "):
		return ReportOutcome{Kind: "failed", Reason: strings.TrimPrefix(text, "failed: ")}, true
	}
	return ReportOutcome{}, false
}

// ParseReport reads FormatReport's text format, or nil for a non-report.
// Body and failed reason are preserved verbatim. Session ids contain no
// whitespace or closing bracket. The legacy header has no escaping: `x (y)`
// is id `x`, name `y`, even if the original id itself contained ` (y)`. An
// omitted name (including name == id) cannot be recovered.
func ParseReport(text string) *ParsedReport {
	// The first complete header ends before the body, even if the body quotes another report.
	envelope := envelopePattern.FindStringSubmatch(text)
	if envelope == nil {
		return nil
	}
	header, body := envelope[1], envelope[2]
	// Split from the right so semicolons, parentheses and '; session' in a reason survive.
	sessionAt := strings.LastIndex(header, "; session ")
	sessionID := header[sessionAt+len("; session "):]
	fields := fieldsPattern.FindStringSubmatch(header[:sessionAt])
	if fields == nil {
		return nil
	}
	who, runtime, turnText, outcomeText := fields[1], fields[2], fields[3], fields[4]
	turn, err := strconv.ParseInt(turnText, 10, 64)
	outcome, ok := parseOutcome(outcomeText)
	if err != nil || turn > maxSafeInteger || !ok {
		return nil
	}
	report := &ParsedReport{ID: who, Runtime: runtime, Turn: int(turn), Outcome: outcome, SessionID: sessionID, Body: body}
	if named := namedPattern.FindStringSubmatch(who); named != nil {
		report.ID, report.Name = named[1], named[2]
	}
	return report
}
