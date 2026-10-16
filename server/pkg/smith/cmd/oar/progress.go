package main

import (
	"fmt"
	"strings"
	"sync"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Rendering session events as progress lines (packages/cli/src/progress.ts):
// assistant text verbatim, everything else a bracketed meta line.

type openedSession struct {
	sessionID   string
	resumed     bool
	model       *string
	effort      *string
	serviceTier *string
}

// renderOpened is the first line: which session this run is, and what the runtime said it runs.
func renderOpened(opened openedSession) string {
	label := "session"
	if opened.resumed {
		label = "resumed"
	}
	parts := []string{label + " " + opened.sessionID}
	if opened.model != nil {
		parts = append(parts, "model "+*opened.model)
	}
	if opened.serviceTier != nil {
		parts = append(parts, "tier "+*opened.serviceTier)
	}
	if opened.effort != nil {
		parts = append(parts, "effort "+*opened.effort)
	}
	return "[" + strings.Join(parts, " · ") + "]"
}

func renderOutcome(outcome oar.TurnOutcome) string {
	switch outcome.Kind {
	case "completed":
		return "[turn completed]"
	case "aborted":
		return "[turn aborted]"
	}
	return fmt.Sprintf("[turn failed: %s] %s", outcome.Failure, outcome.Reason)
}

type startedCall struct {
	tool       string
	kind       observe.ToolActionKind
	detail     string
	receivedAt int64
}

// progressRenderer returns the printable lines for one event.
func progressRenderer(runtimeID string) func(oar.Event) []string {
	var mu sync.Mutex
	started := map[string]startedCall{}
	return func(event oar.Event) []string {
		mu.Lock()
		defer mu.Unlock()
		agent := ""
		if len(event.AgentPath) > 0 {
			agent = "[" + strings.Join(event.AgentPath, "/") + "] "
		}
		key := strings.Join(event.AgentPath, "/") + "|"
		switch e := event.Body.(type) {
		case oar.TextDelta:
			if e.Text == "" {
				return nil
			}
			return []string{agent + e.Text}
		case oar.Reasoning:
			if e.Content.Kind == "text" && e.Content.Text != "" {
				return []string{agent + "[thinking] " + e.Content.Text}
			}
			return nil
		case oar.ToolCallStarted:
			action := observe.ClassifyTool(runtimeID, e.Tool, e.Input)
			started[key+e.CallID] = startedCall{tool: e.Tool, kind: action.Kind, detail: action.Detail, receivedAt: event.ReceivedAt}
			label := observe.ToolActionLabel(action.Kind, "running")
			if action.Detail == "" {
				return []string{agent + "[" + label + "]"}
			}
			return []string{agent + "[" + label + "] " + action.Detail}
		case oar.ToolCallInput:
			call, ok := started[key+e.CallID]
			if !ok {
				return nil
			}
			input := e.Input
			action := observe.ClassifyTool(runtimeID, call.tool, &input)
			if action.Detail == "" || action.Detail == call.detail {
				return nil
			}
			call.detail = action.Detail
			started[key+e.CallID] = call
			return []string{agent + "[" + observe.ToolActionLabel(action.Kind, "running") + "] " + action.Detail}
		case oar.ToolCallEnded:
			call, ok := started[key+e.CallID]
			delete(started, key+e.CallID)
			if !ok {
				return []string{agent + "[" + observe.ToolActionLabel(observe.ToolOther, "done") + "]"}
			}
			seconds := float64(event.ReceivedAt-call.receivedAt) / 1000
			return []string{fmt.Sprintf("%s[%s] (%.1fs)", agent, observe.ToolActionLabel(call.kind, "done"), seconds)}
		case oar.TurnEnded:
			return []string{agent + renderOutcome(e.Outcome)}
		case oar.CompactionStarted:
			if e.Trigger == "" {
				return []string{agent + "[compacting]"}
			}
			return []string{agent + "[compacting: " + e.Trigger + "]"}
		case oar.CompactionEnded:
			if e.Outcome == "completed" {
				return []string{agent + "[compacted]"}
			}
			line := agent + "[compaction " + e.Outcome + "]"
			if e.Reason != "" {
				line += " " + e.Reason
			}
			return []string{line}
		case oar.Retry:
			line := fmt.Sprintf("%s[retry %d", agent, e.Attempt)
			if e.MaxAttempts != nil {
				line += fmt.Sprintf("/%d", *e.MaxAttempts)
			}
			line += "]"
			if e.Reason != "" {
				line += " " + e.Reason
			}
			return []string{line}
		case oar.AppRequest:
			return []string{agent + "[waiting for app: " + e.Type + "]"}
		case oar.AppRequestCancelled:
			return []string{agent + "[runtime withdrew its request]"}
		case oar.ControlRejected:
			return []string{agent + "[" + string(e.Action) + " rejected] " + e.Reason}
		case oar.Exited:
			if e.Code == nil {
				return []string{agent + "[runtime exited]"}
			}
			return []string{fmt.Sprintf("%s[runtime exited: %d]", agent, *e.Code)}
		case oar.TaskStarted:
			if e.Ambient != nil && *e.Ambient {
				return nil
			}
			line := agent + "[task " + e.TaskType + " started]"
			if e.Description != "" {
				line += " " + e.Description
			}
			return []string{line}
		case oar.TaskEnded:
			line := agent + "[task " + e.Status + "]"
			if e.Summary != "" {
				line += " " + e.Summary
			}
			return []string{line}
		}
		return nil
	}
}
