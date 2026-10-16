package observe

import (
	"fmt"
	"strconv"
	"strings"

	"vibevalley/pkg/smith/oar"
)

// English display wording (observe/display-text.ts). It may change in a
// minor release. Use the types, not these strings, for decisions.

// NoticeTone is "quiet", "warning" or "danger".
type NoticeTone string

func unreachable(value any) string {
	panic(fmt.Sprintf("Unknown display value: %v", value))
}

func outcomeLabel(kind string) string {
	switch kind {
	case "completed", "aborted", "failed":
		return kind
	}
	return unreachable(kind)
}

func outcomeTone(kind string) NoticeTone {
	switch kind {
	case "completed":
		return "quiet"
	case "aborted":
		return "warning"
	case "failed":
		return "danger"
	}
	return NoticeTone(unreachable(kind))
}

func actionLabel(action oar.ControlAction) string {
	switch action {
	case oar.ActionPrompt:
		return "Prompt"
	case oar.ActionSteer:
		return "Steer"
	case oar.ActionQueue:
		return "Queue"
	case oar.ActionWithdraw:
		return "Withdraw"
	case oar.ActionAbort:
		return "Abort"
	case oar.ActionDispose:
		return "Dispose"
	}
	return unreachable(action)
}

func withDetail(text, reason string) string {
	if reason == "" {
		return text
	}
	return text + ": " + reason
}

// NoticeText is a notice's English display text, including native reasons when present. Never parse this wording.
func NoticeText(notice ViewNotice) string {
	switch notice.Cause {
	case "compaction_started":
		return withDetail("Compacting context", notice.Trigger)
	case "compaction_ended":
		trigger := ""
		if notice.Trigger != "" {
			trigger = " (" + notice.Trigger + ")"
		}
		return withDetail("Context compaction "+outcomeLabel(notice.CompactionOutcome)+trigger, notice.Reason)
	case "retry":
		maximum := ""
		if notice.MaxAttempts != nil {
			maximum = fmt.Sprintf(" of %d", *notice.MaxAttempts)
		}
		delay := ""
		if notice.DelayMs != nil {
			// JS number formatting of delayMs / 1000: 1.5, 0, 12.345.
			delay = ", in " + strconv.FormatFloat(float64(*notice.DelayMs)/1000, 'f', -1, 64) + "s"
		}
		return withDetail(fmt.Sprintf("Retrying (attempt %d%s%s)", notice.Attempt, maximum, delay), notice.Reason)
	case "control_rejected":
		return withDetail(actionLabel(notice.Action)+" rejected", notice.Reason)
	case "child_turn_ended":
		reason := ""
		if notice.Outcome.Kind == "failed" {
			reason = notice.Outcome.Reason
		}
		return withDetail("Subagent turn "+outcomeLabel(notice.Outcome.Kind), reason)
	case "exited":
		if notice.Code == nil {
			return "Runtime exited"
		}
		return fmt.Sprintf("Runtime exited (code %d)", *notice.Code)
	}
	return unreachable(notice.Cause)
}

// NoticeToneOf is the display emphasis for a notice; a host chooses its colors and presentation.
func NoticeToneOf(notice ViewNotice) NoticeTone {
	switch notice.Cause {
	case "compaction_started":
		return "quiet"
	case "compaction_ended":
		return outcomeTone(notice.CompactionOutcome)
	case "retry", "control_rejected":
		return "warning"
	case "child_turn_ended":
		return outcomeTone(notice.Outcome.Kind)
	case "exited":
		switch {
		case notice.Code == nil:
			return "warning"
		case *notice.Code == 0:
			return "quiet"
		default:
			return "danger"
		}
	}
	return NoticeTone(unreachable(notice.Cause))
}

// shortToolName is an MCP tool's own name (mcp__server__tool → tool); any other tool id as it is.
func shortToolName(tool string) string {
	separator := strings.LastIndex(tool, "__")
	if strings.HasPrefix(tool, "mcp__") && separator > len("mcp__") {
		return tool[separator+2:]
	}
	return tool
}

// PhaseLabel is the running phase in English, for display only. With a
// runtimeID ("" for none), a running call reads as its action ("Editing
// file", "Running command"); an MCP or unclassified tool by its short name.
// Without it, the tool id as reported. A call whose arguments are still
// streaming reads as preparing its action ("Preparing file edit"), or
// "Writing <tool> arguments" for an MCP or unclassified tool.
func PhaseLabel(phase oar.RunningPhase, runtimeID string) string {
	if phase.IsTool() {
		name := phase.Tool
		kind := ToolOther
		if runtimeID != "" {
			name = shortToolName(phase.Tool)
			kind = ClassifyTool(runtimeID, phase.Tool, nil).Kind
		}
		state := ToolState("running")
		if phase.Writing {
			state = "writing"
		}
		if kind != ToolOther && kind != ToolMCP {
			return ToolActionLabel(kind, state)
		}
		if state == "writing" {
			return "Writing " + name + " arguments"
		}
		return "Running " + name
	}
	switch phase.Name {
	case "waiting_model":
		return "Waiting for model"
	case "thinking":
		return "Thinking"
	case "responding":
		return "Responding"
	case "compacting":
		return "Compacting context"
	}
	return unreachable(phase.Name)
}

func authText(runtimeName string, credential oar.CredentialProblem) string {
	switch credential {
	case "missing":
		return runtimeName + " is not signed in."
	case "rejected":
		return runtimeName + "'s credentials were rejected."
	case "":
		return runtimeName + " could not authenticate."
	}
	return unreachable(credential)
}

// FailureText is what the runtime reported, in English. The host supplies
// any sign-in or recovery guidance. credential (a failed outcome's; "" for
// none) words auth as a missing login or a refused credential when the runtime said which.
func FailureText(failure oar.FailureClass, runtimeName string, credential oar.CredentialProblem) string {
	switch failure {
	case oar.FailureAuth:
		return authText(runtimeName, credential)
	case oar.FailureQuota:
		return runtimeName + " reported that its usage limit was reached."
	case oar.FailureRateLimited:
		return runtimeName + " was rate limited by its provider."
	case oar.FailureBilling:
		return runtimeName + " reported a billing or credit problem."
	case oar.FailureModelUnavailable:
		return runtimeName + " cannot use the selected model."
	case oar.FailureInputTooLarge:
		return runtimeName + " reported that the input is too large for the model."
	case oar.FailureLimitReached:
		return runtimeName + " stopped at the turn or budget limit set for it."
	case oar.FailureOutputSchema:
		return runtimeName + " could not produce output matching the output schema."
	case oar.FailureInvalidRequest:
		return runtimeName + " rejected the request as invalid."
	case oar.FailureOverloaded:
		return runtimeName + " reported that its provider is overloaded."
	case oar.FailureProvider:
		return runtimeName + " reported a provider error."
	case oar.FailureRuntimeExited:
		return runtimeName + " exited before the turn finished."
	case oar.FailureUnknown:
		return "The turn failed."
	}
	return unreachable(failure)
}

// TaskStatusLabel is a task's status in English, for display only.
func TaskStatusLabel(status oar.TaskStatus) string {
	switch status {
	case "pending":
		return "Pending"
	case "running":
		return "Running"
	case "paused":
		return "Paused"
	case "completed":
		return "Completed"
	case "failed":
		return "Failed"
	case "stopped":
		return "Stopped"
	}
	return unreachable(status)
}
