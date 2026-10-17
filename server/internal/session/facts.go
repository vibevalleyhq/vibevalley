package session

import (
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/x/str"
)

// Pure: it reads the session as the core state has it and the session's own bookkeeping, and changes nothing.

// The bubble over a session's head holds about this much.
const labelMax = 40

// So a later full input can fix up the bubble's label.
type shownCall struct{ ID, Tool string }

type tracking struct {
	ShownCall *shownCall
	// The next report is counted from it.
	OarTokens *oar.TokenTotals
	Rate      *runtime.Rate
	RunFrom   *protocol.Spent
	// The next word from it ends the quiet spell.
	Quiet bool
}

type factContext struct {
	ID      string
	Runtime string
	Cwd     string
}

type op struct {
	Type   string // asked, said, thought, toolStarted, toolInput, toolEnded, note
	Text   string
	CallID string
	Start  ToolStart
	Input  string
	Output string
	Ok     bool
	Kind   protocol.SessionEventType
	From   From
}

func record(j Journal, op op) {
	switch op.Type {
	case "prompt":
		j.Asked(op.Text, op.From)
	case "response":
		j.Said(op.Text, op.From)
	case "thought":
		j.Thought(op.Text, op.From)
	case "toolStarted":
		j.ToolStarted(op.CallID, op.Start, op.From)
	case "toolInput":
		j.ToolInput(op.CallID, op.Input, op.Text, op.From)
	case "toolEnded":
		j.ToolEnded(op.CallID, op.Output, op.Ok, op.From)
	case "note":
		j.Note(op.Kind, op.Text, op.From)
	}
}

type reaction struct {
	Tracking tracking
	Facts    []protocol.FactValue
	Journal  []op
	SpentCny float64
	Model    string
	Warn     string
}

var actions = map[observe.ToolActionKind]protocol.ToolAction{
	observe.ToolRunCommand: protocol.ToolActionRunCommand,
	observe.ToolReadFile:   protocol.ToolActionReadFile,
	observe.ToolEditFile:   protocol.ToolActionEditFile,
	observe.ToolSearch:     protocol.ToolActionSearch,
	observe.ToolWeb:        protocol.ToolActionWeb,
	observe.ToolFetch:      protocol.ToolActionWeb,
	observe.ToolMCP:        protocol.ToolActionMCP,
	observe.ToolWait:       protocol.ToolActionWait,
}

func or(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func since(now protocol.Spent, from *protocol.Spent) *protocol.Spent {
	if from == nil {
		return nil
	}
	out := protocol.Spent{Tokens: now.Tokens - from.Tokens}
	if now.CNY != nil {
		cny := *now.CNY
		if from.CNY != nil {
			cny -= *from.CNY
		}
		out.CNY = &cny
	}
	return &out
}

// The bubble has no room for the rest: `cd <worktree> && pnpm test` is shown as what it runs.
func near(cwd, detail string) string {
	if strings.HasPrefix(detail, "/") && !strings.Contains(detail, " ") {
		rel, err := filepath.Rel(cwd, detail)
		if err != nil || strings.HasPrefix(rel, "..") {
			return detail
		}
		return rel
	}
	cd := regexp.MustCompile(`^cd ` + regexp.QuoteMeta(cwd) + `/? *(&&|;) *`)
	return strings.ReplaceAll(cd.ReplaceAllString(detail, ""), cwd+"/", "")
}

func toolOutput(content []oar.ToolOutputPart) string {
	var parts []string
	for _, part := range content {
		switch part.Type {
		case "text":
			if part.Text != "" {
				parts = append(parts, part.Text)
			}
		case "image":
			parts = append(parts, "[图片]")
		}
	}
	return strings.Join(parts, "\n")
}

func eventFacts(event oar.Event, session *protocol.Session, tracking tracking, ctx factContext) reaction {
	id := ctx.ID
	var facts []protocol.FactValue
	var journal []op
	next := tracking
	r := reaction{}
	var working *protocol.PhaseWorking
	if session != nil {
		if p, ok := session.Phase.Value.(protocol.PhaseWorking); ok {
			working = &p
		}
	}

	// A fact only when something changed.
	doing := func(action protocol.SessionAction, label string) {
		if working == nil || (working.Doing.Action == action && working.Doing.Label == label) {
			return
		}
		facts = append(facts, protocol.FactDoing{ID: id, Action: action, Label: label})
	}

	// Any word from it ends a quiet spell: the same doing again says so.
	if _, usage := event.Body.(oar.Usage); tracking.Quiet && !usage {
		next.Quiet = false
		if working != nil {
			facts = append(facts, protocol.FactDoing{ID: id, Action: working.Doing.Action, Label: working.Doing.Label})
		}
	}

	switch e := event.Body.(type) {
	case oar.TurnStarted:
		from := protocol.Spent{}
		if session != nil && session.Spent != nil {
			from = *session.Spent
		}
		next.RunFrom = &from
		// A prompt-mode persona and what the turn is reminded of ride on top of the input: the panel shows the job
		// itself, then what was recalled.
		asked := e.Input
		if at := strings.LastIndex(e.Input, JobBreak); at >= 0 {
			asked = e.Input[at+len(JobBreak):]
		}
		journal = append(journal, op{Type: "prompt", Text: asked})
		if recalled := recalledIn(e.Input); recalled != "" {
			journal = append(journal, op{Type: "note", Kind: protocol.SessionEventTypeMemoryRecalled, Text: recalled})
		}
		facts = append(facts, protocol.FactRun{ID: id})
	case oar.Reasoning:
		doing(protocol.SessionActionThinking, "")
		if e.Content.Kind == "text" && e.Content.Text != "" {
			journal = append(journal, op{Type: "thought", Text: e.Content.Text})
		}
	case oar.ToolCallStarted:
		action := observe.ClassifyTool(ctx.Runtime, e.Tool, e.Input)
		kind, ok := actions[action.Kind]
		if !ok {
			kind = protocol.ToolActionOther
		}
		detail := action.Detail
		if detail == "" {
			detail = e.Tool
		}
		label := near(ctx.Cwd, detail)
		next.ShownCall = &shownCall{ID: e.CallID, Tool: e.Tool}
		start := ToolStart{Text: label, Action: kind, Tool: e.Tool}
		if e.Input != nil {
			start.Input = *e.Input
		}
		journal = append(journal, op{Type: "toolStarted", CallID: e.CallID, Start: start})
		doing(protocol.SessionAction(kind), str.Clip(label, labelMax))
	case oar.ToolCallInput:
		// The complete input arrives later on some runtimes (claude); it names the target better.
		detail := ""
		if tracking.ShownCall != nil && e.CallID == tracking.ShownCall.ID {
			input := e.Input
			if call := observe.ClassifyTool(ctx.Runtime, tracking.ShownCall.Tool, &input); call.Detail != "" {
				detail = near(ctx.Cwd, call.Detail)
			}
		}
		journal = append(journal, op{Type: "toolInput", CallID: e.CallID, Input: e.Input, Text: detail})
		if detail != "" && session != nil {
			action := protocol.DoingOf(*session).Action
			if action != protocol.SessionActionNone && action != protocol.SessionActionThinking && action != protocol.SessionActionSpeakingText {
				doing(action, str.Clip(detail, labelMax))
			}
		}
	case oar.ToolCallEnded:
		code := 0
		if e.ExitCode != nil && e.ExitCode.Valid {
			code = e.ExitCode.Int
		}
		journal = append(journal, op{Type: "toolEnded", CallID: e.CallID, Output: toolOutput(e.Content), Ok: e.Result != "failed" && code == 0})
		if tracking.ShownCall != nil && e.CallID == tracking.ShownCall.ID {
			doing(protocol.SessionActionThinking, "")
		}
	case oar.TextDelta:
		journal = append(journal, op{Type: "response", Text: e.Text})
		doing(protocol.SessionActionSpeakingText, "")
	case oar.Retry:
		text := fmt.Sprintf("调用模型没成功，第 %d", e.Attempt)
		if e.MaxAttempts != nil && *e.MaxAttempts != 0 {
			text += fmt.Sprintf("/%d", *e.MaxAttempts)
		}
		text += " 次重试"
		if e.DelayMs != nil && *e.DelayMs != 0 {
			text += fmt.Sprintf("，%d 秒后", int64(math.Ceil(float64(*e.DelayMs)/1000)))
		}
		if e.Reason != "" {
			text += "：" + str.Clip(e.Reason, 160)
		}
		journal = append(journal, op{Type: "note", Kind: protocol.SessionEventTypeLLMRetry, Text: text})
		fact := protocol.FactRetry{ID: id, Attempt: int64(e.Attempt)}
		if e.MaxAttempts != nil && *e.MaxAttempts != 0 {
			of := int64(*e.MaxAttempts)
			fact.Of = &of
		}
		facts = append(facts, fact)
	case oar.Usage:
		// Counted from the session's last report, at its model's price.
		tokens := e.Usage.Tokens
		if tokens == nil {
			break
		}
		last := oar.TokenTotals{}
		if tracking.OarTokens != nil {
			last = *tracking.OarTokens
		}
		cacheRead, cacheWrite := max(0, or(tokens.CacheRead)-or(last.CacheRead)), max(0, or(tokens.CacheWrite)-or(last.CacheWrite))
		delta := oar.TokenTotals{Input: max(0, tokens.Input-last.Input), Output: max(0, tokens.Output-last.Output), CacheRead: &cacheRead, CacheWrite: &cacheWrite}
		copied := *tokens
		next.OarTokens = &copied
		if session == nil {
			break
		}
		var cny *float64
		if tracking.Rate != nil {
			v := tracking.Rate.Charge(delta)
			cny = &v
		}
		before := protocol.Spent{}
		if session.Spent != nil {
			before = *session.Spent
		}
		spent := protocol.Spent{Tokens: before.Tokens + delta.Input + delta.Output}
		if before.CNY != nil || cny != nil {
			total := 0.0
			if before.CNY != nil {
				total += *before.CNY
			}
			if cny != nil {
				total += *cny
			}
			spent.CNY = &total
		}
		facts = append(facts, protocol.FactSpent{ID: id, Spent: spent})
		if cny != nil && *cny != 0 {
			r.SpentCny = *cny
		}
	case oar.Model:
		r.Model = e.Model
	case oar.TurnEnded:
		if e.Outcome.Kind == "failed" {
			journal = append(journal, op{Type: "note", Kind: protocol.SessionEventTypeRunError, Text: failureText(e.Outcome)})
		}
	case oar.Exited:
		if session != nil && protocol.IsBusy(*session) {
			why := ctx.Runtime + " 进程退出了"
			if e.Code != nil {
				why += fmt.Sprintf("（退出码 %d）", *e.Code)
			}
			facts = append(facts, protocol.FactReport{ID: id, Outcome: protocol.OutcomeFailed, Summary: why, Runs: session.Runs})
			r.Warn = session.Name + " 的 " + why
		}
	}

	// A sub-agent's steps (a claude Task, a codex sub-thread) say whose they are: smith's AgentPath.
	if len(event.AgentPath) > 0 {
		for i := range journal {
			journal[i].From = From(event.AgentPath)
		}
	}
	r.Tracking, r.Facts, r.Journal = next, facts, journal
	return r
}
