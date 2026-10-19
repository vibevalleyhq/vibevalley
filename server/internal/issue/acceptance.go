package issue

import (
	"context"
	"fmt"
	"strings"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// Accept judges what was handed back. Only an issue in review has something to judge.
func (s *Service) Accept(ctx context.Context, id string, req protocol.IssueAcceptRequest) (protocol.Issue, error) {
	t, err := s.Get(id)
	if err != nil {
		return t, err
	}
	if why := acceptRefusal(t); why != "" {
		return t, protocol.Refused{Reason: why}
	}
	if req.Pass {
		if err := s.issues.judged(id, clock.NowMs(), pulled(t.Findings)); err != nil {
			return t, err
		}
		return s.Get(id)
	}
	newFindings := []string{}
	for _, f := range req.Findings {
		if f = str.Trim(f); f != "" {
			newFindings = append(newFindings, f)
		}
	}
	text := str.Trim(req.Text)
	if len(newFindings) == 0 && text == "" {
		return t, protocol.Refused{Reason: "没过验收要说哪里不行：至少写一条意见"}
	}
	findings := t.Findings
	at := clock.NowMs()
	for _, f := range newFindings {
		findings = append(findings, protocol.Finding{ID: base.NewID(), Text: f, At: at})
	}
	if err := s.issues.judged(id, 0, findings); err != nil {
		return t, err
	}
	// The findings go to whoever works it as the next round's words, like any comment.
	if err := s.Comment(id, protocol.CommentRequest{Text: failedText(findings, text)}); err != nil {
		return t, err
	}
	return s.Get(id)
}

func acceptRefusal(t protocol.Issue) string {
	switch {
	case protocol.IsForManager(t):
		return "这是派给管家的工单：管家答完就关"
	case t.Graph != nil || t.Task != nil:
		return "这是种植计划的工单，跟着计划走：在计划里验收"
	case t.Status != protocol.IssueStatusInReview:
		return "还没交回来，没有东西可验收"
	}
	return ""
}

func pulled(findings []protocol.Finding) []protocol.Finding {
	out := make([]protocol.Finding, len(findings))
	for i, f := range findings {
		f.Pulled = true
		out[i] = f
	}
	return out
}

// The findings still standing, numbered, then the owner's own words.
func failedText(findings []protocol.Finding, text string) string {
	var b strings.Builder
	b.WriteString("验收没过，这几处要修：")
	n := 0
	for _, f := range findings {
		if f.Pulled {
			continue
		}
		n++
		fmt.Fprintf(&b, "\n%d. %s", n, f.Text)
	}
	if text != "" {
		b.WriteString("\n\n" + text)
	}
	b.WriteString("\n\n修好以后在结论里逐条说怎么修的。")
	return b.String()
}

// at 0 is not accepted (a fail, or another round started); the findings are written as they stand.
func (is *issues) judged(id string, at int64, findings []protocol.Finding) error {
	params := generated.AcceptIssueParams{ID: id, Findings: issueJSON(findings, len(findings) > 0)}
	if at > 0 {
		params.AcceptedAt = issueAt(at)
	}
	if err := is.q.AcceptIssue(context.Background(), params); err != nil {
		return err
	}
	is.publish(id)
	return nil
}

// Another round starts on what was judged: a pass no longer stands; the findings stay until a pass pulls them.
func (is *issues) unaccept(id string) error {
	t, err := is.Get(id)
	if err != nil || t.AcceptedAt == nil {
		return err
	}
	return is.judged(id, 0, t.Findings)
}

// What the session waits on the owner for, from its report; a report with none, or a comment, clears them.
func (is *issues) asked(id string, asks []string) error {
	var value []string
	for _, a := range asks {
		if a = str.Trim(a); a != "" {
			value = append(value, a)
		}
	}
	if err := is.q.SetIssueAsks(context.Background(), generated.SetIssueAsksParams{ID: id, Asks: issueJSON(value, len(value) > 0)}); err != nil {
		return err
	}
	is.publish(id)
	return nil
}
