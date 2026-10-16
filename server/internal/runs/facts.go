package runs

import (
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strings"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// A helper's session, read for the farm (ported from the TypeScript server's session-facts.ts, removed): one smith event in (a turn began, it ran
// a command, said something, spent tokens, its process exited…), what follows out: the facts to apply to the core
// state, the steps for its detail panel, what it spent, the model whose price to look up. Pure: it reads the helper
// as the core state has it and the session's own bookkeeping (crewTracking), and returns the next bookkeeping;
// crew.go does what it says.

// crewLabelMax: the bubble over a helper's head holds about this much.
const crewLabelMax = 40

// crewShownCall is the tool call the bubble shows, so a later full input can fix up its label.
type crewShownCall struct{ ID, Tool string }

// crewTracking is what the server keeps about an open session to read its next event.
type crewTracking struct {
	ShownCall *crewShownCall
	// SessionTokens is the session's running token total, as last reported: the next report is counted from it.
	SessionTokens *oar.TokenTotals
	// Price is the model's, once the session has said which model it runs.
	Price *base.Price
	// TurnFrom is what it had spent when the current turn began.
	TurnFrom *protocol.Spent
	// Quiet: a quiet spell was flagged; the next word from it ends it.
	Quiet bool
}

type crewSessionContext struct {
	// ID is the helper's.
	ID      string
	Runtime string
	// Cwd is where it works: paths and commands are shown from here.
	Cwd       string
	CnyPerUsd float64
}

// crewOp is one thing to write down in a journal, as data (steps.ts's JournalOp): Type names the Journal method.
type crewOp struct {
	Type   string // asked, said, thought, toolStarted, toolInput, toolEnded, note
	Text   string
	CallID string
	Start  base.ToolStart
	Input  string
	Output string
	Ok     bool
	Kind   protocol.StepKind
	From   base.From
}

// crewRecord writes op down in j.
func crewRecord(j base.Journal, op crewOp) {
	switch op.Type {
	case "asked":
		j.Asked(op.Text, op.From)
	case "said":
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

// crewReaction is what one event means for the farm.
type crewReaction struct {
	Tracking crewTracking
	Facts    []protocol.FactValue
	Journal  []crewOp
	// SpentCny is yuan this event spent on the helper's runtime.
	SpentCny float64
	// Model: the session said which model it runs; its price is to be looked up.
	Model string
	// Warn is said on the farm as a warning.
	Warn string
}

var crewActions = map[observe.ToolActionKind]protocol.ToolAction{
	observe.ToolRunCommand: protocol.ToolActionRunCommand,
	observe.ToolReadFile:   protocol.ToolActionReadFile,
	observe.ToolEditFile:   protocol.ToolActionEditFile,
	observe.ToolSearch:     protocol.ToolActionSearch,
	observe.ToolWeb:        protocol.ToolActionWeb,
	observe.ToolFetch:      protocol.ToolActionWeb,
	observe.ToolMCP:        protocol.ToolActionMCP,
	observe.ToolWait:       protocol.ToolActionWait,
}

func crewOr(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// crewDollars is dollars for some tokens at a model's price (per million); input counts cache reads and writes too.
func crewDollars(t oar.TokenTotals, p base.Price) float64 {
	cacheRead, cacheWrite := float64(crewOr(t.CacheRead)), float64(crewOr(t.CacheWrite))
	return (math.Max(0, float64(t.Input)-cacheRead-cacheWrite)*p.Input + float64(t.Output)*p.Output + cacheRead*p.CacheRead + cacheWrite*p.CacheWrite) / 1_000_000
}

// crewSince is what was spent from `from` to `now`; nil when there is no start to count from.
func crewSince(now protocol.Spent, from *protocol.Spent) *protocol.Spent {
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

// crewNear is a path or command the helper names, shown from its own directory: the bubble has no room for the rest.
// A command that starts by going there (`cd <worktree> && pnpm test`) is shown as what it runs.
func crewNear(cwd, detail string) string {
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

func crewToolOutput(content []oar.ToolOutputPart) string {
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

// crewSessionFacts is what one event of a helper's session means: helper is the helper as the core state has it now
// (nil: not on the farm).
func crewSessionFacts(event oar.Event, helper *protocol.Helper, tracking crewTracking, ctx crewSessionContext) crewReaction {
	id := ctx.ID
	var facts []protocol.FactValue
	var journal []crewOp
	next := tracking
	r := crewReaction{}
	var working *protocol.PhaseWorking
	if helper != nil {
		if p, ok := helper.Phase.Value.(protocol.PhaseWorking); ok {
			working = &p
		}
	}

	// doing is what it is doing now, changed: a fact only when something changed (the bubble says so).
	doing := func(action protocol.WorkerAction, label string) {
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
		if helper != nil && helper.Spent != nil {
			from = *helper.Spent
		}
		next.TurnFrom = &from
		// A prompt-mode persona and what the turn is reminded of ride on top of the input: the panel shows the job
		// itself, then what was recalled.
		asked := e.Input
		if at := strings.LastIndex(e.Input, JobBreak); at >= 0 {
			asked = e.Input[at+len(JobBreak):]
		}
		journal = append(journal, crewOp{Type: "asked", Text: asked})
		if recalled := crewRecalledIn(e.Input); recalled != "" {
			journal = append(journal, crewOp{Type: "note", Kind: protocol.StepKindRecalled, Text: recalled})
		}
		facts = append(facts, protocol.FactTurn{ID: id})
	case oar.Reasoning:
		doing(protocol.WorkerActionThinking, "")
		if e.Content.Kind == "text" && e.Content.Text != "" {
			journal = append(journal, crewOp{Type: "thought", Text: e.Content.Text})
		}
	case oar.ToolCallStarted:
		action := observe.ClassifyTool(ctx.Runtime, e.Tool, e.Input)
		kind, ok := crewActions[action.Kind]
		if !ok {
			kind = protocol.ToolActionOther
		}
		detail := action.Detail
		if detail == "" {
			detail = e.Tool
		}
		label := crewNear(ctx.Cwd, detail)
		next.ShownCall = &crewShownCall{ID: e.CallID, Tool: e.Tool}
		start := base.ToolStart{Text: label, Action: kind, Tool: e.Tool}
		if e.Input != nil {
			start.Input = *e.Input
		}
		journal = append(journal, crewOp{Type: "toolStarted", CallID: e.CallID, Start: start})
		doing(protocol.WorkerAction(kind), crewClip(label, crewLabelMax))
	case oar.ToolCallInput:
		// The complete input arrives later on some runtimes (claude); it names the target better.
		detail := ""
		if tracking.ShownCall != nil && e.CallID == tracking.ShownCall.ID {
			input := e.Input
			if call := observe.ClassifyTool(ctx.Runtime, tracking.ShownCall.Tool, &input); call.Detail != "" {
				detail = crewNear(ctx.Cwd, call.Detail)
			}
		}
		journal = append(journal, crewOp{Type: "toolInput", CallID: e.CallID, Input: e.Input, Text: detail})
		if detail != "" && helper != nil {
			action := protocol.DoingOf(*helper).Action
			if action != protocol.WorkerActionNone && action != protocol.WorkerActionThinking && action != protocol.WorkerActionSpeakingText {
				doing(action, crewClip(detail, crewLabelMax))
			}
		}
	case oar.ToolCallEnded:
		code := 0
		if e.ExitCode != nil && e.ExitCode.Valid {
			code = e.ExitCode.Int
		}
		journal = append(journal, crewOp{Type: "toolEnded", CallID: e.CallID, Output: crewToolOutput(e.Content), Ok: e.Result != "failed" && code == 0})
		if tracking.ShownCall != nil && e.CallID == tracking.ShownCall.ID {
			doing(protocol.WorkerActionThinking, "")
		}
	case oar.TextDelta:
		journal = append(journal, crewOp{Type: "said", Text: e.Text})
		doing(protocol.WorkerActionSpeakingText, "")
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
			text += "：" + crewClip(e.Reason, 160)
		}
		journal = append(journal, crewOp{Type: "note", Kind: protocol.StepKindRetry, Text: text})
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
		if tracking.SessionTokens != nil {
			last = *tracking.SessionTokens
		}
		cacheRead, cacheWrite := max(0, crewOr(tokens.CacheRead)-crewOr(last.CacheRead)), max(0, crewOr(tokens.CacheWrite)-crewOr(last.CacheWrite))
		delta := oar.TokenTotals{Input: max(0, tokens.Input-last.Input), Output: max(0, tokens.Output-last.Output), CacheRead: &cacheRead, CacheWrite: &cacheWrite}
		copied := *tokens
		next.SessionTokens = &copied
		if helper == nil {
			break
		}
		var cny *float64
		if tracking.Price != nil {
			v := crewDollars(delta, *tracking.Price) * ctx.CnyPerUsd
			cny = &v
		}
		before := protocol.Spent{}
		if helper.Spent != nil {
			before = *helper.Spent
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
			journal = append(journal, crewOp{Type: "note", Kind: protocol.StepKindProblem, Text: crewFailureText(e.Outcome)})
		}
	case oar.Exited:
		if helper != nil && protocol.IsBusy(*helper) {
			why := ctx.Runtime + " 进程退出了"
			if e.Code != nil {
				why += fmt.Sprintf("（退出码 %d）", *e.Code)
			}
			facts = append(facts, protocol.FactReport{ID: id, Outcome: protocol.OutcomeFailed, Summary: why, Turns: helper.Turns})
			r.Warn = helper.Name + " 的 " + why
		}
	}

	// A sub-agent's steps (a claude Task, a codex sub-thread) say whose they are: smith's AgentPath.
	if len(event.AgentPath) > 0 {
		for i := range journal {
			journal[i].From = base.From(event.AgentPath)
		}
	}
	r.Tracking, r.Facts, r.Journal = next, facts, journal
	return r
}
