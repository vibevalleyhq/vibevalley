package codex

import (
	"encoding/json"
	"strconv"
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// The codex notification → record projection as a PURE FOLD (projection.ts;
// see runtimes/claude/projection.go for the shape). Every notification
// becomes exactly one frame command: verbatim `native`, events in oar's
// vocabulary, the runtime's own turn id as `spanId`. Plus, for collaboration
// items that name other threads, a link command for the session graph.
// Nothing is gated on turn state and nothing is dropped; the adapter applies
// the commands and separately owns the transport-only turn id (steer/abort
// identity), which is not part of the projection. Behavior is pinned by
// tests/replay against recorded fixtures.

// toolItemTypes are the items read as tool calls. `sleep` is the model
// waiting (`{durationMs}`, the wait it asked for; a steer can end it early).
// It reports no status, so its end carries no result.
var toolItemTypes = map[string]bool{"commandExecution": true, "fileChange": true, "mcpToolCall": true, "webSearch": true, "sleep": true}
var collabItemTypes = map[string]bool{"collabAgentToolCall": true, "collabToolCall": true, "subAgentActivity": true}

// projectionCommand is "frame" (Body; SpanID the runtime-native turn id when
// the notification carries one; SessionID set when the notification belongs
// to another thread: a derived child session) or "link" (Edge).
type projectionCommand struct {
	Kind      string
	Body      oar.FrameBody
	SpanID    string
	SessionID string
	Edge      oar.SessionEdge
}

// codexProjectionState is the fold's state. LastErrorDetail carries codex's
// structured `error` notification (which its terminal turn status does NOT
// include) into the failed turn_ended reason. Never modified once built.
type codexProjectionState struct {
	RootThreadID string
	// Accepted steers and native echoes, keyed by the turn that owns them.
	Inputs          codexInputs
	LastErrorDetail *string
	// A root-thread compaction is open (its `contextCompaction` item
	// started). codex says "compacted" twice, as the item's completion and as
	// the deprecated `thread/compacted` notification ([env] 0.154.0 schema);
	// the flag lets the second report close nothing instead of ending twice.
	Compacting bool
	// Subagent threads the stream reported starting: who started each, and its path.
	Subagents subagentThreads
	// Where the root thread's token totals count from: this Session's opening (token_usage.go).
	TokenBaseline codexTokenBaseline
}

// initialCodexProjection is the projection of a Session opened by opened: a
// resume awaits codex's re-reported token total.
func initialCodexProjection(rootThreadID, opened string) codexProjectionState {
	return codexProjectionState{RootThreadID: rootThreadID, Inputs: codexInputs{}, TokenBaseline: initialTokenBaseline(opened == methodThreadResume)}
}

const compactionItemType = "contextCompaction"

func isCompactionItem(params jsonx.Record) bool {
	return jsonx.AsRecord(params["item"])["type"] == compactionItemType
}

// outcomeFromTurn: the runtime's own status is the truth. An interrupt that
// landed reports "interrupted"; one that lost the race to completion reports
// "completed". A failure is classified from the turn's own error (failure.go).
func outcomeFromTurn(state codexProjectionState, turn jsonx.Record) oar.TurnOutcome {
	switch turn["status"] {
	case "interrupted":
		return oar.AbortedOutcome()
	case "completed":
		return oar.Completed()
	}
	word, ok := turn["status"].(string)
	if !ok {
		word = "unknown"
	}
	reason := word
	if state.LastErrorDetail != nil {
		reason = word + ": " + *state.LastErrorDetail
	}
	return codexFailure(reason, turn["error"])
}

func toolViews(method string, item jsonx.Record, raw json.RawMessage) []oar.EventBody {
	itemType, _ := item["type"].(string)
	if !toolItemTypes[itemType] {
		return nil
	}
	itemID, ok := item["id"].(string)
	if !ok {
		itemID = "unknown"
	}
	if method == "item/started" {
		return []oar.EventBody{oar.ToolCallStarted{CallID: itemID, Tool: itemType, Input: codexItemInput(raw)}}
	}
	ended := oar.ToolCallEnded{CallID: itemID, Content: codexToolContent(raw), ExitCode: codexItemExitCode(raw)}
	switch item["status"] {
	case "completed":
		ended.Result = "ok"
	case "failed":
		ended.Result = "failed"
	}
	return []oar.EventBody{ended}
}

// settingsViews reads `thread/settings/updated`, codex's own report of the
// thread's settings after a change ([env] 0.155.1: pushed when a turn/start
// carries an `effort` or `model` override, "for this turn and subsequent
// turns"): `threadSettings.model` and `threadSettings.effort` (null: no
// explicit level) are the model and effort now in effect.
func settingsViews(params jsonx.Record) []oar.EventBody {
	settings := jsonx.AsRecord(params["threadSettings"])
	events := append([]oar.EventBody{}, codexServiceTierEvents(settings)...)
	if model, ok := settings["model"].(string); ok && model != "" {
		events = append(events, oar.Model{Model: model})
	}
	if effort, ok := settings["effort"].(string); ok && effort != "" {
		events = append(events, oar.Effort{Effort: effort})
	}
	return events
}

// collabEdges are the edges a collaboration item establishes: the sender
// thread (the reporting thread unless the item names one) spawned or
// addressed the named threads.
func collabEdges(state codexProjectionState, reporter string, item jsonx.Record) []oar.SessionEdge {
	itemType, _ := item["type"].(string)
	if item == nil || !collabItemTypes[itemType] {
		return nil
	}
	if itemType == "subAgentActivity" && !aboutOwnChild(state.Subagents, state.RootThreadID, reporter, item) {
		return nil
	}
	parent, ok := item["senderThreadId"].(string)
	if !ok {
		parent = reporter
	}
	receivers, _ := item["receiverThreadIds"].([]any)
	var edges []oar.SessionEdge
	for _, id := range append(append([]any(nil), receivers...), item["agentThreadId"]) {
		if child, isString := id.(string); isString && child != "" && child != parent {
			edges = append(edges, oar.SessionEdge{Parent: parent, Child: child, Via: "tool_call"})
		}
	}
	return edges
}

func spanIDOf(params jsonx.Record) string {
	if turnID, ok := params["turnId"].(string); ok {
		return turnID
	}
	turnID, _ := jsonx.AsRecord(params["turn"])["id"].(string)
	return turnID
}

func userMessageInput(item jsonx.Record) string {
	var text strings.Builder
	for _, part := range item["content"].([]any) {
		record := jsonx.AsRecord(part)
		if record == nil || record["type"] != "text" {
			continue
		}
		if value, ok := record["text"].(string); ok {
			text.WriteString(value)
		}
	}
	return text.String()
}

func viewsFor(state codexProjectionState, reporter, method string, params jsonx.Record, fields map[string]json.RawMessage) []oar.EventBody {
	switch method {
	case "turn/started":
		return []oar.EventBody{oar.TurnActive{}}
	case "item/agentMessage/delta":
		// `itemId` names the agentMessage item: one turn can say several.
		delta, ok := params["delta"].(string)
		if !ok {
			return nil
		}
		messageID, _ := params["itemId"].(string)
		return []oar.EventBody{oar.TextDelta{Text: delta, MessageID: messageID}}
	case "item/commandExecution/outputDelta":
		// Streamed stdout of a running command item; `itemId` is the tool call.
		itemID, ok := params["itemId"].(string)
		if !ok {
			return nil
		}
		progress := oar.ToolCallProgress{CallID: itemID}
		if delta, isString := params["delta"].(string); isString {
			progress.OutputDelta = &delta
		}
		return []oar.EventBody{progress}
	case "serverRequest/resolved":
		// oar answers no codex request, so a resolved one is codex clearing it
		// itself (observed after turn/interrupt, 0.160.1). codex sends it after
		// a client's answer too: an answer path must not read that as
		// cancelled. Request ids are recorded as strings (app_server_client.go).
		switch id := params["requestId"].(type) {
		case string:
			return []oar.EventBody{oar.AppRequestCancelled{RequestID: id}}
		case float64:
			return []oar.EventBody{oar.AppRequestCancelled{RequestID: jsString(id)}}
		}
		return nil
	case "thread/compacted":
		if state.Compacting {
			return []oar.EventBody{oar.CompactionEnded{Outcome: "completed"}}
		}
		return nil
	case "rawResponseItem/completed":
		if content := codexReasoningContent(jsonx.AsRecord(params["item"])); content != nil {
			return []oar.EventBody{oar.Reasoning{Content: *content}}
		}
		return nil
	case "item/started":
		item := jsonx.AsRecord(params["item"])
		if _, isList := item["content"].([]any); item["type"] == "userMessage" && isList {
			message := oar.UserMessage{Input: userMessageInput(item), Evidence: "turn_item"}
			message.InputID, _ = item["clientId"].(string)
			message.NativeMessageID, _ = item["id"].(string)
			message.TurnID, _ = params["turnId"].(string)
			return []oar.EventBody{message}
		}
		if isCompactionItem(params) {
			return []oar.EventBody{oar.CompactionStarted{}}
		}
		return toolViews(method, item, fields["item"])
	case "item/completed":
		if isCompactionItem(params) {
			return []oar.EventBody{oar.CompactionEnded{Outcome: "completed"}}
		}
		item := jsonx.AsRecord(params["item"])
		if item["type"] == "subAgentActivity" {
			if aboutOwnChild(state.Subagents, state.RootThreadID, reporter, item) {
				return codexTaskViews(item)
			}
			return nil
		}
		return toolViews(method, item, fields["item"])
	case "turn/completed":
		return []oar.EventBody{oar.TurnEnded{Outcome: outcomeFromTurn(state, jsonx.AsRecord(params["turn"]))}}
	case "thread/tokenUsage/updated":
		baseline := &oar.TokenTotals{}
		if reporter == state.RootThreadID {
			baseline = baselineTokens(state.TokenBaseline)
		}
		return codexUsageViews(params, baseline)
	case "thread/settings/updated":
		return settingsViews(params)
	}
	return nil
}

// jsString is String(number) for a JSON number.
func jsString(number float64) string {
	return strconv.FormatFloat(number, 'f', -1, 64)
}

// notificationParams reads a notification's params: decoded, as raw fields,
// and the raw text the frame keeps verbatim (`{}` when not an object).
func notificationParams(raw json.RawMessage) (jsonx.Record, map[string]json.RawMessage, json.RawMessage) {
	record := jsonx.ParseRecord(raw)
	if record == nil {
		return jsonx.Record{}, map[string]json.RawMessage{}, json.RawMessage(`{}`)
	}
	return record, jsonx.RawFields(raw), raw
}

// foldCodexNotification folds one codex notification (its params as raw
// JSON) into the next state plus commands.
func foldCodexNotification(previous codexProjectionState, method string, rawParams json.RawMessage) (codexProjectionState, []projectionCommand) {
	params, fields, native := notificationParams(rawParams)
	threadID, ok := params["threadId"].(string)
	if !ok {
		threadID = previous.RootThreadID
	}
	state := previous
	var inputEvents []oar.EventBody
	if threadID == previous.RootThreadID {
		// Before the views: a re-reported total is read against itself (zero).
		state.TokenBaseline = nextTokenBaseline(previous.TokenBaseline, method, params)
		state.Inputs, inputEvents = foldCodexInputs(previous.Inputs, method, params)
	}
	events := append(append([]oar.EventBody{}, inputEvents...), viewsFor(state, threadID, method, params, fields)...)
	frame := projectionCommand{Kind: "frame", Body: oar.FrameBody{Type: method, Native: native, Events: events}, SpanID: spanIDOf(params)}
	if threadID != state.RootThreadID {
		frame.SessionID = threadID
	}
	commands := []projectionCommand{frame}
	if method == "item/started" || method == "item/completed" {
		for _, edge := range collabEdges(state, threadID, jsonx.AsRecord(params["item"])) {
			commands = append(commands, projectionCommand{Kind: "link", Edge: edge})
		}
	}

	next := state
	switch {
	case method == "error":
		failure := jsonx.AsRecord(params["error"])
		var parts []string
		if message, _ := failure["message"].(string); message != "" {
			parts = append(parts, message)
		}
		if details, _ := failure["additionalDetails"].(string); details != "" {
			parts = append(parts, details)
		}
		if len(parts) > 0 {
			combined := strings.Join(parts, ": ")
			next.LastErrorDetail = &combined
		}
	case method == "turn/completed" && threadID == state.RootThreadID:
		next.LastErrorDetail = nil
	case threadID == state.RootThreadID && isCompactionItem(params) && (method == "item/started" || method == "item/completed"):
		next.Compacting = method == "item/started"
	case method == "thread/compacted" && threadID == state.RootThreadID:
		next.Compacting = false
	}
	next.Subagents = withStartedChild(next.Subagents, threadID, jsonx.AsRecord(params["item"]))
	return next, commands
}
