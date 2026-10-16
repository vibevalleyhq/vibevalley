package morph

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Pure readings of what the morph Console Runtime API says about one task
// (projection.ts): `/stream/ws` frames are snapshots, not deltas; a preview
// text is Console's tool status line; `GET /tasks/{id}` is authoritative and
// its terminal status ends the turn.

type openCall struct {
	callID string
	tool   string
}

// TaskProjection is what was read of one task so far.
type TaskProjection struct {
	TraceSeq  float64
	Text      string
	Message   int
	Reasoning string
	OpenCalls []openCall
}

// Projection is the fold's state across a session's tasks.
type Projection struct {
	Model string
	Tasks map[string]TaskProjection
}

// TerminalTaskStatuses end a turn.
var TerminalTaskStatuses = map[string]bool{"done": true, "failed": true, "canceled": true}

func text(value any) (string, bool) {
	s, ok := value.(string)
	return s, ok && s != ""
}

// describeArgs: a lone command string as is, otherwise JSON (key order kept).
func describeArgs(args jsonx.Record, raw json.RawMessage) *string {
	if len(args) == 0 {
		return nil
	}
	command, ok := args["cmd"].(string)
	if !ok {
		command, ok = args["command"].(string)
	}
	if ok && len(args) == 1 {
		return &command
	}
	value := jsonx.Stringify(raw)
	return &value
}

var retryCount = regexp.MustCompile(`\((\d+)/(\d+)\)`)
var retryDelay = regexp.MustCompile(`in (\d+(?:\.\d+)?)(ms|s)\b`)

func retryEvent(reason string) oar.EventBody {
	count := retryCount.FindStringSubmatch(reason)
	if count == nil {
		return nil
	}
	attempt, _ := strconv.Atoi(count[1])
	maxAttempts, _ := strconv.Atoi(count[2])
	retry := oar.Retry{Attempt: attempt, MaxAttempts: &maxAttempts, Reason: reason}
	if delay := retryDelay.FindStringSubmatch(reason); delay != nil {
		value, _ := strconv.ParseFloat(delay[1], 64)
		if delay[2] == "s" {
			value *= 1000
		}
		ms := int64(math.Round(value))
		retry.DelayMs = &ms
	}
	return retry
}

func (p Projection) withModel(model any) (Projection, []oar.EventBody) {
	name, ok := text(model)
	if !ok || name == p.Model {
		return p, nil
	}
	p.Model = name
	return p, []oar.EventBody{oar.Model{Model: name}}
}

var exitCodeLine = regexp.MustCompile(`^exit_code: (-?\d+)`)

func lastOpen(calls []openCall, tool string) *openCall {
	for i := len(calls) - 1; i >= 0; i-- {
		if calls[i].tool == tool {
			return &calls[i]
		}
	}
	return nil
}

// traceEvent reads one agent event (mistermorph agent/events.go).
func traceEvent(task TaskProjection, taskID string, seq float64, event jsonx.Record, raw map[string]json.RawMessage) (TaskProjection, []oar.EventBody) {
	tool, ok := text(event["tool_name"])
	if !ok {
		tool = "tool"
	}
	fallbackID := fmt.Sprintf("%s:%s", taskID, strconv.FormatFloat(seq, 'f', -1, 64))
	switch event["kind"] {
	case "tool_start":
		callID, ok := text(event["activity_id"])
		if !ok {
			callID = fallbackID
		}
		task.OpenCalls = append(append([]openCall{}, task.OpenCalls...), openCall{callID: callID, tool: tool})
		return task, []oar.EventBody{oar.ToolCallStarted{CallID: callID, Tool: tool, Input: describeArgs(jsonx.AsRecord(event["args"]), raw["args"])}}
	case "tool_output":
		open := lastOpen(task.OpenCalls, tool)
		if open == nil {
			return task, nil
		}
		progress := oar.ToolCallProgress{CallID: open.callID}
		if output, ok := text(event["text"]); ok {
			progress.Output = &output
		}
		return task, []oar.EventBody{progress}
	case "tool_done":
		callID, ok := text(event["activity_id"])
		if !ok {
			if open := lastOpen(task.OpenCalls, tool); open != nil {
				callID = open.callID
			} else {
				callID = fallbackID
			}
		}
		ended := oar.ToolCallEnded{CallID: callID}
		output, hasOutput := text(event["text"])
		if hasOutput {
			ended.Content = []oar.ToolOutputPart{{Type: "text", Text: output}}
			if match := exitCodeLine.FindStringSubmatch(output); match != nil {
				code, _ := strconv.Atoi(match[1])
				ended.ExitCode = oar.IntOf(code)
			}
		}
		_, hasError := text(event["error"])
		if hasError || event["status"] == "failed" || event["status"] == "error" {
			ended.Result = "failed"
		} else if event["status"] == "done" {
			ended.Result = "ok"
		}
		kept := []openCall{}
		for _, call := range task.OpenCalls {
			if call.callID != callID {
				kept = append(kept, call)
			}
		}
		task.OpenCalls = kept
		return task, []oar.EventBody{ended}
	case "llm_retry":
		reason, _ := text(event["text"])
		if retry := retryEvent(reason); retry != nil {
			return task, []oar.EventBody{retry}
		}
		return task, nil
	case "context_compaction_start":
		trigger, _ := text(event["reason"])
		return task, []oar.EventBody{oar.CompactionStarted{Trigger: trigger}}
	case "context_compaction_done":
		return task, []oar.EventBody{oar.CompactionEnded{Outcome: "completed"}}
	case "context_compaction_failed":
		reason, ok := text(event["error"])
		if !ok {
			reason, _ = text(event["reason"])
		}
		return task, []oar.EventBody{oar.CompactionEnded{Outcome: "failed", Reason: reason}}
	case "steer_applied":
		// The steer text entering the conversation; morph names no input id.
		if input, ok := text(event["text"]); ok {
			return task, []oar.EventBody{oar.UserMessage{Input: input, Evidence: "conversation"}}
		}
	}
	return task, nil
}

func readTrace(state Projection, taskID string, task TaskProjection, trace json.RawMessage) (Projection, TaskProjection, []oar.EventBody) {
	var events []oar.EventBody
	var entries []json.RawMessage
	_ = json.Unmarshal(jsonx.RawFields(trace)["entries"], &entries)
	for _, rawEntry := range entries {
		entry := jsonx.ParseRecord(rawEntry)
		seq, ok := jsonx.Num(entry, "seq")
		event := jsonx.AsRecord(entry["event"])
		if !ok || event == nil || seq <= task.TraceSeq {
			continue
		}
		var modelEvents []oar.EventBody
		state, modelEvents = state.withModel(event["model"])
		events = append(events, modelEvents...)
		var read []oar.EventBody
		task, read = traceEvent(task, taskID, seq, event, jsonx.RawFields(jsonx.RawFields(rawEntry)["event"]))
		task.TraceSeq = seq
		events = append(events, read...)
	}
	return state, task, events
}

// readText: the tail when the snapshot extends what was read, the whole of it as a new message otherwise.
func readText(task TaskProjection, taskID, snapshot string) (TaskProjection, []oar.EventBody) {
	if snapshot == task.Text || snapshot == "" {
		return task, nil
	}
	if strings.HasPrefix(snapshot, task.Text) {
		piece := snapshot[len(task.Text):]
		task.Text = snapshot
		return task, []oar.EventBody{oar.TextDelta{Text: piece, MessageID: fmt.Sprintf("%s:%d", taskID, task.Message)}}
	}
	if task.Text != "" {
		task.Message++
	}
	task.Text = snapshot
	return task, []oar.EventBody{oar.TextDelta{Text: snapshot, MessageID: fmt.Sprintf("%s:%d", taskID, task.Message)}}
}

func readReasoning(task TaskProjection, snapshot string) (TaskProjection, []oar.EventBody) {
	if snapshot == "" || snapshot == task.Reasoning {
		return task, nil
	}
	piece := snapshot
	if strings.HasPrefix(snapshot, task.Reasoning) {
		piece = snapshot[len(task.Reasoning):]
	}
	task.Reasoning = snapshot
	return task, []oar.EventBody{oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: piece}}}
}

func (p Projection) withTask(taskID string, task TaskProjection) Projection {
	tasks := make(map[string]TaskProjection, len(p.Tasks)+1)
	for id, value := range p.Tasks {
		tasks[id] = value
	}
	tasks[taskID] = task
	p.Tasks = tasks
	return p
}

// FoldStream reads one `/stream/ws` snapshot. Never a turn end.
func FoldStream(state Projection, frame json.RawMessage) (Projection, []oar.EventBody) {
	record := jsonx.ParseRecord(frame)
	taskID, ok := text(record["task_id"])
	if record == nil || !ok {
		return state, nil
	}
	state, task, events := readTrace(state, taskID, state.Tasks[taskID], jsonx.RawFields(frame)["trace"])
	reasoningText, _ := text(record["reasoning"])
	task, reasoning := readReasoning(task, reasoningText)
	events = append(events, reasoning...)
	_, hasError := text(record["error"])
	errored := record["status"] == "failed" || record["status"] == "canceled" || hasError
	if record["preview"] != true && !errored {
		snapshot, _ := text(record["text"])
		var said []oar.EventBody
		task, said = readText(task, taskID, snapshot)
		events = append(events, said...)
	}
	return state.withTask(taskID, task), events
}

func outcomeOf(info jsonx.Record) oar.TurnOutcome {
	switch info["status"] {
	case "done":
		return oar.Completed()
	case "canceled":
		return oar.AbortedOutcome()
	}
	reason, ok := text(info["error"])
	if !ok {
		reason = "morph task failed"
	}
	return oar.Failed(shared.ClassifyFailure(reason), reason)
}

func finalOutput(result json.RawMessage) (string, bool) {
	output, present := jsonx.RawFields(jsonx.RawFields(result)["final"])["output"]
	if !present || string(output) == "null" {
		return "", false
	}
	var asString string
	if json.Unmarshal(output, &asString) == nil {
		return asString, asString != ""
	}
	return jsonx.Stringify(output), true
}

// FoldTask reads a `GET /tasks/{id}` answer: a terminal one reads what the
// stream did not deliver, then the turn end; any other status adds nothing.
func FoldTask(state Projection, info json.RawMessage) (Projection, []oar.EventBody) {
	record := jsonx.ParseRecord(info)
	taskID, ok := text(record["id"])
	status, isString := record["status"].(string)
	if record == nil || !ok || !isString || !TerminalTaskStatuses[status] {
		return state, nil
	}
	result := jsonx.RawFields(info)["result"]
	resultRecord := jsonx.ParseRecord(result)
	previous := state.Tasks[taskID]
	state, events := state.withModel(record["model"])
	state, task, trace := readTrace(state, taskID, previous, jsonx.RawFields(result)["trace"])
	events = append(events, trace...)
	reasoningText, _ := text(resultRecord["reasoning"])
	task, reasoning := readReasoning(task, reasoningText)
	events = append(events, reasoning...)
	// Only a finished task's output is the agent's answer.
	if status == "done" {
		if answer, ok := finalOutput(result); ok {
			_, said := readText(task, taskID, answer)
			events = append(events, said...)
		}
	}
	tasks := make(map[string]TaskProjection, len(state.Tasks))
	for id, value := range state.Tasks {
		if id != taskID {
			tasks[id] = value
		}
	}
	state.Tasks = tasks
	return state, append(events, oar.TurnEnded{Outcome: outcomeOf(record)})
}

// ContextEvents reads the topic's context fullness from `GET /topic/{id}/metadata`.
func ContextEvents(metadata json.RawMessage) []oar.EventBody {
	context := jsonx.AsRecord(jsonx.ParseRecord(metadata)["context"])
	if context["available"] != true {
		return nil
	}
	usage := &oar.ContextUsage{Tokens: jsonx.Int64(context, "used_input_tokens"), ContextWindow: jsonx.Int64(context, "context_window_tokens")}
	if ratio, ok := jsonx.Num(context, "usage_ratio"); ok {
		percent := ratio * 100
		usage.Percent = &percent
	}
	return []oar.EventBody{oar.Usage{Usage: oar.UsageReport{Context: usage}}}
}
