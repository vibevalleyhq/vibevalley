package agent

// A run cut off by the process ending (a crash, a restart) is gone on with when it starts again: its conversation ends
// with something the model has not answered yet. One the owner stopped ends with the stop and is not.

import (
	"time"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

const RESUMED_UNKNOWN = "服务端在这个工具做完之前重启了，不知道它做没做成：先查一下现状，再决定要不要再做一遍。"

// The calls of the last answer that have no result; ok is false when there is nothing to go on with: the model spoke
// last with nothing left to do, or the run was stopped or failed.
func unfinished(messages []agentcore.AgentMessage) (missing []ai.Content, ok bool) {
	if len(messages) == 0 {
		return nil, false
	}
	switch last := messages[len(messages)-1].(type) {
	case ai.AssistantMessage:
		if last.StopReason == ai.StopAborted || last.StopReason == ai.StopError {
			return nil, false
		}
		calls := last.ToolCalls()
		return calls, len(calls) > 0
	case ai.ToolResultMessage:
		if last.IsError && MessageText(last) == agentcore.STOPPED {
			return nil, false
		}
		for i := len(messages) - 1; i >= 0; i-- {
			answer, ok := messages[i].(ai.AssistantMessage)
			if !ok {
				continue
			}
			answered := map[string]bool{}
			for _, m := range messages[i+1:] {
				if r, ok := m.(ai.ToolResultMessage); ok {
					answered[r.ToolCallID] = true
				}
			}
			for _, call := range answer.ToolCalls() {
				if !answered[call.ID] {
					missing = append(missing, call)
				}
			}
			break
		}
		return missing, true
	case ai.UserMessage, CustomMessage:
		return nil, true
	}
	return nil, false
}

// Reads the file only, without making an agent.
func SessionUnfinished(file string) bool {
	_, ok := unfinished(SessionAt(file).Load())
	return ok
}

// Goes on with the run the conversation was cut off in; true when it does. Each call of the last answer without a
// result is given one, failed, saying it is not known whether it was done. Not when it is busy, the run ended or was
// stopped, or its last message is older than maxAge.
func (a *Agent) Resume(maxAge time.Duration) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.quietLocked() {
		return false
	}
	messages := a.Core.State().Messages
	missing, ok := unfinished(messages)
	if !ok || time.Since(time.UnixMilli(messages[len(messages)-1].Time())) > maxAge {
		return false
	}
	if len(missing) > 0 {
		messages = append([]agentcore.AgentMessage{}, messages...)
		for _, call := range missing {
			result := ai.ToolResultMessage{ToolCallID: call.ID, ToolName: call.Name, Content: []ai.Content{ai.NewText(RESUMED_UNKNOWN)}, IsError: true, Timestamp: time.Now().UnixMilli()}
			messages = append(messages, result)
			if a.session != nil {
				_ = a.session.Append(result)
			}
		}
		a.Core.SetMessages(messages)
	}
	a.stopIdleLocked()
	a.runLocked(a.Core.Continue)
	return true
}
