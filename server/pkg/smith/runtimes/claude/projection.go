package claude

import (
	"strconv"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// The claude stdout → record projection as a PURE FOLD (projection.ts). A
// reducer over the raw stream-json frames that emits kernel COMMANDS
// (append an event with its attribution, answer one of our control
// requests, surface a runtime→app request) instead of touching the kernel
// itself. The live adapter applies the commands to a real kernel; tests
// apply them to nothing and snapshot the list.
//
// Rules the fold enforces: EVERY frame becomes exactly one frame (verbatim
// native, events in block order), even outside a turn. Repeated init
// frames do not reopen an active turn; its end is claude's own result.
// Attribution comes from parent_tool_use_id (a child's path is its parent's
// path plus the Task tool_use id that spawned it).

// projectionCommand is "frame" (Body, AgentPath), "respond" (claude
// answered one of our control_requests: RequestID, Response) or "toApp"
// (claude asked US something: ID, Type, Native).
type projectionCommand struct {
	Kind      string
	Body      oar.FrameBody
	AgentPath []string
	RequestID string
	Response  oar.ResponseBody
	ID        string
	Type      string
	Native    []byte
}

// projectionState is the fold state. AbortRequested is control-plane
// intent, not provider data: claude reports its result as an ordinary
// result frame, so the flag is how the fold tells aborted from completed.
// Agents maps every tool_use id seen to the agentPath of the message that
// carried it. Tokens accumulates the main loop's per-turn result usage (the
// root agent's), so usage events are cumulative; ModelUsage is the
// session's own running total and where this Session's share of it starts.
// FailureCategory is the error of the turn's last root assistant frame,
// which classifies a failed result. LimitResetsAt is the reset of the limit
// the latest rate_limit_event says refuses requests, kept across turns
// until another event replaces it. Every map and set is replaced, never
// modified, so an earlier state stays valid. "" is TS null for the ids.
type projectionState struct {
	AbortRequested bool
	// Prompt requests and root init/results delimit a turn, including native spontaneous turns.
	TurnActive bool
	// Unlike the provisional prompt start, this is an observed init/started without a result.
	NativeTurnActive bool
	// Root init since this prompt write, not claimed by started or reported as spontaneous yet.
	UnclaimedInit bool
	// Prompt identity and native queue evidence, retained across unrelated turns.
	PromptInputID string
	// Prompt-like writes, including queue drains; steers are never registered.
	PromptInputs inputSet
	// Written prompt inputs with no native started yet, including the pre-queued window.
	UnstartedInputs inputSet
	// Prompt-like writes with neither queued nor started since THIS write; reset when an id is reused.
	UnacknowledgedInputs inputSet
	PendingInputID       string
	Agents               map[string][]string
	Tokens               map[string]oar.TokenTotals
	ModelUsage           modelUsage
	Partials             claudePartials
	// Last native task description per agent/task, for progress de-duplication.
	TaskDescriptions map[string]string
	FailureCategory  string
	LimitResetsAt    string
}

// initialClaudeProjection is a new session's fold.
func initialClaudeProjection() projectionState {
	return projectionState{
		PromptInputs:         inputSet{},
		UnstartedInputs:      inputSet{},
		UnacknowledgedInputs: inputSet{},
		Agents:               map[string][]string{},
		Tokens:               map[string]oar.TokenTotals{},
		ModelUsage:           freshModelUsage,
		Partials:             claudePartials{},
		TaskDescriptions:     map[string]string{},
	}
}

// resumedClaudeProjection is a resumed session's fold: it counts no tokens
// until claudeUsageBaselined says where its share starts.
func resumedClaudeProjection() projectionState {
	state := initialClaudeProjection()
	state.ModelUsage = resumedModelUsage
	return state
}

// claudeUsageBaselined is the adapter's get_usage read-back at open: where
// a resumed Session's share of claude's running total starts.
func claudeUsageBaselined(state projectionState, baseline usageBaseline) projectionState {
	state.ModelUsage = withBaseline(state.ModelUsage, baseline)
	return state
}

func claudeAbortRequested(state projectionState) projectionState {
	state.AbortRequested = true
	return state
}

func resultOutcome(state projectionState, message nativeMessage) oar.TurnOutcome {
	if state.AbortRequested {
		return oar.AbortedOutcome()
	}
	if message.Record["is_error"] == true {
		// Vendor quirk (pinned 2026-08-22): claude can report is_error=true with
		// subtype "success" and put the actual error text in result.
		text, _ := message.Record["result"].(string)
		subtype, _ := message.Record["subtype"].(string)
		if subtype == "success" {
			subtype = ""
		}
		if text == "" {
			text = claudeResultReason(subtype, message.Record["errors"])
		}
		facts := claudeFailureFacts{Category: state.FailureCategory, Subtype: subtype, LimitResetsAt: state.LimitResetsAt}
		if status, ok := jsonx.Num(message.Record, "api_error_status"); ok {
			value := int(status)
			facts.Status = &value
		}
		facts.TerminalReason, _ = message.Record["terminal_reason"].(string)
		return claudeFailure(text, facts)
	}
	outcome := oar.Completed()
	if _, ok := message.Record["structured_output"]; ok {
		outcome.StructuredOutput = rawField(message.raw, "structured_output")
	}
	return outcome
}

func pathKey(agentPath []string) string {
	return jsonText(nonNilPath(agentPath))
}

// attributionOf is the agent a frame belongs to: root, or the Task call
// that spawned it (nested through the call's own agent).
func attributionOf(state projectionState, message jsonx.Record) []string {
	parent, ok := message["parent_tool_use_id"].(string)
	if !ok || parent == "" {
		return []string{}
	}
	return append(append([]string{}, state.Agents[parent]...), parent)
}

func rememberToolUses(state projectionState, message nativeMessage, agentPath []string) projectionState {
	event := jsonx.AsRecord(message.Record["event"])
	var ids []string
	if event["type"] == "content_block_start" && jsonx.AsRecord(event["content_block"]) != nil {
		block := jsonx.AsRecord(event["content_block"])
		if id, ok := block["id"].(string); ok && block["type"] == "tool_use" {
			ids = append(ids, id)
		}
	} else {
		for _, block := range contentBlocks(message) {
			if id, ok := block.Record["id"].(string); ok && block.Record["type"] == "tool_use" {
				ids = append(ids, id)
			}
		}
	}
	if len(ids) == 0 {
		return state
	}
	agents := make(map[string][]string, len(state.Agents)+len(ids))
	for key, value := range state.Agents {
		agents[key] = value
	}
	for _, id := range ids {
		agents[id] = agentPath
	}
	state.Agents = agents
	return state
}

func frameType(message jsonx.Record) string {
	kind, ok := message["type"].(string)
	if !ok {
		kind = "unknown"
	}
	if subtype, ok := message["subtype"].(string); ok {
		return kind + "/" + subtype
	}
	return kind
}

// accumulate is the cumulative per-agent tokens after folding this result
// frame's own turn usage: the main loop's (claude's word), so the root
// agent's. None while a resumed Session's share is unknown. Subagents get
// no entry: only a subagent's first assistant frame carries
// parent_tool_use_id, and its message.usage is the stream-start value, not
// final, so their spend stays in the session total, unattributed.
func accumulate(state projectionState, agentPath []string, message jsonx.Record) (projectionState, *oar.TokenTotals) {
	if state.ModelUsage.Baseline.Kind != "known" {
		return state, nil
	}
	key := pathKey(agentPath)
	var previous *oar.TokenTotals
	if known, ok := state.Tokens[key]; ok {
		previous = &known
	}
	tokens := withMainLoop(previous, message)
	if tokens == nil {
		return state, nil
	}
	next := make(map[string]oar.TokenTotals, len(state.Tokens)+1)
	for name, value := range state.Tokens {
		next[name] = value
	}
	next[key] = *tokens
	state.Tokens = next
	return state, tokens
}

// jsString is String(value) for the types a frame's type can be.
func jsString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case nil:
		return "undefined"
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	}
	return "[object]"
}

// foldClaudeStdout folds one parsed claude stdout frame into the next state plus commands.
func foldClaudeStdout(state projectionState, message nativeMessage) (projectionState, []projectionCommand) {
	record := message.Record
	kind := frameType(record)
	agentPath := attributionOf(state, record)
	root := len(agentPath) == 0
	event := func(events []oar.EventBody, next projectionState) (projectionState, []projectionCommand) {
		return next, []projectionCommand{{Kind: "frame", Body: oar.FrameBody{Type: kind, Native: message.raw, Events: events}, AgentPath: agentPath}}
	}

	switch jsString(record["type"]) {
	case "command_lifecycle":
		next, events := claudeInputLifecycle(state, record, root)
		return event(events, next)
	case "assistant", "stream_event":
		partials, events := claudeContent(state.Partials, message, agentPath)
		next := state
		next.Partials = partials
		next = rememberToolUses(next, message, agentPath)
		if record["type"] != "assistant" {
			return event(events, next)
		}
		// The category of an error claude reports as an assistant message.
		if category, ok := record["error"].(string); ok && root {
			next.FailureCategory = category
		}
		return event(events, next)
	case "user":
		views := claudeToolResults(message)
		body := jsonx.AsRecord(record["message"])
		uuid, hasUUID := record["uuid"].(string)
		if content, ok := body["content"].([]any); ok && record["isReplay"] == true && hasUUID {
			input := ""
			for _, part := range content {
				entry := jsonx.AsRecord(part)
				if entry["type"] == "text" {
					text, _ := entry["text"].(string)
					input += text
				}
			}
			views = append(views, oar.UserMessage{Input: input, InputID: uuid, NativeMessageID: uuid, Evidence: "acknowledged"})
		}
		next := state
		if record["isReplay"] == true && hasUUID {
			var dropped []oar.EventBody
			next, dropped = claudeDuplicateInput(state, uuid, root)
			views = append(views, dropped...)
		}
		return event(views, next)
	case "result":
		events := append(claudeServiceTierEvents(record), oar.TurnEnded{Outcome: resultOutcome(state, message)})
		accumulated, tokens := accumulate(state, agentPath, record)
		running, total := foldModelUsage(state.ModelUsage, record)
		context := claudeContextUsageFromResult(message)
		if tokens != nil || context != nil || total != nil {
			events = append(events, oar.Usage{Usage: oar.UsageReport{Context: context, Tokens: tokens, Total: total}})
		}
		next := accumulated
		next.ModelUsage = running
		if root {
			next.TurnActive = false
			next.NativeTurnActive = false
			next.UnclaimedInit = false
			if state.PendingInputID == "" {
				next.PromptInputID = ""
			}
		}
		next.AbortRequested = false
		next.FailureCategory = ""
		return event(events, next)
	case "system":
		switch record["subtype"] {
		case "compact_boundary":
			// claude reports compaction only after the fact: the boundary frame
			// carries compact_metadata {trigger: manual | auto, pre_tokens, …};
			// there is no start frame, so no compaction_started.
			trigger, _ := jsonx.AsRecord(record["compact_metadata"])["trigger"].(string)
			return event([]oar.EventBody{oar.CompactionEnded{Outcome: "completed", Trigger: trigger}}, state)
		case "init":
			next, events := claudeInitialized(state, root)
			if model, ok := record["model"].(string); ok {
				events = append(events, oar.Model{Model: model})
			}
			return event(append(events, claudeServiceTierEvents(record)...), next)
		}
		events, descriptions := claudeTaskViews(record, state.TaskDescriptions, agentPath)
		next := state
		next.TaskDescriptions = descriptions
		return event(append(events, claudeServiceTierEvents(record)...), next)
	case "control_response":
		// claude answering one of OUR control_requests (interrupt): the frame IS
		// the response record (native verbatim); one frame, one record, so it is
		// not also recorded as an event. A control_response we cannot pair is
		// recorded as a plain event.
		response := jsonx.AsRecord(record["response"])
		requestID, ok := response["request_id"].(string)
		if !ok {
			return event(nil, state)
		}
		failure, isError := response["error"].(string)
		body := oar.ResponseBody{Kind: oar.ResponseAccepted, Native: message.raw}
		if response["subtype"] == "error" || isError {
			if !isError {
				failure = "control request failed"
			}
			body = oar.ResponseBody{Kind: oar.ResponseRejected, Code: oar.CodeRuntimeRefused, Reason: failure, Native: message.raw}
		}
		return state, []projectionCommand{{Kind: "respond", RequestID: requestID, Response: body}}
	case "control_request":
		// claude asks the app something (permission, question). Recorded verbatim; the adapter answers nothing.
		id, ok := record["request_id"].(string)
		if !ok {
			id = "claude-" + strconv.FormatInt(time.Now().UnixMilli(), 10)
		}
		subtype, ok := jsonx.AsRecord(record["request"])["subtype"].(string)
		if !ok {
			subtype = "control_request"
		}
		return state, []projectionCommand{
			{Kind: "frame", Body: oar.FrameBody{Type: kind, Native: message.raw}, AgentPath: agentPath},
			{Kind: "toApp", ID: id, Type: subtype, Native: message.raw},
		}
	case "rate_limit_event":
		// claude's view of the subscription limits changed: read for a failed turn's resetsAt, no event of its own.
		next := state
		next.LimitResetsAt = claudeLimitReset(jsonx.AsRecord(record["rate_limit_info"]))
		return event(nil, next)
	case "control_cancel_request":
		// claude withdrew a request it had sent us (an interrupt cancels a pending question).
		if id, ok := record["request_id"].(string); ok {
			return event([]oar.EventBody{oar.AppRequestCancelled{RequestID: id}}, state)
		}
		return event(nil, state)
	}
	return event(nil, state)
}
